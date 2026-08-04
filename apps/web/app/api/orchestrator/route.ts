import { DEFAULT_CONCURRENCY, runOrchestration } from '@/lib/orchestrator/executor';
import { listRuns } from '@/lib/orchestrator/repository';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse, after } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A full run is planner + several waves of sub-agents + synthesis. It has to
// outlive the response, which `after()` keeps alive for the rest of this budget.
export const maxDuration = 300;

const Body = z.object({
  objective: z.string().trim().min(10).max(4000),
  /** Parallel sub-agents in flight. Exposed so a heavy objective can be throttled. */
  concurrency: z.number().int().min(1).max(8).optional(),
});

/** Launch a run. Returns the id straight away — the work happens after the response. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await requireSession();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Give the orchestrator an objective of at least 10 characters.' },
      { status: 400 },
    );
  }

  const db = getSupabaseServiceClient();
  const { data, error } = await db
    .from('orchestration_runs')
    .insert({
      organization_id: user.organization.id,
      user_id: user.id,
      objective: parsed.data.objective,
      status: 'planning',
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

  // Fire-and-forget on purpose: the console is driven by the event log, not by
  // this response, so blocking here would only make the page wait for a plan it
  // is about to receive over SSE anyway. `after()` (rather than a bare floating
  // promise) is what stops the serverless runtime freezing the invocation the
  // moment the response is flushed.
  //
  // Trade-off, deliberate: a run lives inside one function invocation, so it is
  // bounded by `maxDuration` and does not survive a redeploy. Moving it onto
  // Inngest (see inngest/functions/schedule-run.ts) is the upgrade path if runs
  // start outgrowing five minutes.
  after(async () => {
    try {
      await runOrchestration({
        runId,
        userId: user.id,
        organizationId: user.organization.id,
        objective: parsed.data.objective,
        concurrency: parsed.data.concurrency ?? DEFAULT_CONCURRENCY,
      });
    } catch (err) {
      logger.error('orchestrator: run crashed outside its own handler', {
        runId,
        error: (err as Error).message,
      });
    }
  });

  return NextResponse.json({ runId }, { status: 201 });
}

/** Run history for the active workspace. */
export async function GET(): Promise<NextResponse> {
  const user = await requireSession();
  const runs = await listRuns(getSupabaseServiceClient(), user.organization.id);
  return NextResponse.json({ runs });
}
