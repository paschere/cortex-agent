import {
  collectCheckResults,
  discoverCheckPlan,
  isSuiteFinished,
  resetCheckResults,
  startCheckSuite,
} from '@/lib/dev-tasks/check-runner';
import { applyCheckResults, runTurn } from '@/lib/dev-tasks/coder';
import {
  type DevTaskQueuedEvent,
  type DevTaskStatusEvent,
  EVENT_TASK_QUEUED,
  EVENT_TASK_STATUS,
} from '@/lib/dev-tasks/contract';
import { parseRepoUrl, resolveRepoToken } from '@/lib/dev-tasks/github-token';
import { openPullRequest } from '@/lib/dev-tasks/pull-request';
import {
  attachSandbox,
  commitAll,
  createRunSandbox,
  hasChanges,
  pushBranch,
  stopSandbox,
} from '@/lib/dev-tasks/sandbox';
import { inngest } from '@/lib/inngest';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type CheckOutcome,
  type CheckPlan,
  type ClaimDbClient,
  type DevRepository,
  type DevRunBudget,
  type DevRunSpend,
  type DevTask,
  addTurn,
  allChecksPassed,
  budgetFromEnv,
  buildBranchName,
  buildPullRequestBody,
  buildPullRequestTitle,
  checkBudget,
  claimDevTask,
  emptySpend,
  formatCheckSummary,
  sandboxTimeoutMs,
  totalTokens,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * THE EXECUTION ENGINE: a queued dev task becomes a branch and a pull request.
 *
 * ## Why Inngest orchestrates and Vercel Sandbox executes
 *
 * A Vercel function cannot clone a repo, install dependencies and run a build,
 * so the work happens in a Sandbox microVM. But the sandbox does not solve the
 * orchestrator's own problem: a serverless invocation cannot stay open for the
 * length of a coding run. Inngest and Vercel Workflow both run their steps as
 * ordinary function invocations, so neither can hold a 30-minute call inside
 * one step — the run has to be SLICED either way.
 *
 * That is the shape of this function. Everything slow is made resumable:
 *   - the sandbox outlives each invocation and is re-attached by name;
 *   - the model transcript lives in the sandbox filesystem, not in step output;
 *   - the check suite runs detached and is polled across `step.sleep` steps.
 *
 * With both candidates needing the same slicing, Inngest wins on already being
 * deployed here, on `dev/task.queued` already being specified as an Inngest
 * event, and on `concurrency: { key }` giving single-flight per task in FRONT
 * of the database claim guard.
 *
 * ## Contract (see @/lib/dev-tasks/contract)
 *
 * Consumes `dev/task.queued`. Reports every state change with
 * `dev/task.status`, which is the only thing that writes task state and posts
 * to Linear — so this function needs no Linear credentials.
 *
 * The ONE exception is the claim below. A claim guard cannot be built out of a
 * fire-and-forget event; it needs a synchronous conditional UPDATE, or two
 * workers can both believe they won.
 */

/** How long a poll cycle waits before asking the sandbox again. */
const POLL_INTERVAL = '20s';
/** Bounded so a wedged suite fails the run rather than polling forever. */
const MAX_POLLS = 60;

type StepApi = Parameters<Parameters<typeof inngest.createFunction>[2]>[0]['step'];

interface RunContext {
  task: DevTask;
  repository: DevRepository;
  branch: string;
  attempt: number;
}

/** What a finished run wants said about it. Turned into a status event below. */
interface RunReport {
  status: 'needs_review' | 'failed';
  summary: string;
  branchName: string | null;
  prUrl: string | null;
  error: string | null;
}

