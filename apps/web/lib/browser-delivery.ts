import 'server-only';
import {
  DEFAULT_DELIVERY,
  DELIVER_TO,
  DELIVER_WHEN,
  type DeliverTo,
  type DeliverWhen,
  type FlowDelivery,
  OUTPUT_KINDS,
  type OutputKind,
} from '@/lib/browser-shape';
import { sendEmail } from '@/lib/email';
import { renderFlowResultEmail } from '@/lib/email-templates';
import { sendChatDm } from '@/lib/google-chat';
import { noteFlowRun } from '@/lib/notifications/producers';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Dónde queda el resultado de un trámite.
 *
 * ---------------------------------------------------------------------------
 * TELLING THE PERSON WHO ASKED IS NOT SENDING
 * ---------------------------------------------------------------------------
 * This is the line the whole module is built on, and it is drawn in the schema
 * rather than defended by a check: `browser_flows` has no recipient column, so
 * there is no way to express "mail this certificate to a client". Every channel
 * below resolves its address from the person who asked for the run, and from
 * nothing else — `to` is not a parameter of this function.
 *
 * The consequence is that nothing here needs an approval, and that is correct
 * rather than convenient: an approval card exists so somebody can stop data
 * leaving the company, and handing a person the document they themselves asked
 * for is not that. Anything genuinely outbound stays where it already lives —
 * `gmail.send_draft` and `browser.submit_flow`, both `requiresConfirmation`.
 *
 * ---------------------------------------------------------------------------
 * COMPOSED, NOT BUILT
 * ---------------------------------------------------------------------------
 * There is no notification engine here and there must not be one. Email is
 * `lib/email.ts`, the Chat DM is `lib/google-chat.ts`, the conversation message
 * is the same `messages` insert `schedule-run.ts` does. The one rule borrowed
 * from `lib/dev-work-notify.ts` is the important one: **email and Chat are two
 * channels for one message, never two messages**, and Chat is a silent no-op
 * for anybody who never linked it.
 *
 * ---------------------------------------------------------------------------
 * WHY A FAILURE IS DELIVERED TOO
 * ---------------------------------------------------------------------------
 * Because it is the more urgent half. A certificate that came out can wait for
 * somebody to open a screen; a certificate that did NOT come out has a deadline
 * behind it, and the person needs this morning to do it by hand. So a
 * destination covers both outcomes, and only `deliverWhen: 'failure'` is
 * one-sided — for the daily check that works thirty times a month.
 *
 * Nothing here throws. The errand already happened; a mail outage must not turn
 * a successful run into a failed one.
 */

export interface FlowRunOutcome {
  ok: boolean;
  /** The one-sentence verdict `runFlow` already produces. */
  message: string;
  /** Whatever the errand extracted or downloaded. Shape is the engine's. */
  output?: Record<string, unknown> | null;
  durationMs?: number | null;
  /**
   * Lo que el motor ya devuelve y que aquí SÓLO se lee para el aviso. Nada de
   * esto cambia la entrega: un trámite que se paró a pedir la clave no manda
   * correo (no hay resultado que mandar), pero sí tiene que dejar un renglón en
   * la campana, porque hay una pestaña abierta esperando a una persona.
   */
  failureKind?: 'transient' | 'legitimate' | 'site-changed' | 'needs-login' | 'needs-human' | null;
  pendingQuestion?: 'credential' | null;
  /** La corrida, para que el aviso apunte a un hecho y no a un trámite. */
  runId?: string | null;
  /**
   * La corrida de verificación que sigue a enseñar una grabación. No deja
   * aviso: la persona acaba de subir el vídeo y está mirando la pantalla.
   */
  verifying?: boolean;
}

export interface DeliverTarget {
  id: string;
  email: string | null;
  name?: string | null;
}

export interface DeliverResult {
  /** What was attempted. `skipped` means the trámite asked for nothing. */
  channel: 'none' | 'chat' | 'email';
  delivered: boolean;
  reason?: string;
}

/**
 * Lo que devolvió, en prosa.
 *
 * The engine hands back a bag of extracted values. A person reading a phone
 * notification needs sentences, so the bag becomes a short definition list and
 * the keys get their underscores taken out. Deliberately dumb: this is not the
 * place to interpret a portal's vocabulary, only to stop showing braces to
 * somebody who never asked for JSON.
 */
