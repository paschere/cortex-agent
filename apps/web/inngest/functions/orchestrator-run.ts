import { inngest } from '@/lib/inngest';
import {
  EVENT_RUN_CANCELLED,
  EVENT_RUN_STARTED,
  type OrchestratorRunStartedEvent,
} from '@/lib/orchestrator/contract';
import {
  DEFAULT_CONCURRENCY,
  type RunOptions,
  failRun,
  planRun,
  runWave,
  synthesizeRun,
} from '@/lib/orchestrator/executor';
import { type LifecycleDb, claimRun } from '@/lib/orchestrator/lifecycle';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';

/**
 * THE EXECUTION ENGINE: an objective becomes a team of sub-agents and a report.
 *
 * ## Why this moved off `after()`
 *
 * A run used to execute inside the POST that started it, held open by Next's
 * `after()`. That gave it two endings nobody handled and both were routine:
 *
 *   - it outgrew `maxDuration = 300`. A run is a planner call, several waves of
 *     sub-agents and a synthesis; five minutes is a normal run, not a long one.
 *     Vercel cut the invocation and the row stayed `running` for ever.
 *   - somebody deployed. `after()` does not survive a redeploy — six deploys in
 *     an afternoon killed every run in flight, silently.
 *
 * In both cases the process that would have written the terminal state was the
 * process that died, so nothing wrote it. Inngest fixes the class of problem
 * rather than the symptom: a step is a separate invocation with its own budget,
 * its result is persisted, and a function whose worker vanishes is resumed on
 * another one. `after()` cannot offer that on Vercel by design.
 *
 * ## The shape
 *
 * plan → wave → wave → … → synthesise, one step each. Nothing is carried in
 * memory across a step: every phase re-reads orchestration_tasks and works out
 * what is left (see lib/orchestrator/executor.ts). That is what makes a resumed
 * run pick up mid-DAG instead of starting over.
 *
 * ## The live console is untouched, on purpose
 *
 * The browser tails `orchestration_events` over SSE
 * (app/api/orchestrator/[id]/events). The log was never fed by the HTTP
 * connection that started the run — it is a table, and the executor appends to
 * it from wherever it happens to be running. So moving execution to Inngest
 * changes nothing the console can see, except that events now keep arriving
 * after five minutes and across a deploy.
 *
 * ## Why it does not retry
 *
 * `retries: 0`, the same decision dev-task-run.ts makes and for a sharper
 * reason. A retried wave would re-enter a run whose tasks are already marked
 * `running`, and a sub-agent's work is not replayable: re-running it means
 * making its tool calls a second time, which means sending the same email or
 * filing the same ticket twice. So a crashed run is not retried — it is left in
 * the honest state it crashed in, and the sweep
 * (inngest/functions/orchestrator-sweep.ts) closes it as `interrupted`.
 * Relaunching is the person's decision, and it is one click.
 */

/**
 * A hard ceiling on waves. The planner is capped well below this, so reaching
 * it means the graph is not converging and the run should stop with something
 * printed rather than bill for ever.
 */
const MAX_WAVES = 16;

export const orchestratorRun = inngest.createFunction(
  {
    id: 'orchestrator-run',
    concurrency: [
      // Layer one of the single-flight guard: Inngest will not start a second
      // execution for the same run. Layer two is the conditional UPDATE in
      // `claimRun`, which also covers a manually re-sent event and the older
      // `after()` path still finishing during a deploy.
      { key: 'event.data.runId', limit: 1 },
      // A run is several sub-agents each holding a model connection, so a burst
      // of launches is a burst of concurrent LLM traffic. Five is also the
      // plan's per-function ceiling — Inngest rejects the ENTIRE app at sync
      // time if any function asks for more, which silently unregisters every
      // background job. Do not raise this.
      { limit: 5 },
    ],
    retries: 0,
    // Cancellation was cooperative and stayed cooperative — the executor still
    // re-reads the row between phases — but this makes it land at the next step
    // boundary instead of only at the next wave, which on a run whose current
    // wave has ten minutes left is the difference between "stopping" and
    // "stopped". The row remains the authority; this only makes it bite sooner.
    cancelOn: [{ event: EVENT_RUN_CANCELLED, if: 'async.data.runId == event.data.runId' }],
  },
  { event: EVENT_RUN_STARTED },
  async ({ event, step }) => {
    const started = event.data as unknown as OrchestratorRunStartedEvent;
    const runId = started?.runId;
    if (!runId) return { skipped: 'event carried no runId' };
    // Put on the event by the route, off the session it had in hand. Every
    // database handle in this function is pinned to it, so a run id from
    // another workspace simply finds nothing to claim, and no step ever needs a
    // session — there isn't one out here.
    const organizationId = started.organizationId;
    const userId = started.userId;
    if (!organizationId || !userId) return { skipped: 'event carried no workspace or person' };

    const opts: RunOptions = {
      runId,
      organizationId,
      userId,
      objective: started.objective ?? '',
      concurrency: started.concurrency ?? DEFAULT_CONCURRENCY,
    };

    // Layer two of the single-flight guard, and the one that also refuses a run
    // a person cancelled between the send and the pick-up.
    const claim = await step.run('claim', async () =>
      claimRun(getOrgScopedClient(organizationId) as unknown as LifecycleDb, runId),
    );
    if (!claim.claimed) {
      logger.info(`orchestrator-run: ${runId} not claimable (${claim.reason})`);
      return { skipped: claim.reason };
    }

    try {
      const plan = await step.run('plan', async () => planRun(opts));
      if (plan.stopped) return { stopped: 'before planning' };

      for (let wave = 0; wave < MAX_WAVES; wave += 1) {
        const outcome = await step.run(`wave-${wave}`, async () => runWave(opts));
        if (outcome.stopped) return { stopped: `during wave ${wave}` };
        // Nothing ran and nothing is waiting: the graph is walked.
        if (outcome.remaining === 0) break;
        if (outcome.executed === 0 && outcome.skipped === 0) {
          // Tasks are pending but none became ready — a shape the normalised
          // DAG should make impossible. Stop rather than spin.
          logger.error(`orchestrator-run: ${runId} stalled with ${outcome.remaining} pending`);
          break;
        }
      }

      const finished = await step.run('synthesize', async () => synthesizeRun(opts));
      return { status: finished.status, totalTokens: finished.totalTokens };
    } catch (err) {
      const message = (err as Error).message;
      // Outside a step on purpose: the ending has to be written even when a step
      // is what failed, and this call is idempotent against somebody having
      // ended the run already.
      await failRun({ runId, organizationId }, message);
      return { status: 'failed', error: message.slice(0, 500) };
    }
  },
);
