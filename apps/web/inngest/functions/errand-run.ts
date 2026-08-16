import { EVENT_ERRAND_ADVANCE, type ErrandAdvanceEvent } from '@/lib/errands/contract';
import { advanceErrand } from '@/lib/errands/worker';
import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { logger } from '@cortex/core';

/**
 * THE ERRAND WORKER: one transition, then get out of the way.
 *
 * ## What this function is not
 *
 * It is not the thing that does the work. The orchestrator does that
 * (inngest/functions/orchestrator-run.ts): plans a team of sub-agents, walks
 * the DAG, writes a report, survives a redeploy. This function is the layer
 * above it — the one that decides WHETHER to commission another run, what to
 * put in its objective, whether what came back is an answer or a question, and
 * when to stop spending.
 *
 * ## Why it does one transition and re-sends itself
 *
 * An errand can last days: a monitor looks once a week, a blocked errand waits
 * for somebody to come back from lunch. Nothing can hold that open, so nothing
 * tries. Each invocation reads the rows, moves the machine one step
 * (lib/errands/engine.ts `decideNext`), and either sends itself another
 * `errand/advance` or stops entirely. Between two steps there is no process,
 * no memory and no assumption — only rows.
 *
 * That is what "survives a restart" means here, and it is stronger than the
 * orchestrator's version: the orchestrator survives inside one durable
 * function, an errand survives with no function running at all.
 *
 * ## What restarts it when nothing is running
 *
 * Three things, and every one of them sends the same content-free event:
 *   - this function, when another step is immediately available;
 *   - a person answering a question (app/api/errands/[id]/answer);
 *   - the sweep (errand-sweep.ts), which is the backstop for all the cases
 *     nobody thought of — a leg that finished while no worker was watching, a
 *     monitor whose next look came due, a worker that died holding the lease.
 *
 * ## Concurrency
 *
 * Keyed at 1 per errand, because two workers on one errand means two legs
 * commissioned for the same step and two bills for one piece of work. The
 * global limit is 3, well under the plan's ceiling of 5, and low on purpose:
 * each errand in flight can hold an orchestrator run, and THAT function's five
 * slots are shared with every scheduled routine and document ingest in the
 * install. Three errands advancing at once cannot starve the rest of the
 * product. (Asking for more than 5 anywhere makes Inngest reject the ENTIRE
 * app at sync time — see concurrency-guard.test.ts.)
 *
 * ## Why it does not retry
 *
 * `retries: 0`, the same decision the orchestrator makes and for the same
 * reason: a retried transition would re-enter an errand whose leg has already
 * been commissioned, and commissioning a leg is not replayable — it is a model
 * bill. A transition that throws leaves the errand exactly as it was, the lease
 * is released in a `finally`, and the sweep picks it up.
 */

/**
 * A ceiling on self-sent steps within one chain. Legs are already capped by the
 * budget, so reaching this means the machine is not converging — stop rather
 * than let it walk in a circle at a model call per lap. The sweep will still
 * look at the errand afterwards, so nothing is lost, but the loop is broken.
 */
const MAX_CHAINED_STEPS = 12;

/**
 * El cuerpo, extraído a la firma de la cola nueva. En pg-boss la exclusión por
 * encargo la da el lease de packages/agent-tools/src/errands/lifecycle.ts (la
 * segunda capa de siempre) más el `singletonKeyFrom: 'errandId'` del
 * manifiesto; la concurrencia global la fija el worker.
 */
export const errandRunJob: JobHandler = async ({ event, step }) => {
  const advance = event.data as unknown as ErrandAdvanceEvent;
  const errandId = advance?.errandId;
  const organizationId = advance?.organizationId;
  if (!errandId || !organizationId) {
    return { skipped: 'event carried no errand or workspace' };
  }

  const done: string[] = [];

  for (let n = 0; n < MAX_CHAINED_STEPS; n += 1) {
    const result = await step.run(`advance-${n}`, async () =>
      advanceErrand({ errandId, organizationId }),
    );
    done.push(`${result.did}${result.detail ? `:${result.detail}` : ''}`);
    if (!result.again) return { errandId, steps: done };
  }

  logger.error('errand-run: hit the chained-step ceiling without settling', {
    errandId,
    steps: done.length,
  });
  return { errandId, steps: done, stopped: 'chain ceiling' };
};

export const errandRun = inngest.createFunction(
  {
    id: 'errand-run',
    concurrency: [
      // One worker per errand. The lease in packages/agent-tools/src/errands/lifecycle.ts is the
      // second layer, and it is the one that also covers a re-sent event and
      // the older invocation still finishing during a deploy.
      { key: 'event.data.errandId', limit: 1 },
      { limit: 3 },
    ],
    retries: 0,
  },
  { event: EVENT_ERRAND_ADVANCE },
  async (ctx) => errandRunJob(ctx as unknown as JobContext),
);
