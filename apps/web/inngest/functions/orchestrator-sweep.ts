import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { type LifecycleDb, interruptRun } from '@/lib/orchestrator/lifecycle';
import { STALE_AFTER_MS, staleCutoffIso } from '@/lib/orchestrator/liveness';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';

/**
 * The backstop: nothing stays "ejecutando" for ever.
 *
 * Moving execution to Inngest removed the two deaths we knew about — the
 * five-minute ceiling and the redeploy. It cannot remove the ones nobody has
 * thought of. A worker can be OOM-killed between steps, a step can hang on a
 * socket that never closes, a database write can fail at exactly the wrong
 * moment. Every one of those ends the same way: the row says the run is working
 * and no process is working on it, and the screen repeats that indefinitely.
 *
 * So the system watches itself. A run advances `last_heartbeat_at` whenever it
 * does anything at all (see lib/orchestrator/events.ts — every event it appends
 * is a heartbeat), and this sweep closes anything that has gone quiet for
 * longer than STALE_AFTER_MS. Silence is the only evidence available: a process
 * that dies cannot report that it died.
 *
 * WHAT IT WRITES, AND WHY THAT WORD. `interrupted`, not `failed` and not
 * `cancelled`. The run did not try and fail — it stopped talking, and honestly
 * saying "we do not know how this ended" is worth more than a tidy status that
 * blames either the work or the person. See migration 0070.
 *
 * WHY THIS ONE HOLDS A RAW, UNSCOPED CLIENT. "Which runs anywhere in the
 * install have gone quiet" is a question about the whole install; there is no
 * workspace to scope it to and no session behind a cron. The isolation happens
 * one step later and is the reason `organization_id` is read here: every write
 * goes through a handle pinned to the run's own workspace. The raw handle only
 * ever runs one SELECT.
 */

/**
 * Every five minutes. The threshold is fifteen, so a dead run is closed between
 * 15 and 20 minutes after its last sign of life — well inside the window in
 * which somebody is still looking at the page, and far outside anything a
 * healthy run can be silent for.
 */
const CRON = '*/5 * * * *';

/**
 * Runs closed per pass. A ceiling rather than a limit anybody expects to reach:
 * a hundred silent runs at once is an outage, and the leftovers are closed five
 * minutes later.
 */
const MAX_PER_PASS = 100;

interface SilentRun {
  id: string;
  organizationId: string;
}

/** El cuerpo, extraído a la firma de la cola nueva; `event` no se usa. */
export const orchestratorSweepJob: JobHandler = async ({ step }) => {
  const closed = await step.run('close-silent-runs', async () => {
    const now = Date.now();
    const cutoffIso = staleCutoffIso(now);

    const raw = getSupabaseServiceClient();
    const { data, error } = await raw
      .from('orchestration_runs')
      .select('id, organization_id')
      .in('status', ['planning', 'running'])
      .lt('last_heartbeat_at', cutoffIso)
      .order('last_heartbeat_at', { ascending: true })
      .limit(MAX_PER_PASS);

    if (error) throw new Error(`Could not scan for silent runs: ${error.message}`);

    const candidates: SilentRun[] = ((data ?? []) as Record<string, unknown>[])
      .map((row) => ({
        id: row.id as string,
        organizationId: (row.organization_id as string | null) ?? '',
      }))
      .filter((row) => row.id && row.organizationId);

    const done: string[] = [];
    for (const candidate of candidates) {
      try {
        // Scoped to the run's own workspace, and the freshness guard is
        // re-applied inside the UPDATE: a run that beat once between the scan
        // and this write is alive and matches nothing.
        const db = getOrgScopedClient(candidate.organizationId) as unknown as LifecycleDb;
        if (await interruptRun(db, candidate.id, { now, cutoffIso })) done.push(candidate.id);
      } catch (err) {
        // One workspace's problem must not stop the sweep for the rest.
        logger.error('orchestrator-sweep: could not close a silent run', {
          runId: candidate.id,
          error: (err as Error).message,
        });
      }
    }

    if (done.length > 0) {
      logger.info(
        `orchestrator-sweep: closed ${done.length} run(s) silent for more than ${
          STALE_AFTER_MS / 60_000
        } minutes`,
      );
    }
    return { scanned: candidates.length, closed: done.length };
  });

  return closed;
};

export const orchestratorSweep = inngest.createFunction(
  { id: 'orchestrator-sweep' },
  { cron: CRON },
  async (ctx) => orchestratorSweepJob(ctx as unknown as JobContext),
);
