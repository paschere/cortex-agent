import type { ClientInvoice } from '../../clients/hub';
import { describeHours } from './classify';
import type { CustomerSettings, FaqEntry, MessageSource } from './shape';

/**
 * LAS RESPUESTAS — PLANTILLAS, Y CADA CIFRA SALE DE UNA FILA.
 *
 * Ninguna función de aquí inventa un número: reciben las facturas, la fila de
 * la guía o el texto que la empresa escribió, y lo dicen. Cada respuesta trae
 * sus `sources` — de qué factura, de qué fila — y eso es lo que la pantalla de
 * atención enseña al lado de la burbuja, para que una persona pueda comprobar
 * lo que se le dijo al cliente sin preguntarle al bot.
 */

export interface Answer {
  text: string;
  sources: MessageSource[];
}

const MAX_INVOICES_LISTED = 5;

function money(amount: number, currency: string): string {
  const rounded = Math.round(amount).toLocaleString('es-CO');
  return currency === 'COP' ? `$${rounded}` : `${currency} ${rounded}`;
}

/** «15 de octubre de 2026» a partir de «2026-10-15». */
export function spokenDate(iso: string | null | undefined): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  const months = [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre',
  ];
  return `${d} de ${months[m - 1]} de ${y}`;
}

function invoiceSource(inv: ClientInvoice): MessageSource {
  return { kind: 'invoice', id: inv.id, label: inv.docNumber ?? 'Factura sin número' };
}

function invoiceLine(inv: ClientInvoice): string {
  const number = inv.docNumber ? `*${inv.docNumber}*` : 'Factura sin número';
  const due = inv.daysOverdue
    ? `vencida hace ${inv.daysOverdue} día${inv.daysOverdue === 1 ? '' : 's'}`
    : inv.dueOn
      ? `vence el ${spokenDate(inv.dueOn)}`
      : 'sin fecha de vencimiento';
  return `• ${number}: ${money(inv.balance, inv.currency)} por pagar, ${due}`;
}

