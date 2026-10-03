import type { ClientInvoice } from '../../clients/hub';
import {
  ASK_ORDER_NUMBER,
  ASK_VERIFICATION,
  type Answer,
  ESCALATED_ACK,
  OPT_IN_ACK,
  OPT_OUT_ACK,
  type OrderFact,
  THANKS_ACK,
  afterHoursAnswer,
  balanceAnswer,
  companyAnswer,
  faqAnswer,
  greetingAnswer,
  handoffAnswer,
  invoicesAnswer,
  orderAnswer,
  orderNotFound,
  verificationFailed,
} from './answers';
import {
  type Classification,
  type PhoneMatch,
  classify,
  extractBareReference,
  extractInvoiceNumber,
  extractNit,
  extractOrderNumber,
  isWithinHours,
  nextOpening,
  underRateLimit,
} from './classify';
import type {
  ConversationRow,
  CustomerSettings,
  Intent,
  MessageSource,
  OrderSource,
} from './shape';

/**
 * UN MENSAJE DE UN CLIENTE, DE PRINCIPIO A FIN.
 *
 * Todo lo que toca la base entra por `deps`, así que el orden de las
 * decisiones — que es el diseño — se prueba entero sin base:
 *
 *   1. Apagado → no es asunto de este módulo (la ruta contesta como antes).
 *   2. Repetido (mismo id de WhatsApp) → nada.
 *   3. Baja → se respeta y se confirma UNA vez. Dada de baja → silencio,
 *      salvo «ACTIVAR».
 *   4. Ya con una persona → el bot no se mete; acusa recibo una vez por hora.
 *   5. Techo por hora → pasa a una persona y se calla.
 *   6. Fuera de horario sin bot → aviso de horario, una vez cada 12 h.
 *   7. La intención: lo que sale de datos se contesta con datos; lo demás —
 *      o lo que no se entendió — pasa a una persona.
 *
 * LA REGLA QUE NO SE NEGOCIA: saldo y facturas sólo salen para un cliente
 * IDENTIFICADO (su teléfono es el de un contacto de ese cliente y de ningún
 * otro) o VERIFICADO (escribió un NIT y una factura que son del mismo
 * cliente). La guía o el pedido se contesta con su número — como la página de
 * rastreo de una transportadora — y sólo con el estado y la fecha; si quien
 * escribe ya está identificado y la fila es de otro cliente, «no la encontré».
 */

export interface InboundCustomerMessage {
  phone: string;
  jid: string;
  pushName: string | null;
  text: string;
  messageId: string | null;
}

export interface RecentReply {
  intent: string | null;
  created_at: string;
}

export type EscalationReason =
  | 'cotizacion'
  | 'queja'
  | 'persona'
  | 'otro'
  | 'limite'
  | 'verificacion'
  | 'no_compartido'
  | 'error';

export interface CustomerDeps {
  now(): Date;
  settings(): Promise<CustomerSettings>;
  /** La conversación viva de este número, o una nueva. */
  conversation(input: InboundCustomerMessage): Promise<ConversationRow>;
  /** Guarda lo que escribió. `duplicate` si ese id de WhatsApp ya estaba. */
  recordInbound(
    conv: ConversationRow,
    msg: { text: string; intent: string; waMessageId: string | null },
  ): Promise<'ok' | 'duplicate'>;
  recordOutbound(
    conv: ConversationRow,
    msg: { text: string; intent: string; sources: MessageSource[] },
  ): Promise<void>;
  patchConversation(id: string, patch: Partial<ConversationRow>): Promise<void>;
  /** Respuestas del bot en esta conversación desde `sinceIso`, la más reciente primero. */
  botRepliesSince(conversationId: string, sinceIso: string): Promise<RecentReply[]>;
  clientByPhone(phone: string): Promise<PhoneMatch>;
  /** El cliente cuyo NIT es `nit` Y que tiene la factura `invoice`; null si no cuadran. */
  verifyClaim(nit: string, invoice: string): Promise<{ clientId: string } | null>;
  clientName(clientId: string): Promise<string | null>;
  /** Las facturas de ese cliente. LANZA si no se pudieron leer: «sin facturas» y «no sé» no son lo mismo. */
  invoices(clientId: string): Promise<ClientInvoice[]>;
  findOrder(
    sources: readonly OrderSource[],
    number: string,
    clientId: string | null,
  ): Promise<OrderFact | null>;
  /** Pasa la conversación a una persona: estado, trabajo y aviso. */
  escalate(
    conv: ConversationRow,
    input: { reason: EscalationReason; intent: string; preview: string },
  ): Promise<void>;
}

