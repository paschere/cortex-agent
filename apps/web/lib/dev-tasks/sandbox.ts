import "server-only";
import { Sandbox } from "@vercel/sandbox";
import { type CheckStep, assertPushable } from "@cortex/agent-tools";
import { logger } from "@cortex/core";
import { type RepoRef, redact } from "./github-token";

/**
 * The sandbox is both the executor and the run's durable state.
 *
 * A Vercel function cannot clone, install, build and iterate — so the work
 * happens in a Firecracker microVM. But the orchestrator also cannot hold a
 * 30-minute call open inside one invocation, so the sandbox has a second job:
 * it OUTLIVES the invocation that created it. Every later step re-attaches with
 * `Sandbox.get({ name })` using a name derived from the task id, and reads the
 * run's transcript back off the sandbox filesystem. That is why the transcript
 * lives at `.cortex/transcript.json` in the VM rather than in step output — it
 * keeps the durable state next to the checkout it describes, and keeps
 * megabytes of conversation out of the orchestrator's step payloads.
 */

/**
 * Where the repository is checked out inside the VM. This is the sandbox's
 * own default working directory, which is exactly where a `source: git` clone
 * lands — so there is no copying or relocating to get wrong.
 */
export const REPO_ROOT = "/vercel/sandbox";
/** Run state the model is not allowed to touch (see `resolveRepoPath`). */
const STATE_DIR = `${REPO_ROOT}/.cortex`;
const TRANSCRIPT_PATH = `${STATE_DIR}/transcript.json`;

/** Cap on any single blob of command output we feed back to the model. */
const MAX_OUTPUT_CHARS = 20_000;

export function sandboxNameForTask(taskId: string): string {
  // Deterministic, so a replayed Inngest step re-attaches instead of leaking a
  // second VM. Sandbox names are per-project, and task ids are uuids.
  return `cortex-dev-${taskId}`;
}

export function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const head = text.slice(0, 4_000);
  const tail = text.slice(-(MAX_OUTPUT_CHARS - 4_000));
  return `${head}\n\n… [${text.length - MAX_OUTPUT_CHARS} characters elided] …\n\n${tail}`;
}

export interface StartedSandbox {
  name: string;
  /** True when the clone landed and the branch was created. */
  ready: boolean;
}

/**
 * Create the VM with the repository already cloned at its default branch.
 *
 * The ONLY secret that goes in is the repo-scoped GitHub token, and it goes in
 * as the clone credential rather than as an environment variable, so it is not
 * sitting in the shell environment of every command the model runs. Nothing
 * else is passed: no Supabase service key, no Workable/Apollo key, no Google
 * credential, and — importantly — not the Anthropic key either. The model runs
 * in the orchestrator, not in the sandbox; the sandbox only executes its tool
 * calls.
 */
export async function createRunSandbox(params: {
  taskId: string;
  cloneUrl: string;
  defaultBranch: string;
  branch: string;
  timeoutMs: number;
  token: string;
}): Promise<StartedSandbox> {
  const name = sandboxNameForTask(params.taskId);

  const sandbox = await Sandbox.create({
    name,
    runtime: "node24",
    timeout: params.timeoutMs,
    resources: { vcpus: 4 },
    // Persistent, because the run is sliced across invocations: if the VM is
    // stopped between two Inngest steps, the filesystem — checkout, transcript,
    // check output — has to come back. The default 30-day snapshot retention is
    // far too long for a copy of a private repo, so keep one snapshot for a day,
    // which is enough to post-mortem a failed run.
    persistent: true,
    snapshotExpiration: 24 * 60 * 60 * 1000,
    keepLastSnapshots: { count: 1 },
    tags: { purpose: "dev-task", task: params.taskId.slice(0, 32) },
    source: {
      type: "git",
      url: params.cloneUrl,
      username: "x-access-token",
      password: params.token,
      revision: params.defaultBranch,
      // Enough history for a readable `git log` while keeping startup quick.
      depth: 50,
    },
  });

  // Fail loudly here rather than letting the model wander an empty directory
  // and report a mysterious inability to find anything.
  const cloned = await run(sandbox, {
    cmd: "git",
    args: ["rev-parse", "--is-inside-work-tree"],
    cwd: REPO_ROOT,
  });
  if (cloned.exitCode !== 0) {
    throw new Error(
      `The repository did not clone into the sandbox: ${cloned.output}`,
    );
  }

  await configureGit(sandbox, params.branch, params.defaultBranch);
  await sandbox.mkDir(STATE_DIR);
  // Keep run state out of every diff and out of `git status`, without touching
  // the repository's own .gitignore. Appended, not written: .git/info/exclude
  // is a real file with existing content in most repos.
  await run(sandbox, {
    cmd: "bash",
    args: ["-lc", `printf '\\n.cortex/\\n' >> ${REPO_ROOT}/.git/info/exclude`],
    cwd: REPO_ROOT,
  });

  return { name, ready: true };
}

async function configureGit(
  sandbox: Sandbox,
  branch: string,
  defaultBranch: string,
): Promise<void> {
  // assertPushable runs here too, not only at push time: a branch that could
  // never be pushed should never be created either.
  assertPushable({ branch, defaultBranch });

  await run(sandbox, {
    cmd: "git",
    args: ["config", "user.name", "Cortex"],
    cwd: REPO_ROOT,
  });
  await run(sandbox, {
    cmd: "git",
    args: ["config", "user.email", "cortex@example.com"],
    cwd: REPO_ROOT,
  });
  const created = await run(sandbox, {
    cmd: "git",
    args: ["checkout", "-b", branch],
    cwd: REPO_ROOT,
  });
  if (created.exitCode !== 0) {
    throw new Error(`Failed to create branch ${branch}: ${created.output}`);
  }
}

