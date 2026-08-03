import 'server-only';
import type { Sandbox } from '@vercel/sandbox';
import { type CheckOutcome, type CheckPlan, buildCheckPlan } from '@cortex/agent-tools';
import { REPO_ROOT, run, truncateOutput } from './sandbox';

/**
 * Running the repository's own checks.
 *
 * `pnpm install && turbo build && turbo test` routinely takes longer than a
 * serverless invocation is allowed to live, so the whole suite is packaged into
 * one shell script, launched DETACHED, and polled from later Inngest steps.
 * Each step writes its exit code and log to a file, which sidesteps quoting a
 * JSON document out of bash and lets the orchestrator read per-step results
 * once the job finishes.
 *
 * The suite is discovered from the target repo, never assumed — see
 * `buildCheckPlan`. A repo that declares no checks yields an inconclusive plan,
 * and an inconclusive plan can never be reported as "verified".
 */

const STATE_DIR = `${REPO_ROOT}/.cortex`;
const RESULT_DIR = `${STATE_DIR}/checks`;
const SCRIPT_PATH = `${STATE_DIR}/run-checks.sh`;

/** Single-quote for `sh`, the only form that needs no other escaping rules. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** Read the target repo's manifest and lockfiles to decide what to run. */
export async function discoverCheckPlan(sandbox: Sandbox): Promise<CheckPlan> {
  const manifest = await sandbox.readFileToBuffer({ path: `${REPO_ROOT}/package.json` });
  let packageJson: { scripts?: Record<string, string>; packageManager?: string } | null = null;
  if (manifest) {
    try {
      packageJson = JSON.parse(manifest.toString('utf8')) as typeof packageJson;
    } catch {
      packageJson = null;
    }
  }

  const [pnpmLock, yarnLock] = await Promise.all([
    sandbox.readFileToBuffer({ path: `${REPO_ROOT}/pnpm-lock.yaml` }),
    sandbox.readFileToBuffer({ path: `${REPO_ROOT}/yarn.lock` }),
  ]);

  return buildCheckPlan({
    packageJson,
    hasPnpmLock: pnpmLock !== null,
    hasYarnLock: yarnLock !== null,
  });
}

function buildScript(plan: CheckPlan): string {
  const lines = [
    '#!/usr/bin/env bash',
    '# Generated per run by apps/web/lib/dev-tasks/check-runner.ts.',
    'set +e',
    `OUT=${shellQuote(RESULT_DIR)}`,
    'rm -rf "$OUT"; mkdir -p "$OUT"',
    `cd ${shellQuote(REPO_ROOT)} || exit 1`,
    '',
    'step() {',
    '  id="$1"; shift',
    '  "$@" > "$OUT/$id.log" 2>&1',
    '  echo $? > "$OUT/$id.code"',
    '}',
    '',
    `step install ${[plan.install.cmd, ...plan.install.args].map(shellQuote).join(' ')}`,
    // A failed install makes every later result meaningless, so stop there
    // rather than reporting a cascade of misleading failures.
    'if [ "$(cat "$OUT/install.code")" != "0" ]; then echo done > "$OUT/.finished"; exit 0; fi',
    '',
  ];

  for (const step of plan.steps) {
    // Every check runs even after one fails: the model can then fix a
    // typecheck error and a test failure in the same turn instead of
    // discovering them one slow round at a time.
    lines.push(`step ${shellQuote(step.id)} ${[step.cmd, ...step.args].map(shellQuote).join(' ')}`);
  }

  lines.push('', 'echo done > "$OUT/.finished"', 'exit 0', '');
  return lines.join('\n');
}

/** Total ceiling for one suite run, derived from the plan's own step budgets. */
export function suiteTimeoutMs(plan: CheckPlan): number {
  return plan.install.timeoutMs + plan.steps.reduce((total, s) => total + s.timeoutMs, 0);
}

export async function startCheckSuite(
  sandbox: Sandbox,
  plan: CheckPlan,
): Promise<{ cmdId: string }> {
  await sandbox.mkDir(STATE_DIR);
  await sandbox.writeFiles([{ path: SCRIPT_PATH, content: buildScript(plan), mode: 0o755 }]);
  const command = await sandbox.runCommand({
    cmd: 'bash',
    args: [SCRIPT_PATH],
    cwd: REPO_ROOT,
    timeoutMs: suiteTimeoutMs(plan),
    detached: true,
  });
  return { cmdId: command.cmdId };
}

export async function isSuiteFinished(sandbox: Sandbox, cmdId: string): Promise<boolean> {
  const command = await sandbox.getCommand(cmdId);
  if (command.exitCode !== null) return true;
  // Belt and braces: if the process was reaped without us seeing the exit code,
  // the sentinel file still tells us the script ran to completion.
  const sentinel = await sandbox.readFileToBuffer({ path: `${RESULT_DIR}/.finished` });
  return sentinel !== null;
}

/**
 * Collect per-step results. A step with no `.code` file never ran — because an
 * earlier step aborted the script — and is reported as failed rather than
 * silently omitted, so `allChecksPassed` cannot be satisfied by absence.
 */
export async function collectCheckResults(
  sandbox: Sandbox,
  plan: CheckPlan,
): Promise<CheckOutcome[]> {
  const steps = [plan.install, ...plan.steps];
  const outcomes: CheckOutcome[] = [];

  for (const step of steps) {
    const [codeBuffer, logBuffer] = await Promise.all([
      sandbox.readFileToBuffer({ path: `${RESULT_DIR}/${step.id}.code` }),
      sandbox.readFileToBuffer({ path: `${RESULT_DIR}/${step.id}.log` }),
    ]);

    if (!codeBuffer) {
      outcomes.push({
        id: step.id,
        label: step.label,
        passed: false,
        exitCode: -1,
        output: 'This check did not run, because an earlier check failed.',
      });
      continue;
    }

    const exitCode = Number.parseInt(codeBuffer.toString('utf8').trim(), 10);
    outcomes.push({
      id: step.id,
      label: step.label,
      passed: exitCode === 0,
      exitCode: Number.isFinite(exitCode) ? exitCode : -1,
      // Failures need the tail (where the error is); a pass needs almost
      // nothing, so do not spend context on thousands of green lines.
      output:
        exitCode === 0
          ? 'Passed.'
          : truncateOutput((logBuffer?.toString('utf8') ?? '').trim() || '(no output)'),
    });
  }

  return outcomes;
}

/** Clear results between rounds so a stale pass cannot be read as a fresh one. */
export async function resetCheckResults(sandbox: Sandbox): Promise<void> {
  await run(sandbox, { cmd: 'rm', args: ['-rf', RESULT_DIR] });
}