export const devTaskRun = inngest.createFunction(
  {
    id: 'dev-task-run',
    // Layer one of the claim guard: Inngest will not start a second run for the
    // same task. Layer two is the conditional UPDATE in `claimDevTask`, which
    // also covers a manually re-sent event or a second deployment.
    concurrency: [
      { key: 'event.data.taskId', limit: 1 },
      // Sandboxes are expensive; a burst of Linear assignments must not become
      // a burst of microVMs.
      { limit: 3 },
    ],
    // No automatic retries. A retry would re-enter a run whose sandbox and
    // branch already exist; requeueing is the database's job, bounded by
    // `dev_tasks.max_attempts` and enforced in `claimDevTask`.
    retries: 0,
  },
  { event: EVENT_TASK_QUEUED },
  async ({ event, step }) => {
    const queued = event.data as unknown as DevTaskQueuedEvent;
    const taskId = queued?.taskId;
    if (!taskId) return { skipped: 'event carried no taskId' };
    // Put on the event by the intake, off the repository row it resolved. Every
    // database handle in this function is pinned to it, so a task id from
    // another workspace simply finds nothing to claim.
    const organizationId = queued.repository?.organizationId;
    if (!organizationId) return { skipped: 'event carried no workspace' };

    const budget = budgetFromEnv(process.env);
    // Captured inside a step so replays see the same instant; a bare Date.now()
    // out here would make the wall-clock budget non-deterministic.
    const startedAtMs = await step.run('started-at', async () => Date.now());

    const claim = await step.run('claim', async () => {
      const db = getOrgScopedClient(organizationId) as unknown as ClaimDbClient;
      return claimDevTask(db, taskId);
    });

    if (!claim.claimed) {
      if (claim.reason === 'attempts_exhausted') {
        await report(step, 'exhausted', {
          taskId,
          status: 'failed',
          error:
            'Every permitted attempt for this task has been used. Have a look at why the ' +
            'earlier runs failed before assigning it to me again.',
        });
      }
      logger.info(`dev-task-run: ${taskId} not claimable (${claim.reason})`);
      return { skipped: claim.reason };
    }

    const task = claim.task;
    const branch = buildBranchName(task.external_identifier, task.title);

    // The allowlist is re-read from the database rather than trusted from the
    // event: the event is a message that could be stale or replayed, while
    // dev_repositories is the authority on what Cortex may touch right now.
    const repository = await step.run('verify-allowlist', async () =>
      verifyRepository(organizationId, task),
    );
    if ('error' in repository) {
      await report(step, 'rejected', {
        taskId,
        status: 'failed',
        attempt: task.attempt_count,
        error: repository.error,
      });
      return { failed: repository.error };
    }

    await report(step, 'running', {
      taskId,
      status: 'running',
      branchName: branch,
      attempt: task.attempt_count,
    });

    const ctx: RunContext = { task, repository, branch, attempt: task.attempt_count };

    try {
      const outcome = await execute(step, ctx, budget, startedAtMs);
      await report(step, 'outcome', {
        taskId,
        status: outcome.status,
        attempt: ctx.attempt,
        branchName: outcome.branchName ?? undefined,
        prUrl: outcome.prUrl ?? undefined,
        summary: outcome.summary || undefined,
        error: outcome.error ?? undefined,
      });
      return { status: outcome.status, prUrl: outcome.prUrl };
    } catch (err) {
      const message = (err as Error).message.slice(0, 4000);
      logger.error(`dev-task-run: ${task.external_identifier} failed — ${message}`);
      await report(step, 'crash', {
        taskId,
        status: 'failed',
        attempt: ctx.attempt,
        branchName: branch,
        error: message,
      });
      return { status: 'failed', error: message };
    } finally {
      // The VM is the most expensive thing this run holds. Stop it on every
      // path, including the ones that threw.
      await step.run('stop-sandbox', async () => {
        await stopSandbox(taskId);
        return { stopped: true };
      });
    }
  },
);

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function execute(
  step: StepApi,
  ctx: RunContext,
  budget: DevRunBudget,
  startedAtMs: number,
): Promise<RunReport> {
  const { task, repository, branch } = ctx;
  const repoRef = parseRepoUrl(repository.clone_url);

  await step.run('create-sandbox', async () => {
    // The token is minted inside the step and never returned from it. A step's
    // return value is persisted by Inngest, and a GitHub credential has no
    // business living in an orchestration log.
    const { token } = await resolveRepoToken(repoRef);
    return createRunSandbox({
      taskId: task.id,
      cloneUrl: repository.clone_url,
      defaultBranch: repository.default_branch,
      branch,
      timeoutMs: sandboxTimeoutMs(budget),
      token,
    });
  });

  const checkPlan = await step.run('discover-checks', async () =>
    discoverCheckPlan(await attachSandbox(task.id)),
  );

  let spend = emptySpend(startedAtMs);
  let lastChecks: CheckOutcome[] = [];

  for (let turn = 0; turn < budget.maxIterations; turn += 1) {
    const now = await step.run(`clock-${turn}`, async () => Date.now());
    const exhausted = checkBudget(spend, budget, now);
    if (exhausted) {
      return {
        status: 'failed',
        summary: '',
        branchName: branch,
        prUrl: null,
        error: exhausted.message,
      };
    }

    const result = await step.run(`turn-${turn}`, async () =>
      runTurn({
        sandbox: await attachSandbox(task.id),
        task,
        repository,
        checkPlan,
      }),
    );
    spend = addTurn(spend, result.usage);

    if (result.outcome.kind === 'finished') {
      return conclude({
        step,
        ctx,
        repoRef,
        declared: result.outcome.outcome,
        summary: result.outcome.summary,
        checks: lastChecks,
        checkPlan,
        spend,
        startedAtMs,
      });
    }

    if (result.outcome.kind === 'checks_requested') {
      lastChecks = await runCheckSuite(step, task.id, checkPlan, turn);
      await step.run(`checks-${turn}-apply`, async () =>
        applyCheckResults(await attachSandbox(task.id), lastChecks),
      );
    }
  }

  return {
    status: 'failed',
    summary: '',
    branchName: branch,
    prUrl: null,
    error: [
      `I stopped after ${budget.maxIterations} model turns without reaching a conclusion,`,
      'so no pull request was opened.',
    ].join(' '),
  };
}

