import { buildToolContext } from '@/lib/agent';
import { EVENT_ERRAND_ADVANCE } from '@/lib/errands/contract';
import { listErrands } from '@/lib/errands/repository';
import { enqueueJob } from '@/lib/jobs';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { ERRAND_KINDS, commissionErrand } from '@cortex/agent-tools';
import { loadAgent } from '@cortex/agents';
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
 * Commission an errand from the form. Returns immediately — the work happens
 * in Inngest.
 *
 * ── THIS ROUTE NO LONGER DECIDES ANYTHING ─────────────────────────────────
 *
 * It used to hold the three admission checks — the plan meter, the live cap,
 * and the line — on the reasoning that it was the last place with a session.
 * That reasoning was right about sessions and wrong as an architecture. The
 * moment `errands.start` shipped, the chat became a second way in, and checks
 * living in one caller are checks the other silently skips. The second caller
 * is the one a model invokes from a sentence somebody typed, which is exactly
 * the caller you would least like to have a private door.
 *
 * So all three moved into `commissionErrand`
 * (packages/agent-tools/src/errands/store.ts) and BOTH callers go through it.
 * What is left here is what a request is actually good at: authenticate, parse,
 * map a refusal onto an HTTP status, and hand the work off.
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

  const agent = await loadAgent(getOrgScopedClient(user.organization.id), 'cortex');
  const ctx = buildToolContext({
    organizationId: user.organization.id,
    userId: user.id,
    agentId: agent.id,
    surface: 'web',
  });

  const outcome = await commissionErrand(ctx, {
    kind: parsed.data.kind,
    request: parsed.data.request,
    checkIntervalMinutes: parsed.data.checkIntervalMinutes ?? null,
    tokenCeiling: parsed.data.tokenCeiling,
    legCeiling: parsed.data.legCeiling,
    // The form is not a conversation, so a question from this errand waits on
    // the /errands screen. One started from the chat carries its thread and
    // gets its question delivered back there — see lib/errands/notify.ts.
    conversationId: null,
  });

  if (!outcome.ok) {
    const status =
      outcome.reason === 'plan_limit' ? 402 : outcome.reason === 'too_many_live' ? 409 : 500;
    return NextResponse.json({ error: outcome.message, reason: outcome.reason }, { status });
  }

  const errandId = outcome.errand.id;

  // `enqueueJob` nunca lanza. Si devuelve false la fila ya existe y el barrido
  // recoge todo encargo en cola en su siguiente pasada: un encolado fallido
  // cuesta latencia, no el encargo.
  const queued = await enqueueJob(EVENT_ERRAND_ADVANCE, {
    errandId,
    organizationId: user.organization.id,
    userId: user.id,
    because: 'created',
  });
  if (!queued) {
    logger.error('errands: could not queue the first step; the sweep will pick it up', {
      errandId,
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
