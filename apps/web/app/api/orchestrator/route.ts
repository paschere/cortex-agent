import { inngest } from '@/lib/inngest';
import { EVENT_RUN_STARTED } from '@/lib/orchestrator/contract';
import { DEFAULT_CONCURRENCY } from '@/lib/orchestrator/executor';
import { listRuns } from '@/lib/orchestrator/repository';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  objective: z.string().trim().min(10).max(4000),
  /** Parallel sub-agents in flight. Exposed so a heavy objective can be throttled. */
  concurrency: z.number().int().min(1).max(8).optional(),
});

/**
 * Launch a run. Returns the id straight away — the work happens in Inngest.
 *
 * THIS ROUTE USED TO EXECUTE THE RUN, inside `after()`, under
 * `maxDuration = 300`. That tied a multi-agent orchestration to the lifetime of
 * one serverless invocation, which gave it two endings nobody wrote a terminal
 * state for: it outgrew five minutes (normal), or a deploy replaced the
 * instance (six deploys in an afternoon). Either way the row said `running`
 * for ever.
 *
 * Now the route does the two things a request is actually good at — write the
 * row and hand the work off — and `orchestrator/run.started` carries the
 * workspace and the person, because the function that picks it up has no
 * session to ask. See inngest/functions/orchestrator-run.ts.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await requireSession();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Give the orchestrator an objective of at least 10 characters.' },
      { status: 400 },
    );
  }

  const db = getOrgScopedClient(user.organization.id);
  const { data, error } = await db
    .from('orchestration_runs')
    .insert({
      user_id: user.id,
      objective: parsed.data.objective,
      status: 'planning',
      // The clock the sweep reads starts here, not when the executor picks the
      // run up: a run that never reaches Inngest at all has to be closable too.
      last_heartbeat_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? 'Could not start the run.' },
      { status: 500 },
    );
  }

  const runId = data.id as string;

  try {
    await inngest.send({
      name: EVENT_RUN_STARTED,
      data: {
        runId,
        organizationId: user.organization.id,
        userId: user.id,
        objective: parsed.data.objective,
        concurrency: parsed.data.concurrency ?? DEFAULT_CONCURRENCY,
      },
    });
  } catch (err) {
    // The row exists but nothing will ever pick it up. Close it here rather
    // than leave a run in `planning` for the sweep to bury fifteen minutes from
    // now — this is the one failure the request itself can see and explain.
    const message = (err as Error).message;
    logger.error('orchestrator: could not queue the run', { runId, error: message });
    await db
      .from('orchestration_runs')
      .update({
        status: 'failed',
        summary:
          '**No se pudo encolar esta ejecución.**\n\nEl objetivo quedó guardado, pero la cola ' +
          'de trabajo en segundo plano no respondió, así que ningún subagente llegó a arrancar. ' +
          'Vuelve a lanzarlo.',
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId);
    return NextResponse.json(
      { error: 'No se pudo encolar la ejecución. Vuelve a intentarlo.' },
      { status: 502 },
    );
  }

  return NextResponse.json({ runId }, { status: 201 });
}

/** Run history for the active workspace. */
export async function GET(): Promise<NextResponse> {
  const user = await requireSession();
  const runs = await listRuns(getOrgScopedClient(user.organization.id), user.organization.id);
  return NextResponse.json({ runs });
}
