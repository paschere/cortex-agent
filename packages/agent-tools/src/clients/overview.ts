import { NotFoundError } from '@cortex/core';
import { z } from 'zod';
import { KIND_LABEL, STATE_LABEL, cop, whenPhrase } from '../commitments/shape';
import { bogotaToday, daysBetween } from '../commitments/shape';
import { registerTool } from '../index';
import {
  ENTITY_KIND_LABEL,
  type LinkEntityKind,
  adaptClient,
  adaptContact,
  adaptLink,
  clientSchema,
  contactSchema,
  linkSchema,
} from './shape';
import { clientOverview, searchClients } from './store';

/**
 * The client card, as a sentence the model can say.
 *
 * This is the tool that justifies the whole module: "¿qué tenemos de Coltrans?"
 * used to be four separate lookups and an act of memory, and it is now one
 * call. Nothing it returns is new — every document, meeting, group and deadline
 * was already stored — so the tool description says so, because a model told it
 * is retrieving "the client's information" will happily invent the parts it
 * cannot find.
 */
export const clientsOverview = registerTool({
  id: 'clients.overview',
  description:
    'Everything Cortex already holds about one client, in one place: its details and NIT, who is spoken to there, the deadlines with them, and the emails, meetings, documents and WhatsApp groups that have been attached to them. Takes a client id, or a name or NIT which it resolves the same way clients.search does. Only says what is stored — a client with nothing attached comes back empty rather than described.',
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
    commitments: z.array(
      z.object({
        title: z.string(),
        kind: z.string(),
        dueOn: z.string(),
        state: z.string(),
        amountCop: z.number().nullable(),
      }),
    ),
    links: z.array(linkSchema).describe('What has been attached to this client, newest first'),
    proposals: z
      .array(linkSchema)
      .describe('Attachments Cortex suggested that nobody has confirmed — not facts yet'),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 40 },
  handler: async (input, ctx) => {
    const clientId = await resolveClient(ctx.db, input.client);
    const today = bogotaToday();
    const overview = await clientOverview(ctx.db, clientId, today);

    const client = adaptClient(overview.client);
    const contacts = overview.contacts.map(adaptContact);
    const links = overview.links.map(adaptLink);
    const proposals = input.includeProposals === false ? [] : overview.proposals.map(adaptLink);
    const commitments = overview.commitments.map((c) => ({
      title: c.title,
      kind: KIND_LABEL[c.kind as keyof typeof KIND_LABEL] ?? c.kind,
      dueOn: c.dueOn,
      state: STATE_LABEL[c.state as keyof typeof STATE_LABEL] ?? c.state,
      amountCop: c.amountCop,
    }));

    const lines: string[] = [];
    lines.push(
      `**${client.name}**${client.nit ? ` — NIT ${client.nit}` : ''} · ${client.statusLabel}`,
    );
    if (client.city)
      lines.push(`${client.city}${client.department ? `, ${client.department}` : ''}`);
    if (client.owner) lines.push(`Responsable acá: ${client.owner}`);

    if (contacts.length > 0) {
      lines.push('', '**Con quién se habla ahí**');
      for (const c of contacts.slice(0, 8)) {
        lines.push(
          `- ${c.name}${c.role ? ` · ${c.role}` : ''}${c.email ? ` · ${c.email}` : ''}${c.isPrimary ? ' (principal)' : ''}`,
        );
      }
    }

    const open = overview.commitments.filter((c) => c.state !== 'met' && c.state !== 'dropped');
    if (open.length > 0) {
      lines.push('', '**Vencimientos**');
      for (const c of open.slice(0, 10)) {
        const days = daysBetween(today, c.dueOn);
        lines.push(
          `- ${c.title} — ${c.dueOn} (${whenPhrase(days)})${c.amountCop ? ` · ${cop(c.amountCop)}` : ''}`,
        );
      }
    }

    if (links.length > 0) {
      lines.push('', '**Lo que está vinculado**');
      const byKind = new Map<LinkEntityKind, number>();
      for (const l of overview.links) {
        byKind.set(l.entity_kind, (byKind.get(l.entity_kind) ?? 0) + 1);
      }
      for (const [kind, count] of byKind) {
        lines.push(`- ${ENTITY_KIND_LABEL[kind] ?? kind}: ${count}`);
      }
      for (const l of links.slice(0, 8)) {
        lines.push(`  - ${l.kindLabel}: ${l.label ?? 'sin título'} — ${l.methodLabel}`);
      }
    }

    if (proposals.length > 0) {
      lines.push(
        '',
        `**${proposals.length} propuesta${proposals.length === 1 ? '' : 's'} sin confirmar** — Cortex cree que son de este cliente pero nadie lo ha revisado, así que todavía no cuentan.`,
      );
    }

    if (links.length === 0 && open.length === 0 && contacts.length === 0) {
      lines.push(
        '',
        'Todavía no hay nada colgado de este cliente. Registrar el dominio de su correo es lo que hace que empiece a llenarse solo.',
      );
    }

    return {
      client,
      contacts,
      domains: overview.domains.map((d) => d.domain),
      commitments,
      links,
      proposals,
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
export async function resolveClient(
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