/**
 * Drive the detached check suite across steps: launch it, then poll with
 * `step.sleep` between attempts, so no single invocation has to sit through a
 * quarter-hour build.
 */
async function runCheckSuite(
  step: StepApi,
  taskId: string,
  plan: CheckPlan,
  turn: number,
): Promise<CheckOutcome[]> {
  if (!plan.isConclusive) {
    return [
      {
        id: 'none',
        label: 'verification',
        passed: false,
        exitCode: -1,
        output:
          'This repository declares no typecheck, lint, test or build script, so there is ' +
          'nothing to verify against. Treat the change as unverified.',
      },
    ];
  }

  const { cmdId } = await step.run(`checks-${turn}-start`, async () => {
    const sandbox = await attachSandbox(taskId);
    await resetCheckResults(sandbox);
    return startCheckSuite(sandbox, plan);
  });

  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    const finished = await step.run(`checks-${turn}-poll-${poll}`, async () =>
      isSuiteFinished(await attachSandbox(taskId), cmdId),
    );
    if (finished) {
      return step.run(`checks-${turn}-collect`, async () =>
        collectCheckResults(await attachSandbox(taskId), plan),
      );
    }
    await step.sleep(`checks-${turn}-wait-${poll}`, POLL_INTERVAL);
  }

  return [
    {
      id: 'timeout',
      label: 'verification',
      passed: false,
      exitCode: -1,
      output: 'The check suite did not finish within its time budget and was abandoned.',
    },
  ];
}

/**
 * Turn the model's declared outcome into a pull request, a question, or an
 * honest refusal. Nothing here trusts the declaration on its own: a claim of
 * success is re-derived from the check results and the worktree.
 */