export type CustomerOutcome =
  | { handled: false }
  | {
      handled: true;
      reply: string | null;
      conversationId: string;
      intent: string;
      escalated: boolean;
      /** Para el registro y las pruebas: por qué esta salida. */
      why: string;
    };

const HOUR = 60 * 60 * 1000;
const VERIFIED_FOR_MS = 24 * HOUR;
export const MAX_VERIFY_ATTEMPTS = 3;

export async function handleCustomerMessage(
  deps: CustomerDeps,
  input: InboundCustomerMessage,
): Promise<CustomerOutcome> {
  const settings = await deps.settings();
  if (!settings.enabled) return { handled: false };

  const now = deps.now();
  const text = input.text.trim().slice(0, 4000);
  let conv = await deps.conversation(input);

  // --- ¿Qué pide? ---------------------------------------------------------
  let cls: Classification = classify(text, settings.faq);
  const pending = conv.verification === 'pendiente';
  const claim = pending ? verificationClaim(text) : null;
  if (claim) cls = { intent: 'verificacion', confidence: 'alta', faq: null };
  // Se le pidió el número de guía y contestó sólo el número.
  const pendingOrder =
    conv.pending_intent === 'estado_pedido' &&
    (cls.intent === 'otro' || cls.intent === 'estado_pedido')
      ? (extractOrderNumber(text) ?? extractBareReference(text))
      : null;
  if (pendingOrder) cls = { intent: 'estado_pedido', confidence: 'alta', faq: null };

  const stored = await deps.recordInbound(conv, {
    text: text || '(sin texto)',
    intent: cls.intent,
    waMessageId: input.messageId,
  });
  if (stored === 'duplicate') {
    return out(conv, null, cls.intent, false, 'mensaje repetido');
  }

  const say = async (answer: Answer, intent: string, why: string, escalated = false) => {
    await deps.recordOutbound(conv, { text: answer.text, intent, sources: answer.sources });
    return out(conv, answer.text, intent, escalated, why);
  };

  // --- Baja y alta ---------------------------------------------------------
  if (cls.intent === 'baja') {
    await deps.patchConversation(conv.id, { opted_out: true, opted_out_at: now.toISOString() });
    return say(OPT_OUT_ACK, 'baja', 'pidió la baja');
  }
  if (conv.opted_out) {
    if (cls.intent !== 'alta') return out(conv, null, cls.intent, false, 'dado de baja');
    await deps.patchConversation(conv.id, { opted_out: false, opted_out_at: null });
    conv = { ...conv, opted_out: false };
    return say(OPT_IN_ACK, 'alta', 'volvió a activar');
  }

  // --- Ya la tiene una persona ---------------------------------------------
  if (conv.status === 'escalada') {
    const lastHour = await deps.botRepliesSince(conv.id, iso(now, -HOUR));
    if (lastHour.some((r) => r.intent === 'acuse')) {
      return out(conv, null, cls.intent, true, 'con una persona; ya se acusó recibo');
    }
    return say(ESCALATED_ACK, 'acuse', 'con una persona: acuse de recibo', true);
  }

  // --- Ritmo ---------------------------------------------------------------
  const recent = await deps.botRepliesSince(conv.id, iso(now, -12 * HOUR));
  const lastHourCount = recent.filter(
    (r) => Date.parse(r.created_at) >= now.getTime() - HOUR,
  ).length;
  const open = isWithinHours(settings.businessHours, settings.timeZone, now);
  const next = open ? null : nextOpening(settings.businessHours, settings.timeZone, now);
  const handoff = async (reason: EscalationReason, intent: string, why: string) => {
    await deps.escalate(conv, { reason, intent, preview: text.slice(0, 280) });
    return say(
      handoffAnswer({
        reason: reason === 'verificacion' ? 'otro' : reason,
        open,
        nextOpening: next,
        team: settings.escalationTeam,
      }),
      intent,
      why,
      true,
    );
  };

  if (!underRateLimit(lastHourCount, settings.maxRepliesPerHour)) {
    return handoff('limite', cls.intent, 'llegó al techo de respuestas por hora');
  }

  // --- Fuera de horario, sin bot -------------------------------------------
  if (!open && !settings.botAfterHours) {
    if (recent.some((r) => r.intent === 'fuera_horario')) {
      return out(conv, null, cls.intent, false, 'fuera de horario; ya se avisó');
    }
    return say(afterHoursAnswer(settings, next), 'fuera_horario', 'fuera de horario');
  }

  // --- La intención --------------------------------------------------------
  switch (cls.intent) {
    case 'saludo':
    case 'alta':
      return say(greetingAnswer(settings, input.pushName), 'saludo', 'saludo');
    case 'gracias':
      return say(THANKS_ACK, 'gracias', 'agradecimiento');
    case 'faq':
      return cls.faq
        ? say(faqAnswer(cls.faq), 'faq', 'pregunta frecuente aprobada')
        : handoff('otro', 'faq', 'pregunta frecuente sin respuesta');
    case 'empresa': {
      const answer = companyAnswer(settings);
      return answer
        ? say(answer, 'empresa', 'datos públicos de la empresa')
        : handoff('otro', 'empresa', 'no hay datos públicos configurados');
    }
    case 'cotizacion':
      return handoff('cotizacion', 'cotizacion', 'cotización: a una persona');
    case 'queja':
      return handoff('queja', 'queja', 'queja: a una persona');
    case 'persona':
      return handoff('persona', 'persona', 'pidió una persona');
    case 'estado_pedido':
      return orderStatus();
    case 'saldo':
    case 'facturas':
      return clientData(cls.intent);
    case 'verificacion':
      return verification();
    default:
      return handoff('otro', cls.intent, 'no se entendió con seguridad');
  }

  // --- Pedidos y guías -----------------------------------------------------
  async function orderStatus(): Promise<CustomerOutcome> {
    if (!settings.shareOrderStatus || settings.orderSources.length === 0) {
      return handoff('no_compartido', 'estado_pedido', 'estado de pedido no habilitado');
    }
    const number = pendingOrder ?? extractOrderNumber(text);
    if (!number) {
      await deps.patchConversation(conv.id, { pending_intent: 'estado_pedido' });
      return say(ASK_ORDER_NUMBER, 'estado_pedido', 'falta el número');
    }
    const identified = await identifiedClient();
    let fact: OrderFact | null;
    try {
      fact = await deps.findOrder(
        settings.orderSources,
        number,
        identified.kind === 'ok' ? identified.clientId : null,
      );
    } catch {
      return handoff('error', 'estado_pedido', 'no se pudo leer la tabla de pedidos');
    }
    await deps.patchConversation(conv.id, { pending_intent: null });
    return fact
      ? say(orderAnswer(fact), 'estado_pedido', 'estado leído de la tabla')
      : say(orderNotFound(number), 'estado_pedido', 'número no encontrado');
  }

  // --- Saldo y facturas ----------------------------------------------------
  async function clientData(intent: 'saldo' | 'facturas'): Promise<CustomerOutcome> {
    const allowed = intent === 'saldo' ? settings.shareBalance : settings.shareInvoices;
    if (!allowed) return handoff('no_compartido', intent, `${intent} no habilitado`);
    const who = await identifiedClient();
    if (who.kind === 'blocked') return handoff('verificacion', intent, 'verificación bloqueada');
    if (who.kind === 'ask') {
      await deps.patchConversation(conv.id, {
        verification: 'pendiente',
        client_id: null,
        pending_intent: intent,
      });
      return say(ASK_VERIFICATION, intent, 'pidió NIT y factura');
    }
    return answerClientData(intent, who.clientId);
  }

  async function answerClientData(
    intent: 'saldo' | 'facturas',
    clientId: string,
  ): Promise<CustomerOutcome> {
    let invoices: ClientInvoice[];
    let name: string | null;
    try {
      [invoices, name] = await Promise.all([deps.invoices(clientId), deps.clientName(clientId)]);
    } catch {
      return handoff('error', intent, 'no se pudieron leer las facturas');
    }
    const clientName = name ?? 'Tu empresa';
    const answer =
      intent === 'saldo'
        ? balanceAnswer(clientName, invoices)
        : invoicesAnswer(clientName, invoices);
    await deps.patchConversation(conv.id, { pending_intent: null });
    return say(answer, intent, `${intent} de su cliente`);
  }

  async function verification(): Promise<CustomerOutcome> {
    const attempt = claim as { nit: string; invoice: string };
    const match = await deps.verifyClaim(attempt.nit, attempt.invoice);
    if (!match) {
      const attempts = conv.verify_attempts + 1;
      const left = MAX_VERIFY_ATTEMPTS - attempts;
      if (left <= 0) {
        await deps.patchConversation(conv.id, {
          verification: 'bloqueada',
          verify_attempts: attempts,
          pending_intent: null,
        });
        conv = { ...conv, verification: 'bloqueada', verify_attempts: attempts };
        await deps.escalate(conv, {
          reason: 'verificacion',
          intent: 'verificacion',
          preview: 'Falló la verificación tres veces.',
        });
        return say(verificationFailed(0), 'verificacion', 'verificación bloqueada', true);
      }
      await deps.patchConversation(conv.id, { verify_attempts: attempts });
      return say(verificationFailed(left), 'verificacion', 'verificación fallida');
    }
    const wanted = conv.pending_intent;
    await deps.patchConversation(conv.id, {
      client_id: match.clientId,
      verification: 'verificado',
      verified_until: iso(now, VERIFIED_FOR_MS),
      verify_attempts: 0,
      pending_intent: null,
    });
    conv = {
      ...conv,
      client_id: match.clientId,
      verification: 'verificado',
      verified_until: iso(now, VERIFIED_FOR_MS),
    };
    if (wanted === 'saldo' || wanted === 'facturas')
      return answerClientData(wanted, match.clientId);
    const name = (await deps.clientName(match.clientId).catch(() => null)) ?? 'tu empresa';
    return say(
      { text: `Listo, ya confirmé que nos escribes de ${name}. ¿Qué necesitas?`, sources: [] },
      'verificacion',
      'verificado sin pregunta pendiente',
    );
  }

  /**
   * ¿De qué cliente es quien escribe? Para saldo y facturas, `ask` significa
   * pedir verificación; para una guía basta con saber si se sabe.
   */
  async function identifiedClient(): Promise<
    { kind: 'ok'; clientId: string } | { kind: 'ask' } | { kind: 'blocked' }
  > {
    if (conv.verification === 'bloqueada') return { kind: 'blocked' };
    if (
      conv.client_id &&
      conv.verification === 'verificado' &&
      conv.verified_until &&
      Date.parse(conv.verified_until) > now.getTime()
    ) {
      return { kind: 'ok', clientId: conv.client_id };
    }
    // El teléfono se vuelve a mirar cada vez: si a ese contacto lo quitaron del
    // cliente, deja de abrir su información desde ese mismo momento.
    const match = await deps.clientByPhone(input.phone);
    if (match.kind === 'one') {
      if (conv.client_id !== match.clientId || conv.verification !== 'telefono') {
        await deps.patchConversation(conv.id, {
          client_id: match.clientId,
          contact_id: match.contactId,
          verification: 'telefono',
        });
        conv = {
          ...conv,
          client_id: match.clientId,
          contact_id: match.contactId,
          verification: 'telefono',
        };
      }
      return { kind: 'ok', clientId: match.clientId };
    }
    if (conv.verification === 'telefono') {
      await deps.patchConversation(conv.id, {
        client_id: null,
        contact_id: null,
        verification: 'ninguna',
      });
      conv = { ...conv, client_id: null, contact_id: null, verification: 'ninguna' };
    }
    return { kind: 'ask' };
  }
}

