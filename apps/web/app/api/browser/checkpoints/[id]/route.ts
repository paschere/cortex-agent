import { deliverFlowResult, readDelivery } from '@/lib/browser-delivery';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  checkpointSecondsLeft,
  createHttpTransport,
  getCheckpoint,
  getFlow,
  isCheckpointLive,
  resumeFlow,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
/** Retomar un trámite es correr el resto del trámite. El mismo techo que /run. */
export const maxDuration = 300;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CONTESTARLE A UN TRÁMITE QUE SE PARÓ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── POR QUÉ NO SIRVE LA RUTA DE SESIÓN QUE YA EXISTÍA ─────────────────────
 *
 * `POST /api/browser/session/[id]` con `continue` habla directo con el
 * servicio de navegador, y eso alcanzaba mientras la única pausa era un
 * captcha resuelto por la misma persona que acababa de apretar «Correr», con
 * la pantalla abierta y el `handoff` en memoria del componente. Tres cosas la
 * dejaron corta:
 *
 *   * NO CIERRA NADA. Dos personas contestando la misma pregunta —lo normal
 *     en cuanto un encargo pregunta por el chat Y por la campana— mandan dos
 *     `/continue`, y el segundo llega a una sesión que el primero ya consumió.
 *     Un 404 y una frase sobre una sesión perdida, encima de un trámite que sí
 *     terminó.
 *   * NO ENTREGA. El archivo que el trámite trae después del captcha no se
 *     archiva en el cerebro, porque el que archiva es `runFlow`.
 *   * NO SABE DE DATOS. Un código por SMS tiene que entrar como el valor de un
 *     slot, normalizado por su tipo, y esa ruta sólo sabe de píxeles.
 *
 * Esta ruta pasa por `resumeFlow`, que hace las tres: cierra el checkpoint con
 * un UPDATE condicional ANTES de tocar la pestaña, teclea la respuesta como
 * dato del trámite, y archiva lo que baje.
 *
 * La otra ruta se queda para lo que sí es suya: mirar la pestaña y hacer clic
 * en ella. Un captcha se resuelve con el ratón y después se retoma por aquí.
 */

const Body = z.object({
  /**
   * Lo que dijo la persona. Vacío es legítimo y es el caso del captcha: la
   * respuesta fue el clic, no un texto.
   */
  answer: z.string().max(300).nullish(),
});

/** En qué va esta pausa, para que la pantalla no ofrezca un botón muerto. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const db = getOrgScopedClient(session.organization.id);
  const { id } = await ctx.params;

  const checkpoint = await getCheckpoint(db, id);
  if (!checkpoint) {
    return NextResponse.json({ error: 'Esa pausa ya no existe.' }, { status: 404 });
  }
  const flow = await getFlow(db, checkpoint.flowId);

  return NextResponse.json({
    id: checkpoint.id,
    flow: flow ? { id: flow.id, name: flow.name, site: flow.host } : null,
    reason: checkpoint.reason,
    ask: checkpoint.ask,
    // Null en un captcha: no hay dato que teclear, hay algo que hacer.
    fills: checkpoint.fills,
    sessionId: checkpoint.sessionId,
    fromIndex: checkpoint.fromIndex,
    state: checkpoint.state,
    live: isCheckpointLive(checkpoint),
    secondsLeft: checkpointSecondsLeft(checkpoint),
    expiresAt: checkpoint.expiresAt,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const db = getOrgScopedClient(session.organization.id);
  const { id } = await ctx.params;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'No entendí lo que llegó.' }, { status: 400 });
  }

  const outcome = await resumeFlow({
    db,
    organizationId: session.organization.id,
    actor: { id: session.id, role: session.role },
    checkpointId: id,
    answer: parsed.data.answer ?? '',
    transport: createHttpTransport(logger),
    logger,
  });

  // El resultado sale por donde salga siempre el de este trámite — correo,
  // chat, o a ninguna parte. Un trámite que terminó después de un captcha
  // entrega igual que uno que nunca se detuvo; lo contrario sería castigar a
  // la persona por haber ayudado.
  const checkpoint = await getCheckpoint(db, id);
  const flow = checkpoint ? await getFlow(db, checkpoint.flowId) : null;
  let delivered: string | null = null;
  if (flow) {
    const delivery = await readDelivery(db, flow.id);
    const result = await deliverFlowResult({
      db,
      organizationId: session.organization.id,
      requestedBy: { id: session.id, email: session.email, name: session.name },
      flow: { id: flow.id, name: flow.name, site: flow.host, delivery },
      outcome: {
        ok: outcome.ok,
        message: outcome.message,
        output: outcome.output as Record<string, unknown> | null,
        durationMs: outcome.durationMs,
        failureKind: outcome.failureKind ?? null,
        pendingQuestion: outcome.pendingQuestion ?? null,
        runId: outcome.runId,
      },
    });
    delivered = result.delivered ? result.channel : null;
  }

  return NextResponse.json({
    ok: outcome.ok,
    message: outcome.message,
    output: outcome.output,
    seconds: Math.round(outcome.durationMs / 100) / 10,
    document: (outcome.output.download as Record<string, unknown> | undefined) ?? null,
    // Un trámite puede pararse dos veces: el banco pide el código para entrar y
    // otro para autorizar la descarga. La segunda pausa vuelve por aquí.
    pausedAt: outcome.checkpoint?.id ?? null,
    asks: outcome.checkpoint?.ask ?? null,
    handoff: outcome.handoff ?? null,
    delivered,
  });
}