async function conclude(params: {
  step: StepApi;
  ctx: RunContext;
  repoRef: ReturnType<typeof parseRepoUrl>;
  declared: 'complete' | 'needs_input' | 'blocked';
  summary: string;
  checks: CheckOutcome[];
  checkPlan: CheckPlan;
  spend: DevRunSpend;
  startedAtMs: number;
}): Promise<RunReport> {
  const { step, ctx, repoRef, declared, summary, checks, checkPlan, spend, startedAtMs } = params;
  const { task, repository, branch } = ctx;

  if (declared === 'needs_input') {
    // The correct outcome for an ambiguous task is a question, not a guess.
    // `failed` is the contract's terminal "back in your hands" state; the
    // summary carries the actual question, which dev-task-status posts to the
    // Linear issue.
    return {
      status: 'failed',
      summary: `**I need a decision before I can build this.**\n\n${summary}`,
      branchName: null,
      prUrl: null,
      error: 'The issue was ambiguous, so I stopped and asked rather than guessing.',
    };
  }

  if (declared === 'blocked') {
    return {
      status: 'failed',
      summary,
      branchName: branch,
      prUrl: null,
      error: 'I could not finish this task — see the summary for what I tried.',
    };
  }

  // From here the model claims to be done. Verify the claim.
  if (!checkPlan.isConclusive) {
    return {
      status: 'failed',
      summary,
      branchName: branch,
      prUrl: null,
      error:
        'I finished the change, but this repository declares no checks that could verify it, ' +
        'so I did not open a pull request. Add a typecheck/test/build script, or review my ' +
        'summary and do it by hand.',
    };
  }

  if (!allChecksPassed(checks)) {
    return {
      status: 'failed',
      summary,
      branchName: branch,
      prUrl: null,
      error: [
        'I could not get the checks passing, so I did not open a pull request.',
        formatCheckSummary(checks),
      ].join('\n\n'),
    };
  }

  const changed = await step.run('inspect-worktree', async () =>
    hasChanges(await attachSandbox(task.id)),
  );
  if (!changed) {
    return {
      status: 'failed',
      summary,
      branchName: branch,
      prUrl: null,
      error: 'I reported the work as done but changed no files, so there was nothing to open.',
    };
  }

  // The allowlist grants "Cortex may work here" and "Cortex may open pull
  // requests here" separately. Without the second grant the work is reported
  // and the branch is never pushed — the allowlist decides, not the issue.
  if (!repository.allow_pull_requests) {
    return {
      status: 'needs_review',
      summary: [
        [
          `**No pull request:** \`${repository.key}\` is registered for exploration only`,
          '(`allow_pull_requests` is off), so I made and verified the change but did not',
          'push it.',
        ].join(' '),
        summary,
        formatCheckSummary(checks),
      ].join('\n\n'),
      branchName: null,
      prUrl: null,
      error: null,
    };
  }

  await step.run('commit', async () => {
    await commitAll(
      await attachSandbox(task.id),
      `${task.external_identifier}: ${task.title}\n\nOpened by Cortex for task ${task.id}.`,
    );
    return { committed: true };
  });

  await step.run('push', async () => {
    const { token } = await resolveRepoToken(repoRef);
    await pushBranch(await attachSandbox(task.id), {
      branch,
      defaultBranch: repository.default_branch,
      cloneUrl: repository.clone_url,
      token,
    });
    return { pushed: true };
  });

  const finishedAtMs = await step.run('finished-at', async () => Date.now());

  const pr = await step.run('open-pull-request', async () => {
    const { token } = await resolveRepoToken(repoRef);
    return openPullRequest({
      repo: repoRef,
      token,
      head: branch,
      base: repository.default_branch,
      title: buildPullRequestTitle(task),
      body: buildPullRequestBody({
        task,
        summary,
        checkSummary: formatCheckSummary(checks),
        iterations: spend.iterations,
        tokens: totalTokens(spend),
        durationMs: finishedAtMs - startedAtMs,
      }),
    });
  });

  return {
    status: 'needs_review',
    summary,
    branchName: branch,
    prUrl: pr.url,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/** Emit a status event. The only channel through which task state changes. */
async function report(step: StepApi, id: string, data: DevTaskStatusEvent): Promise<void> {
  await step.sendEvent(`status-${id}`, { name: EVENT_TASK_STATUS, data });
}

/**
 * Re-check the allowlist at run time.
 *
 * Intake already resolved a repo, but this is the moment before a token is
 * minted and a VM is started, and it is the last chance to notice that the repo
 * was deactivated in between.
 */
async function verifyRepository(
  organizationId: string,
  task: DevTask,
): Promise<DevRepository | { error: string }> {
  const db = getOrgScopedClient(organizationId);
  const { data, error } = await db
    .from('dev_repositories')
    .select('id, key, name, clone_url, default_branch, allow_pull_requests, is_active')
    .eq('id', task.repository_id)
    .maybeSingle();

  if (error) return { error: `I could not read the repository allowlist: ${error.message}` };

  const repo = data as DevRepository | null;
  if (!repo) return { error: `Repository ${task.repository_id} is not in the allowlist.` };
  if (!repo.is_active) {
    return { error: `Repository "${repo.key}" is registered but no longer active.` };
  }
  return repo;
}