/** El NIT y la factura de un mensaje que contesta a «mándame el NIT y una factura». */
export function verificationClaim(text: string): { nit: string; invoice: string } | null {
  const nit = extractNit(text, { loose: true }) ?? looseNit(text);
  if (!nit) return null;
  const nitDigits = nit.replace(/-\d$/, '');
  let invoice = extractInvoiceNumber(text);
  if (!invoice) {
    // «900123456 1234»: el otro número es la factura.
    const others = [...text.matchAll(/(?<![\w.-])([a-z]{0,5}-?\d{2,12})(?![\w.-])/gi)]
      .map((m) => m[1] as string)
      .filter((t) => t.replace(/\D/g, '') !== nitDigits && !nit.startsWith(t.replace(/\D/g, '')));
    invoice = others[0]?.toUpperCase() ?? null;
  }
  return invoice ? { nit, invoice } : null;
}

/** Un NIT sin la palabra «NIT»: 9 o 10 dígitos seguidos. Sólo cuando se pidió. */
function looseNit(text: string): string | null {
  const m = /(?<![\w.-])(\d{9,10})(?![\w.-])/.exec(text);
  return m?.[1] ?? null;
}

function iso(now: Date, offsetMs: number): string {
  return new Date(now.getTime() + offsetMs).toISOString();
}

function out(
  conv: ConversationRow,
  reply: string | null,
  intent: Intent | string,
  escalated: boolean,
  why: string,
): CustomerOutcome {
  return { handled: true, reply, conversationId: conv.id, intent, escalated, why };
}