/** Las facturas abiertas, la más vencida primero, y lo cerrado fuera. */
export function openInvoices(invoices: readonly ClientInvoice[]): ClientInvoice[] {
  return invoices
    .filter((i) => i.balance > 0)
    .sort(
      (a, b) =>
        (b.daysOverdue ?? -1) - (a.daysOverdue ?? -1) ||
        (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'),
    );
}

/**
 * El saldo de ESE cliente. Pesos sumados; otra moneda se dice aparte y no se
 * suma, igual que en la ficha del cliente.
 */
export function balanceAnswer(clientName: string, invoices: readonly ClientInvoice[]): Answer {
  const open = openInvoices(invoices);
  if (open.length === 0) {
    return {
      text: `${clientName} no tiene facturas pendientes de pago con nosotros. ✅`,
      sources: [{ kind: 'client', id: clientName, label: 'Sin facturas abiertas' }],
    };
  }
  const byCurrency = new Map<string, { total: number; overdue: number; count: number }>();
  for (const inv of open) {
    const acc = byCurrency.get(inv.currency) ?? { total: 0, overdue: 0, count: 0 };
    acc.total += inv.balance;
    acc.count += 1;
    if (inv.daysOverdue) acc.overdue += inv.balance;
    byCurrency.set(inv.currency, acc);
  }
  const lines: string[] = [];
  const currencies = [...byCurrency.keys()].sort((a, b) =>
    a === 'COP' ? -1 : b === 'COP' ? 1 : a.localeCompare(b),
  );
  for (const currency of currencies) {
    const c = byCurrency.get(currency) as { total: number; overdue: number; count: number };
    lines.push(
      `El saldo pendiente de ${clientName} es *${money(c.total, currency)}* en ${c.count} factura${c.count === 1 ? '' : 's'}${
        c.overdue > 0 ? `; de eso, ${money(c.overdue, currency)} ya está vencido` : ''
      }.`,
    );
  }
  const listed = open.slice(0, MAX_INVOICES_LISTED);
  lines.push('', ...listed.map(invoiceLine));
  if (open.length > listed.length) {
    lines.push(`…y ${open.length - listed.length} más.`);
  }
  return { text: lines.join('\n'), sources: open.map(invoiceSource) };
}

/** Las facturas abiertas de ESE cliente, una por línea. */
export function invoicesAnswer(clientName: string, invoices: readonly ClientInvoice[]): Answer {
  const open = openInvoices(invoices);
  if (open.length === 0) {
    return {
      text: `${clientName} no tiene facturas pendientes de pago con nosotros. ✅`,
      sources: [{ kind: 'client', id: clientName, label: 'Sin facturas abiertas' }],
    };
  }
  const overdue = open.filter((i) => i.daysOverdue).length;
  const listed = open.slice(0, MAX_INVOICES_LISTED);
  const head = `${clientName} tiene ${open.length} factura${open.length === 1 ? '' : 's'} pendiente${open.length === 1 ? '' : 's'}${
    overdue ? ` (${overdue} vencida${overdue === 1 ? '' : 's'})` : ''
  }:`;
  const lines = [head, ...listed.map(invoiceLine)];
  if (open.length > listed.length) lines.push(`…y ${open.length - listed.length} más.`);
  return { text: lines.join('\n'), sources: open.map(invoiceSource) };
}

export interface OrderFact {
  sourceLabel: string;
  rowId: string;
  number: string;
  status: string;
  eta: string | null;
  updatedAt: string | null;
}

/** El estado de una guía o pedido: el estado, la fecha estimada si la hay, y nada más de la fila. */
export function orderAnswer(fact: OrderFact): Answer {
  const updated = spokenDate(fact.updatedAt);
  const eta = /^\d{4}-\d{2}-\d{2}/.test(fact.eta ?? '') ? spokenDate(fact.eta) : fact.eta;
  const lines = [
    `${singular(fact.sourceLabel)} *${fact.number}*: *${fact.status}*.`,
    eta ? `Entrega estimada: ${eta}.` : '',
    updated ? `_Actualizado el ${updated}._` : '',
  ].filter(Boolean);
  return {
    text: lines.join('\n'),
    sources: [{ kind: 'order', id: fact.rowId, label: `${fact.sourceLabel} ${fact.number}` }],
  };
}

function singular(label: string): string {
  const l = label.trim();
  if (/^gu[ií]as$/i.test(l)) return 'Guía';
  if (/^pedidos$/i.test(l)) return 'Pedido';
  if (/^(ordenes|órdenes)$/i.test(l)) return 'Orden';
  if (/^despachos$/i.test(l)) return 'Despacho';
  return l.replace(/s$/, '') || 'Pedido';
}

export function orderNotFound(number: string): Answer {
  return {
    text: `No encontré la guía o pedido *${number}*. ¿Lo revisas y me lo escribes otra vez? Si prefieres, escribe «asesor» y te paso con una persona.`,
    sources: [],
  };
}

export const ASK_ORDER_NUMBER: Answer = {
  text: '¿Me compartes el número de guía o de pedido? Con eso te digo cómo va.',
  sources: [],
};

export const ASK_VERIFICATION: Answer = {
  text: 'Para darte esa información primero necesito confirmar de qué empresa nos escribes. Mándame el *NIT* y el *número de una de sus facturas*, por ejemplo: NIT 900123456, factura FV-1234.',
  sources: [],
};

export function verificationFailed(attemptsLeft: number): Answer {
  return {
    text:
      attemptsLeft > 0
        ? 'No logré confirmar esos datos. Revisa el NIT y el número de factura y escríbemelos otra vez.'
        : 'No logré confirmar esos datos. Para cuidar la información de nuestros clientes, te paso con una persona del equipo.',
    sources: [],
  };
}

export function greetingAnswer(settings: CustomerSettings, pushName: string | null): Answer {
  if (settings.greeting) return { text: settings.greeting, sources: [] };
  const name = pushName?.trim().split(/\s+/)[0];
  const can: string[] = [];
  if (settings.shareOrderStatus && settings.orderSources.length > 0)
    can.push('el estado de tu pedido o guía');
  if (settings.shareInvoices) can.push('tus facturas');
  if (settings.shareBalance) can.push('tu saldo');
  const what =
    can.length === 0
      ? '¿En qué te ayudo?'
      : `Puedo ayudarte con ${can.length === 1 ? can[0] : `${can.slice(0, -1).join(', ')} y ${can[can.length - 1]}`}. ¿Qué necesitas?`;
  return {
    text: `Hola${name ? `, ${name}` : ''} 👋. Soy el asistente de atención. ${what}`,
    sources: [],
  };
}

export function companyAnswer(settings: CustomerSettings): Answer | null {
  if (!settings.shareCompanyInfo) return null;
  const hours = describeHours(settings.businessHours);
  const parts = [settings.companyInfo ?? '', hours ? `Horario de atención: ${hours}.` : ''].filter(
    Boolean,
  );
  if (parts.length === 0) return null;
  return {
    text: parts.join('\n\n'),
    sources: [{ kind: 'company', id: 'company_info', label: 'Datos públicos de la empresa' }],
  };
}

export function faqAnswer(entry: FaqEntry): Answer {
  return { text: entry.a, sources: [{ kind: 'faq', id: entry.q.slice(0, 80), label: entry.q }] };
}

/** «Te paso con una persona», con cuándo, si se sabe. */
export function handoffAnswer(input: {
  reason: 'cotizacion' | 'queja' | 'persona' | 'otro' | 'limite' | 'no_compartido' | 'error';
  open: boolean;
  nextOpening: string | null;
  team: string | null;
}): Answer {
  const who = input.team ? `alguien de ${input.team}` : 'una persona del equipo';
  const lead: Record<typeof input.reason, string> = {
    cotizacion: `Para cotizar te paso con ${who}.`,
    queja: `Lamento lo que pasó. Te paso con ${who} para que lo revise.`,
    persona: `Claro, te paso con ${who}.`,
    otro: `Eso prefiero que te lo responda ${who}. Te paso con una persona.`,
    limite: `Te paso con ${who} para seguir la conversación.`,
    no_compartido: `Esa información no la puedo compartir por aquí. Te paso con ${who}.`,
    error: `No pude consultar eso en este momento. Te paso con ${who}.`,
  };
  const when = input.open
    ? 'Te responde por este mismo chat.'
    : input.nextOpening
      ? `Estamos fuera de horario: te responden ${input.nextOpening}, por este mismo chat.`
      : 'Te responde por este mismo chat apenas pueda.';
  return { text: `${lead[input.reason]} ${when}`, sources: [] };
}

export function afterHoursAnswer(settings: CustomerSettings, next: string | null): Answer {
  if (settings.afterHoursMessage) return { text: settings.afterHoursMessage, sources: [] };
  return {
    text: `Gracias por escribirnos. En este momento estamos fuera de horario${
      next ? `; te respondemos ${next}` : ''
    }. Tu mensaje quedó registrado.`,
    sources: [],
  };
}

export const ESCALATED_ACK: Answer = {
  text: 'Tu mensaje ya le llegó a la persona que te está atendiendo. Te responde por aquí.',
  sources: [],
};

export const OPT_OUT_ACK: Answer = {
  text: 'Listo. No te volveremos a escribir por aquí. Si más adelante nos necesitas, escribe *ACTIVAR*.',
  sources: [],
};

export const OPT_IN_ACK: Answer = {
  text: 'Listo, quedó activado otra vez. ¿En qué te ayudo?',
  sources: [],
};

export const THANKS_ACK: Answer = { text: 'Con gusto. 🙌', sources: [] };
