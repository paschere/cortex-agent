import { NotFoundError } from '@cortex/core';
import { z } from 'zod';
import {
  KIND_LABEL,
  STATE_LABEL,
  bogotaToday,
  daysBetween,
  whenPhrase,
} from '../commitments/shape';
import { registerTool } from '../index';
import { cop } from './hub';
import { loadClient360 } from './hub-read';
import {
  adaptClient,
  adaptContact,
  adaptLink,
  clientSchema,
  contactSchema,
  linkSchema,
} from './shape';
import { listLinks, searchClients } from './store';

/**
 * La ficha del cliente, como algo que el modelo puede decir.
 *
 * «¿Cómo va Nexa?» se contesta con UNA llamada: quién es (NIT, responsable,
 * contactos), cómo está en plata (facturado en el año, saldo, vencido, cuánto
 * se demora en pagar, lo recuperado con Cortex, lo que se espera cobrar), lo
 * abierto (cartera, compromisos, casos, trabajo) y lo último que pasó (correos,
 * cobros, reuniones, WhatsApp, notas). Nada es memoria nueva: todo ya estaba
 * guardado; la descripción lo dice para que el modelo no invente lo que falta.
 * Lo que no se pudo leer viene como «sin dato», nunca como cero.
 */
export const clientsOverview = registerTool({
  id: 'clients.overview',
  description:
    'Everything Cortex already holds about one client, in one place — use it for "¿cómo va Nexa?", "resume a Coltrans", "qué nos debe X". Returns who they are (NIT, owner, contacts), how they stand on money (invoiced in the last 12 months, balance owed, overdue, average days to pay, money recovered by Cortex, collections expected from the cash forecast), a plain-words health status, what is open (receivables, commitments, cases, team work) and the recent timeline (invoices, payments, emails, collection emails, meetings, WhatsApp, notes). Takes a client id, or a name or NIT resolved like clients.search. Only says what is stored: a section that could not be read comes back as "sin dato", never as zero.',
  inputSchema: z.object({
    client: z
      .string()
      .min(2)
      .describe('The client id, or its name or NIT — whatever the person said'),
    includeProposals: z
      .boolean()
      .default(true)
      .describe('Include the links Cortex proposed but nobody has confirmed yet'),
  }),
  outputSchema: z.object({
    client: clientSchema,
    contacts: z.array(contactSchema),
    domains: z.array(z.string()).describe('Email domains registered as belonging to this client'),
    health: z.object({ label: z.string(), reason: z.string(), tone: z.string() }),
    money: z
      .object({
        invoiced12m: z.number(),
        outstanding: z.number(),
        overdue: z.number(),
        maxDaysOverdue: z.number().nullable(),
        averageDaysToPay: z.number().nullable(),
        nextDue: z.object({ on: z.string(), amount: z.number() }).nullable(),
        otherCurrencies: z.array(z.string()),
      })
      .nullable()
      .describe('Pesos only; null when the invoices or payments could not be read'),
    recoveredCop: z.number().nullable().describe('Money recovered with Cortex for this client'),
    expected: z
      .array(z.object({ date: z.string(), amount: z.number(), reason: z.string() }))
      .describe('Collections the cash forecast expects from this client'),
    commitments: z.array(
      z.object({
        title: z.string(),
        kind: z.string(),
        dueOn: z.string(),
        state: z.string(),
        amountCop: z.number().nullable(),
      }),
    ),
    recent: z
      .array(
        z.object({
          kind: z.string(),
          at: z.string(),
          title: z.string(),
          detail: z.string().nullable(),
        }),
      )
      .describe('The latest things that happened with this client, newest first'),
    links: z.array(linkSchema).describe('What has been attached to this client, newest first'),
    proposals: z
      .array(linkSchema)
      .describe('Attachments Cortex suggested that nobody has confirmed — not facts yet'),
    href: z.string(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 40 },
  handler: async (input, ctx) => {
    const clientId = await resolveClientRef(ctx.db, input.client);
    const today = bogotaToday();
    const [hub, links, proposalRows] = await Promise.all([
      loadClient360(ctx.db, clientId, { today }),
      listLinks(ctx.db, { clientId, state: 'confirmed', limit: 300 }),
      input.includeProposals === false
        ? Promise.resolve([])
        : listLinks(ctx.db, { clientId, state: 'suggested', limit: 100 }),
    ]);
    if (!hub) throw new NotFoundError('Ese cliente ya no existe.');

    const client = adaptClient(hub.client);
    const contacts = hub.contacts.map(adaptContact);
    const openCommitments = hub.open.commitments.ok ? hub.open.commitments.data : [];
    const commitments = openCommitments.map((c) => ({
      title: c.title,
      kind: KIND_LABEL[c.kind as keyof typeof KIND_LABEL] ?? c.kind,
      dueOn: c.dueOn,
      state: STATE_LABEL[c.state as keyof typeof STATE_LABEL] ?? c.state,
      amountCop: c.amountCop,
    }));
    const money = hub.money.ok ? hub.money.data : null;
    const recent = hub.timeline.ok
      ? hub.timeline.data
          .filter((t) => t.at.slice(0, 10) <= today)
          .slice(0, 12)
          .map((t) => ({
            kind: t.kind,
            at: t.at.slice(0, 10),
            title: t.title,
            detail: t.detail ?? null,
          }))
      : [];
    const expected = hub.expected.ok
      ? hub.expected.data.map((e) => ({
          date: e.expectedDate,
          amount: e.expectedAmount,
          reason: e.reason,
        }))
      : [];
    const recoveredCop = hub.recovered.ok ? hub.recovered.data.total : null;

    const lines: string[] = [];
    lines.push(
      `**${client.name}**${client.nit ? ` — NIT ${client.nit}` : ''} · ${client.statusLabel}`,
    );
    lines.push(`**Cómo va:** ${hub.health.label}. ${hub.health.reason}`);
    if (client.owner) lines.push(`Responsable acá: ${client.owner}`);
    if (client.tags.length) lines.push(`Etiquetas: ${client.tags.join(', ')}`);

    lines.push('', '**La plata**');
    if (!money) {
      lines.push('- Sin dato: no pude leer sus facturas o pagos.');
    } else {
      lines.push(
        `- Facturado en 12 meses: ${cop(money.invoiced12m)} (${money.invoiced12mCount} facturas)`,
      );
      lines.push(
        `- Saldo por cobrar: ${cop(money.outstanding)}${money.overdue > 0 ? `, de eso vencido ${cop(money.overdue)} (la más vieja hace ${money.maxDaysOverdue} días)` : ', nada vencido'}`,
      );
      lines.push(
        money.paymentDays
          ? `- Paga en promedio a ${money.paymentDays.average} días de emitida la factura (sobre ${money.paymentDays.sample} facturas pagadas)`
          : '- Días de pago: sin dato (no hay facturas pagadas con fecha de pago)',
      );
      if (money.nextDue)
        lines.push(`- Próximo vencimiento: ${money.nextDue.on} por ${cop(money.nextDue.amount)}`);
      if (money.otherCurrencies.length)
        lines.push(
          `- También tiene facturas en ${money.otherCurrencies.join(', ')}, que no se suman a los pesos`,
        );
    }
    if (recoveredCop != null && recoveredCop > 0)
      lines.push(`- Recuperado con Cortex: ${cop(recoveredCop)}`);
    if (expected.length) {
      lines.push(
        `- La proyección de caja espera cobrarle ${cop(expected.reduce((s, e) => s + e.amount, 0))} en las próximas semanas (primero el ${expected[0]?.date})`,
      );
    }

    if (contacts.length > 0) {
      lines.push('', '**Con quién se habla ahí**');
      for (const c of contacts.slice(0, 6)) {
        lines.push(
          `- ${c.name}${c.role ? ` · ${c.role}` : ''}${c.email ? ` · ${c.email}` : ''}${c.isPrimary ? ' (principal)' : ''}`,
        );
      }
    }

    const cases = hub.open.cases.ok ? hub.open.cases.data : [];
    const work = hub.open.work.ok ? hub.open.work.data : [];
    if (openCommitments.length || cases.length || work.length) {
      lines.push('', '**Lo abierto**');
      for (const c of openCommitments.slice(0, 6)) {
        lines.push(
          `- Compromiso: ${c.title} — ${c.dueOn} (${whenPhrase(daysBetween(today, c.dueOn))})${c.amountCop ? ` · ${cop(c.amountCop)}` : ''}`,
        );
      }
      for (const k of cases.slice(0, 4))
        lines.push(`- Caso: ${k.title}${k.why ? ` (${k.why})` : ''}`);
      for (const w of work.slice(0, 4))
        lines.push(`- Trabajo: ${w.title}${w.assignee ? ` — ${w.assignee}` : ''}`);
    }

    if (recent.length) {
      lines.push('', '**Lo último**');
      for (const t of recent.slice(0, 8))
        lines.push(`- ${t.at}: ${t.title}${t.detail ? ` — ${t.detail}` : ''}`);
    }

    const proposals = proposalRows.map(adaptLink);
    if (proposals.length > 0) {
      lines.push(
        '',
        `**${proposals.length} propuesta${proposals.length === 1 ? '' : 's'} sin confirmar** — Cortex cree que son de este cliente pero nadie lo ha revisado, así que no cuentan.`,
      );
    }
    lines.push('', `Ficha completa: /clients/${clientId}`);

    return {
      client,
      contacts,
      domains: hub.domains.map((d) => d.domain),
      health: { label: hub.health.label, reason: hub.health.reason, tone: hub.health.tone },
      money: money
        ? {
            invoiced12m: money.invoiced12m,
            outstanding: money.outstanding,
            overdue: money.overdue,
            maxDaysOverdue: money.maxDaysOverdue,
            averageDaysToPay: money.paymentDays?.average ?? null,
            nextDue: money.nextDue ? { on: money.nextDue.on, amount: money.nextDue.amount } : null,
            otherCurrencies: money.otherCurrencies,
          }
        : null,
      recoveredCop,
      expected,
      commitments,
      recent,
      links: links.map(adaptLink),
      proposals,
      href: `/clients/${clientId}`,
      markdown: lines.join('\n'),
    };
  },
});

/**
 * A client id from whatever the person said.
 *
 * Refuses on ambiguity rather than picking the first hit. Answering about the
 * wrong Coltrans is the same failure as linking a document to it — a confident
 * report about a company nobody asked about.
 */
export async function resolveClientRef(
  db: Parameters<typeof searchClients>[0],
  query: string,
): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.trim())) {
    return query.trim();
  }
  const hits = await searchClients(db, query, 5);
  if (hits.length === 0) {
    throw new NotFoundError(
      `No hay ningún cliente que empareje con "${query}". Búscalo con clients.search o regístralo con clients.register.`,
    );
  }
  if (hits.length > 1) {
    throw new NotFoundError(
      `"${query}" empareja con más de un cliente: ${hits.map((h) => h.client.name).join(', ')}. Pregunta cuál antes de seguir.`,
    );
  }
  return (hits[0] as (typeof hits)[number]).client.id;
}
