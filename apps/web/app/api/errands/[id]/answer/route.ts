import { EVENT_ERRAND_ADVANCE } from '@/lib/errands/contract';
import { loadErrand } from '@/lib/errands/repository';
import { inngest } from '@/lib/inngest';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type ErrandDb, answerQuestion } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  questionId: z.string().uuid(),
  answer: z.string().trim().min(1).max(2000),
});

/**
 * Answer the question an errand stopped to ask, and set it going again.
 *
 * ── WHY THIS IS A RESUMPTION AND NOT A RELAUNCH ───────────────────────────
 *
 * Nothing here rewinds anything. The errand's `findings` were written BEFORE
 * it blocked (packages/agent-tools/src/errands/lifecycle.ts `askAndBlock`), its finished legs are
 * still on the table with their reports, and the answer is folded into the
 * objective of the NEXT leg alongside them (`composeObjective`). So an errand
 * that spent thirty minutes discovering a fork and then asked about it comes
 * back knowing everything it knew, plus the answer.
 *
 * That is the whole reason a question is cheap enough to be the default
 * response to uncertainty. If asking cost the work, the engine would be right
 * to guess instead.
 *
 * The guard lives in the conditional UPDATE on the QUESTION row (`state =
 * 'open'` in the WHERE clause), so two people answering at the same moment
 * produce one resumption and one honest 409 — not two legs.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await requireSession();
  const { id } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Escribe una respuesta.' }, { status: 400 });
  }

  const db = getOrgScopedClient(user.organization.id);

  // Scoped read first: an errand from another workspace is a 404 before
  // anything is written, not after.
  const errand = await loadErrand(db, id, user.organization.id);
  if (!errand) return NextResponse.json({ error: 'No existe ese encargo.' }, { status: 404 });

  const outcome = await answerQuestion(db as unknown as ErrandDb, {
    errandId: id,
    questionId: parsed.data.questionId,
    answer: parsed.data.answer,
    userId: user.id,
  });

  if (outcome === 'not_open') {
    return NextResponse.json(
      { error: 'Esa pregunta ya no está abierta — puede que alguien más la haya contestado.' },
      { status: 409 },
    );
  }
  if (outcome === 'not_found') {
    return NextResponse.json(
      { error: 'El encargo ya no estaba esperando una respuesta.' },
      { status: 409 },
    );
  }

  try {
    await inngest.send({
      name: EVENT_ERRAND_ADVANCE,
      data: {
        errandId: id,
        organizationId: user.organization.id,
        userId: errand.userId ?? user.id,
        because: 'answered',
      },
    });
  } catch (err) {
    // The answer is saved and the errand is back to `working`; the sweep will
    // pick it up within a couple of minutes. Latency, not loss.
    logger.error('errands: could not resume after an answer; the sweep will', {
      errandId: id,
      error: (err as Error).message,
    });
  }

  return NextResponse.json({ ok: true, resumed: true });
}
