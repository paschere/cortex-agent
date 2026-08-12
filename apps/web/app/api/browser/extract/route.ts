import { requireSession } from '@/lib/session';
import { type Frame, MAX_FRAMES, extractFlowFromRecording } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Reading a trámite off a screen recording.
 *
 * THE FRAMES STOP HERE. They arrive in this request body, they are passed to
 * the model, and the response is a step list. Nothing writes them to Postgres,
 * to object storage or to disk; there is no queue, no job and no row that
 * carries them. When this function returns they are garbage, and the only trace
 * the teaching session leaves in the product is a count and a cost.
 *
 * That property is why extraction is synchronous even though it takes the best
 * part of a minute. Making it a background job would need somewhere to put the
 * frames while it waited, and "somewhere" is a copy of somebody's screen that
 * then has to be defended, audited and eventually deleted by a sweeper that
 * will one day not run. The cheapest way not to leak a recording is not to
 * have one.
 *
 * The response is a PROPOSAL. Nothing is saved here: the browser shows it, the
 * person corrects it, and POST /api/browser/flows saves it and immediately
 * tries to reproduce it.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Twenty frames of a portal is a slow read. Below the Vercel ceiling and above
// what the model needs; a shorter budget would fail on exactly the long errands
// that are worth teaching.
export const maxDuration = 300;

interface Body {
  frames?: { base64?: string; mimeType?: string; atMs?: number; phase?: string }[];
  hint?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession();

  const body = (await req.json().catch(() => ({}))) as Body;
  const frames: Frame[] = (body.frames ?? [])
    .filter((f): f is { base64: string; mimeType: string; atMs: number; phase?: string } =>
      Boolean(f.base64 && f.mimeType),
    )
    .slice(0, MAX_FRAMES)
    .map((f) => ({
      base64: f.base64,
      mimeType: f.mimeType,
      atMs: f.atMs ?? 0,
      // Only two values mean anything, and an unrecognised one is dropped
      // rather than passed on: a mislabelled frame is worse than an unlabelled
      // one, because the extractor is told to trust the label.
      ...(f.phase === 'antes' || f.phase === 'despues' ? { phase: f.phase } : {}),
    }));

  if (frames.length === 0) {
    return NextResponse.json(
      { error: 'No llegó ningún cuadro de la grabación. Vuelve a grabar la pestaña.' },
      { status: 400 },
    );
  }

  const extracted = await extractFlowFromRecording({
    frames,
    hint: (body.hint ?? '').slice(0, 500),
    logger,
  });

  if (!extracted.ok) {
    return NextResponse.json({ error: extracted.reason }, { status: 422 });
  }

  logger.info(
    // The count and the cost, never the pictures.
    { userId: session.id, frames: frames.length, costUsd: extracted.result.spend.costUsd },
    'read a trámite out of a screen recording',
  );

  return NextResponse.json({
    proposal: extracted.result.proposal,
    warnings: extracted.result.warnings,
    frames: frames.length,
    costUsd: extracted.result.spend.costUsd,
  });
}
