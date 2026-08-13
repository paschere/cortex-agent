import { deliverFlowResult, readDelivery } from '@/lib/browser-delivery';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { createHttpTransport, getFlow, runFlow } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Running a trámite from the screen.
 *
 * WHY THIS DOES NOT GO THROUGH THE APPROVAL CARD, and why that is not a hole.
 * The card exists because the MODEL can decide to call a tool and a person has
 * to be given the chance to say no first. Here the person IS the caller: they
 * are looking at what the flow does, they pressed the button, and an approval
 * dialog asking them to confirm the thing they just asked for is the kind of
 * ceremony that teaches people to click through dialogs.
 *
 * The gate that does apply is `canRunFlow` inside `runFlow`: a trámite carrying
 * a company credential is not runnable by somebody who has not been granted it,
 * from this screen or anywhere else.
 *
 * WHAT HAPPENS TO THE RESULT. Whatever the trámite declared (migration 0093).
 * From this screen the person is watching, so a destination of `none` is
 * perfectly reasonable and is the default; but a trámite that says "mándamelo
 * por correo" means it here too, because the certificate is worth having in an
 * inbox whether a person pressed the button or a routine did.
 *
 * Delivery never affects the response: it is awaited so a serverless function
 * is not killed mid-send, and its outcome is reported alongside rather than
 * replacing the run's own verdict.
 *
 * A `draft` flow IS runnable here, deliberately. That is how a propuesto
 * becomes probado: somebody with the context tries it. What a draft is not is
 * available to the agent -- see browser/tools.ts.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await requireSession();
  const db = getOrgScopedClient(session.organization.id);
  const { id } = await params;

  const flow = await getFlow(db, id);
  if (!flow) return NextResponse.json({ error: 'Ese trámite no existe.' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { inputs?: Record<string, string> };

  const outcome = await runFlow({
    db,
    organizationId: session.organization.id,
    actor: { id: session.id, role: session.role },
    flow,
    inputs: body.inputs ?? {},
    transport: createHttpTransport(logger),
    logger,
    trigger: 'test',
  });

  const delivery = await readDelivery(db, flow.id);
  const delivered = await deliverFlowResult({
    db,
    organizationId: session.organization.id,
    requestedBy: { id: session.id, email: session.email, name: session.name },
    flow: { id: flow.id, name: flow.name, site: flow.host, delivery },
    outcome: {
      ok: outcome.ok,
      message: outcome.message,
      output: outcome.output as Record<string, unknown> | null,
      durationMs: outcome.durationMs,
      // Los tres que sólo lee el aviso. Un trámite que se paró a pedir la
      // clave, o al que el portal le puso un captcha, no manda correo (no hay
      // resultado que mandar) pero sí deja un renglón en la campana: la
      // pestaña sigue abierta esperando a una persona y se cierra sola.
      failureKind: outcome.failureKind ?? null,
      pendingQuestion: outcome.pendingQuestion ?? null,
      runId: outcome.runId,
    },
  });

  return NextResponse.json({
    ok: outcome.ok,
    message: outcome.message,
    output: outcome.output,
    seconds: Math.round(outcome.durationMs / 100) / 10,
    costUsd: outcome.spend.costUsd,
    modelCalls: outcome.spend.calls,
    failureKind: outcome.failureKind ?? null,
    // { filename, mimeType, sizeBytes, documentId } — never the bytes.
    document: (outcome.output.download as Record<string, unknown> | undefined) ?? null,
    // Not a failure: the run stopped and asked for something. The screen can
    // read this to offer binding a credential instead of reporting a defeat.
    pendingQuestion: outcome.pendingQuestion ?? null,
    // The portal stopped to ask whether we are a robot and the browser is
    // STILL OPEN on that page, for a few minutes, waiting for a person. Passed
    // straight through and never stored: the tab it points at is swept long
    // before any row about it would stop being true. See BrowserHandoff.
    handoff: outcome.handoff ?? null,
    repaired: outcome.repaired ?? false,
    version: outcome.newVersion ?? flow.version,
    // So the screen can say "y te lo mandé al correo" instead of leaving the
    // person to wonder whether the destination they chose actually fired.
    delivered: delivered.delivered ? delivered.channel : null,
  });
}