export async function attachSandbox(taskId: string): Promise<Sandbox> {
  return Sandbox.get({ name: sandboxNameForTask(taskId) });
}

export interface RunResult {
  exitCode: number;
  output: string;
}

/** Run a bounded command and collect its combined output. */
export async function run(
  sandbox: Sandbox,
  params: { cmd: string; args?: string[]; cwd?: string; timeoutMs?: number },
): Promise<RunResult> {
  const finished = await sandbox.runCommand({
    cmd: params.cmd,
    args: params.args ?? [],
    cwd: params.cwd,
    timeoutMs: params.timeoutMs ?? 120_000,
  });
  const [stdout, stderr] = await Promise.all([
    finished.stdout(),
    finished.stderr(),
  ]);
  return {
    exitCode: finished.exitCode,
    output: truncateOutput([stdout, stderr].filter(Boolean).join("\n").trim()),
  };
}

/**
 * Start a long command without waiting for it.
 *
 * `pnpm install && turbo build` routinely outlasts a serverless invocation, so
 * the check suite is launched detached and its `cmdId` handed back to the
 * orchestrator. A later Inngest step re-attaches and polls. This is what makes
 * a 15-minute build survive a function that must return in under five.
 */
export async function startDetached(
  sandbox: Sandbox,
  step: CheckStep,
): Promise<{ cmdId: string }> {
  const command = await sandbox.runCommand({
    cmd: step.cmd,
    args: step.args,
    cwd: REPO_ROOT,
    timeoutMs: step.timeoutMs,
    detached: true,
  });
  return { cmdId: command.cmdId };
}

export type PollResult =
  | { finished: false }
  | { finished: true; exitCode: number; output: string };

export async function pollDetached(
  sandbox: Sandbox,
  cmdId: string,
): Promise<PollResult> {
  const command = await sandbox.getCommand(cmdId);
  if (command.exitCode === null) return { finished: false };
  const [stdout, stderr] = await Promise.all([
    command.stdout(),
    command.stderr(),
  ]);
  return {
    finished: true,
    exitCode: command.exitCode,
    output: truncateOutput([stdout, stderr].filter(Boolean).join("\n").trim()),
  };
}

/** True when the checkout has changes worth committing. */
export async function hasChanges(sandbox: Sandbox): Promise<boolean> {
  const status = await run(sandbox, {
    cmd: "git",
    args: ["status", "--porcelain"],
    cwd: REPO_ROOT,
  });
  return status.output.trim().length > 0;
}

export async function commitAll(
  sandbox: Sandbox,
  message: string,
): Promise<void> {
  const added = await run(sandbox, {
    cmd: "git",
    args: ["add", "-A"],
    cwd: REPO_ROOT,
  });
  if (added.exitCode !== 0) throw new Error(`git add failed: ${added.output}`);
  const committed = await run(sandbox, {
    cmd: "git",
    args: ["commit", "-m", message],
    cwd: REPO_ROOT,
  });
  if (committed.exitCode !== 0)
    throw new Error(`git commit failed: ${committed.output}`);
}

/**
 * Push the branch.
 *
 * The argv comes from `assertPushable` and nowhere else, so the protected
 * branch check and the absence of `--force` are structural rather than a
 * convention this function is trusted to follow.
 */
export async function pushBranch(
  sandbox: Sandbox,
  params: {
    branch: string;
    defaultBranch: string;
    cloneUrl: string;
    token: string;
  },
): Promise<void> {
  const argv = assertPushable({
    branch: params.branch,
    defaultBranch: params.defaultBranch,
  });

  // The credential has to be on the remote URL for this one command, which
  // means it is briefly written into .git/config. The try/finally is the point:
  // if the push throws, the token must still be scrubbed, or it would survive
  // in the checkout — and in the snapshot taken when the sandbox stops.
  const authenticated = params.cloneUrl.replace(
    "https://",
    `https://x-access-token:${params.token}@`,
  );
  const setUrl = await run(sandbox, {
    cmd: "git",
    args: ["remote", "set-url", "origin", authenticated],
    cwd: REPO_ROOT,
  });
  if (setUrl.exitCode !== 0)
    throw new Error(`git remote set-url failed: ${setUrl.output}`);

  try {
    const pushed = await run(sandbox, {
      cmd: "git",
      args: argv,
      cwd: REPO_ROOT,
      timeoutMs: 180_000,
    });
    if (pushed.exitCode !== 0) {
      // Scrub before the message can reach a log line, a task row or Linear.
      throw new Error(
        `git push failed: ${redact(pushed.output, params.token)}`,
      );
    }
  } finally {
    await run(sandbox, {
      cmd: "git",
      args: ["remote", "set-url", "origin", params.cloneUrl],
      cwd: REPO_ROOT,
    });
  }
}

export async function readTranscript(
  sandbox: Sandbox,
): Promise<unknown[] | null> {
  const buffer = await sandbox.readFileToBuffer({ path: TRANSCRIPT_PATH });
  if (!buffer) return null;
  try {
    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeTranscript(
  sandbox: Sandbox,
  messages: unknown[],
): Promise<void> {
  await sandbox.writeFiles([
    { path: TRANSCRIPT_PATH, content: JSON.stringify(messages) },
  ]);
}

/** Best effort: a stop that fails must never mask the run's real outcome. */
export async function stopSandbox(
  taskId: string,
  repo?: RepoRef,
): Promise<void> {
  try {
    const sandbox = await Sandbox.get({
      name: sandboxNameForTask(taskId),
      resume: false,
    });
    await sandbox.stop();
  } catch (err) {
    logger.warn("dev-task: failed to stop sandbox", {
      taskId,
      repo: repo ? `${repo.owner}/${repo.repo}` : undefined,
      error: (err as Error).message,
    });
  }
}
