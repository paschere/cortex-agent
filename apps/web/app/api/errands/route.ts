import { MAX_LIVE_ERRANDS, ceilingsFor } from '@/lib/errands/budget';
import { EVENT_ERRAND_ADVANCE } from '@/lib/errands/contract';
import {
  DEFAULT_MONITOR_CADENCE_MINUTES,
  ERRAND_KIND_SPECS,
  isMonitorCadence,
} from '@/lib/errands/kinds';
import { countLiveErrands, listErrands } from '@/lib/errands/repository';
import { ERRAND_KINDS } from '@/lib/errands/types';
import { inngest } from '@/lib/inngest';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { checkMeter, isRefused } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  kind: z.enum(ERRAND_KINDS),
  request: z.string().trim().min(10).max(4000),
  /** Monitors only. Ignored for the other kinds. */
  checkIntervalMinutes: z.number().int().optional(),
  /** A person may lower the ceiling for a cheap errand, or raise it within reason. */
  tokenCeiling: z.number().int().optional(),
  legCeiling: z.number().int().optional(),
});

/**
 * Commission an errand. Returns immediately — the work happens in Inngest.
 *
 * ── THE THREE THINGS THIS ROUTE REFUSES, AND WHY HERE ─────────────────────
 *
 * This is the last point at which a session exists, so it is the only place
 * that can ask "is this workspace allowed to start autonomous work at all".
 * Everything downstream runs unattended and reads its authority off a row.
 *
 *   1. OVER QUOTA. If the workspace's `answers` meter is already refusing chat
 *      turns (0085/0086, packages/agent-tools/src/billing), it has no business
 *      commissioning an hour of autonomous research. Errands themselves write
 *      no `usage_events` — that ledger is maintained by database triggers on
 *      `messages` and `kb_documents` and never by application code — so this
 *      check is not metering, it is admission control against the meter that
 *      does exist. The per-errand token ceiling is what bounds the spend.
 *
 *   2. TOO MANY IN FLIGHT. `MAX_LIVE_ERRANDS` per workspace. Per-errand
 *      ceilings bound one errand; only this bounds twenty launched in a
 *      minute, and each one in flight can hold an orchestrator run out of a
 *      pool of five shared with every background job in the install.
 *
 *   3. A KIND WE DID NOT PROMISE. `kind` is an enum here, a CHECK constraint
 *      in 0089 and a closed record in lib/errands/kinds.ts. Three shapes, done
 *      properly, instead of "cualquier cosa" — see the header of kinds.ts for
 *      what was considered and left out.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await requireSession();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          'Dile qué quieres que haga, con al menos 10 caracteres, y de cuál de los tres tipos.',
      },
      { status: 400 },
    );
  }

  const db = getOrgScopedClient(user.organization.id);

  const answers = await checkMeter(db, 'answers');
  if (isRefused(answers)) {
    return NextResponse.json(
      {
        error:
          'Este espacio de trabajo llegó al tope de respuestas de su plan. Un encargo corre solo y ' +
          'puede consumir bastante, así que no lo dejamos arrancar mientras el plan esté al límite. ' +
          'Mira Plan y consumo.',
        reason: 'plan_limit',
      },
      { status: 402 },
    );
  }

  const live = await countLiveErrands(db, user.organization.id);
  if (live >= MAX_LIVE_ERRANDS) {
    return NextResponse.json(
      {
        error:
          `Ya hay ${live} encargos andando en este espacio de trabajo, que es el máximo. ` +
          'Espera a que alguno entregue, o detén el que ya no necesites.',
        reason: 'too_many_live',
      },
      { status: 409 },
    );
  }

  const spec = ERRAND_KIND_SPECS[parsed.data.kind];
  const { tokenCeiling, legCeiling } = ceilingsFor(parsed.data.kind, spec, parsed.data);

  const isMonitor = parsed.data.kind === 'monitor_change';
  const cadence =
    isMonitor &&
    parsed.data.checkIntervalMinutes &&
    isMonitorCadence(parsed.data.checkIntervalMinutes)
      ? parsed.data.checkIntervalMinutes
      : isMonitor
        ? DEFAULT_MONITOR_CADENCE_MINUTES
        : null;

  const { data, error } = await db
    .from('errands')
    .insert({
      user_id: user.id,
      kind: parsed.data.kind,
      request: parsed.data.request,
      state: 'queued',
      token_ceiling: tokenCeiling,
      leg_ceiling: legCeiling,
      check_interval_minutes: cadence,
      // The sweep's clock starts here, not when a worker picks it up: an
      // errand that never reaches Inngest at all has to be closable too.
      last_heartbeat_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? 'No se pudo crear el encargo.' },
      { status: 500 },
    );
  }

  const errandId = data.id as string;

  try {
    await inngest.send({
      name: EVENT_ERRAND_ADVANCE,
      data: {
        errandId,
        organizationId: user.organization.id,
        userId: user.id,
        because: 'created',
      },
    });
  } catch (err) {
    // The row exists and nothing will pick it up for a minute. Unlike the
    // orchestrator, this is NOT fatal: the sweep nudges every live errand that
    // has gone quiet, so a failed send costs latency rather than the errand.
    // Say so in the log and let it through.
    logger.error('errands: could not queue the first step; the sweep will pick it up', {
      errandId,
      error: (err as Error).message,
    });
  }

  return NextResponse.json({ errandId }, { status: 201 });
}

/** Errand history for the active workspace. */
export async function GET(): Promise<NextResponse> {
  const user = await requireSession();
  const errands = await listErrands(getOrgScopedClient(user.organization.id), user.organization.id);
  return NextResponse.json({ errands });
}