export function outputToMarkdown(output: Record<string, unknown> | null | undefined): string {
  if (!output) return '';
  const entries = Object.entries(output).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  );
  if (entries.length === 0) return '';
  return entries
    .map(([key, value]) => {
      const label = key.replaceAll(/[._-]/g, ' ').trim();
      const shown =
        typeof value === 'object' ? JSON.stringify(value) : String(value as string | number);
      return `- **${label}**: ${shown.slice(0, 400)}`;
    })
    .join('\n');
}

export async function deliverFlowResult(opts: {
  db: SupabaseClient;
  organizationId: string;
  /** Who asked for the run. The only recipient this function can reach. */
  requestedBy: DeliverTarget;
  flow: { id: string; name: string; site: string; delivery: FlowDelivery };
  outcome: FlowRunOutcome;
  /** The conversation the run came from, when it came from one. */
  conversationId?: string | null;
}): Promise<DeliverResult> {
  const result = await deliverToChannel(opts);

  // ── EL AVISO VA DESPUÉS, Y SIEMPRE ────────────────────────────────────────
  // Aquí y no en cada sitio que corre un trámite: éste es el único punto por el
  // que pasa todo resultado de trámite, así que el aviso no depende de que
  // nadie se acuerde. Va DESPUÉS de la entrega a propósito, porque la regla que
  // decide si merece un renglón necesita saber si el hecho ya viajó por un
  // canal que la persona mira — ver lib/notifications/producers.ts.
  await noteFlowRun(opts.db, {
    userId: opts.requestedBy.id,
    flow: { id: opts.flow.id, name: opts.flow.name, site: opts.flow.site },
    runId: opts.outcome.runId ?? null,
    ok: opts.outcome.ok,
    message: opts.outcome.message,
    failureKind: opts.outcome.failureKind ?? null,
    pendingQuestion: opts.outcome.pendingQuestion ?? null,
    deliveredElsewhere: result.delivered,
    verifying: opts.outcome.verifying ?? false,
  });

  return result;
}

async function deliverToChannel(opts: {
  db: SupabaseClient;
  organizationId: string;
  requestedBy: DeliverTarget;
  flow: { id: string; name: string; site: string; delivery: FlowDelivery };
  outcome: FlowRunOutcome;
  conversationId?: string | null;
}): Promise<DeliverResult> {
  const { delivery } = opts.flow;

  if (delivery.deliverTo === 'none') return { channel: 'none', delivered: false };
  if (delivery.deliverWhen === 'failure' && opts.outcome.ok) {
    return { channel: 'none', delivered: false, reason: 'sólo avisa cuando falla' };
  }

  try {
    // A trámite that asked to answer in the chat, run from a schedule at three
    // in the morning, has no chat to answer in. Falling back to mail keeps the
    // promise late rather than dropping it silently, which is the failure this
    // whole feature exists to prevent.
    if (delivery.deliverTo === 'chat' && opts.conversationId) {
      return await deliverToConversation(opts.db, opts.conversationId, opts.flow, opts.outcome);
    }
    return await deliverByMail(opts);
  } catch (err) {
    logger.error(
      { err: (err as Error).message, flowId: opts.flow.id },
      'browser: no se pudo entregar el resultado del trámite',
    );
    return { channel: delivery.deliverTo, delivered: false, reason: (err as Error).message };
  }
}

async function deliverToConversation(
  db: SupabaseClient,
  conversationId: string,
  flow: { name: string; site: string; delivery: FlowDelivery },
  outcome: FlowRunOutcome,
): Promise<DeliverResult> {
  const what = flow.delivery.outputLabel.trim() || flow.name;
  const detail = outputToMarkdown(outcome.output);
  const content = outcome.ok
    ? [`**${what}** · listo`, '', outcome.message, detail ? `\n${detail}` : ''].join('\n').trim()
    : `**${what}** · no salió\n\n${outcome.message}`;

  const { error } = await db.from('messages').insert({
    conversation_id: conversationId,
    role: 'assistant',
    content,
  });
  if (error) return { channel: 'chat', delivered: false, reason: error.message };
  return { channel: 'chat', delivered: true };
}

async function deliverByMail(opts: {
  organizationId: string;
  requestedBy: DeliverTarget;
  flow: { id: string; name: string; site: string; delivery: FlowDelivery };
  outcome: FlowRunOutcome;
}): Promise<DeliverResult> {
  const { flow, outcome, requestedBy } = opts;

  const mail = renderFlowResultEmail({
    flowId: flow.id,
    flowName: flow.name,
    site: flow.site,
    ok: outcome.ok,
    outputKind: flow.delivery.outputKind,
    outputLabel: flow.delivery.outputLabel,
    resultMarkdown: outputToMarkdown(outcome.output),
    errorMessage: outcome.ok ? null : outcome.message,
    ranAt: new Date(),
    durationMs: outcome.durationMs ?? null,
  });

  const sent = requestedBy.email
    ? await sendEmail({
        to: requestedBy.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      })
    : { sent: false, reason: 'la persona no tiene correo registrado' };

  // Second channel for the same message, never a second message. Silent no-op
  // for anybody who has not linked Google Chat.
  const chat = await sendChatDm({
    organizationId: opts.organizationId,
    userId: requestedBy.id,
    text: mail.text,
    threadKey: `flow-${flow.id}`,
  }).catch(() => ({ sent: false, reason: 'chat no disponible' }));

  if (!chat.sent && chat.reason && chat.reason !== 'not linked') {
    logger.warn({ flowId: flow.id, reason: chat.reason }, 'browser: el DM de Chat no salió');
  }

  return {
    channel: 'email',
    delivered: sent.sent || chat.sent,
    reason: sent.sent ? undefined : sent.reason,
  };
}

/* ---------------------------------------------------------------------------
 * Reading and writing the four columns of migration 0093.
 *
 * They live here rather than in the engine's store because they are not part
 * of the errand: the steps say what the browser does, these say what the
 * PRODUCT does with the answer. `getFlow` in agent-tools does not know about
 * them and does not need to.
 * -------------------------------------------------------------------------*/

const DELIVERY_COLUMNS = 'id, output_kind, output_label, deliver_to, deliver_when';

function toDelivery(row: Record<string, unknown> | null | undefined): FlowDelivery {
  if (!row) return DEFAULT_DELIVERY;
  const kind = String(row.output_kind ?? '');
  const to = String(row.deliver_to ?? '');
  const when = String(row.deliver_when ?? '');
  return {
    outputKind: (OUTPUT_KINDS as readonly string[]).includes(kind)
      ? (kind as OutputKind)
      : DEFAULT_DELIVERY.outputKind,
    outputLabel: String(row.output_label ?? ''),
    deliverTo: (DELIVER_TO as readonly string[]).includes(to)
      ? (to as DeliverTo)
      : DEFAULT_DELIVERY.deliverTo,
    deliverWhen: (DELIVER_WHEN as readonly string[]).includes(when)
      ? (when as DeliverWhen)
      : DEFAULT_DELIVERY.deliverWhen,
  };
}

/** One lookup for a whole listing, rather than one per row. */
export async function readDeliveries(db: SupabaseClient): Promise<Map<string, FlowDelivery>> {
  const { data } = await db.from('browser_flows').select(DELIVERY_COLUMNS);
  const map = new Map<string, FlowDelivery>();
  for (const row of (data as Record<string, unknown>[]) ?? []) {
    map.set(String(row.id), toDelivery(row));
  }
  return map;
}

export async function readDelivery(db: SupabaseClient, flowId: string): Promise<FlowDelivery> {
  const { data } = await db
    .from('browser_flows')
    .select(DELIVERY_COLUMNS)
    .eq('id', flowId)
    .maybeSingle();
  return toDelivery(data as Record<string, unknown> | null);
}

/**
 * Sanitised on the way in: anything that is not one of the declared literals
 * falls back to the default rather than reaching the CHECK constraint, so a
 * malformed request is a no-op instead of a 500. The label is trimmed and
 * capped — it becomes an email subject line.
 */
export async function writeDelivery(
  db: SupabaseClient,
  flowId: string,
  wanted: Partial<FlowDelivery>,
): Promise<FlowDelivery> {
  const merged = toDelivery({
    output_kind: wanted.outputKind,
    output_label: (wanted.outputLabel ?? '').slice(0, 120).trim(),
    deliver_to: wanted.deliverTo,
    deliver_when: wanted.deliverWhen,
  });
  await db
    .from('browser_flows')
    .update({
      output_kind: merged.outputKind,
      output_label: merged.outputLabel,
      deliver_to: merged.deliverTo,
      deliver_when: merged.deliverWhen,
    })
    .eq('id', flowId);
  return merged;
}
