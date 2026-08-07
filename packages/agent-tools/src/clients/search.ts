import { z } from 'zod';
import { registerTool } from '../index';
import { STATUS_LABEL, adaptClient, clientSchema, fullNit } from './shape';
import { searchClients } from './store';

/**
 * From a name, a NIT, a domain or an address to the client.
 *
 * The first tool anything else in this family needs, because everything a
 * person says out loud is a name and everything the database keys on is a uuid.
 * It searches more than the name on purpose — whoever is asking is usually
 * holding an invoice with a NIT on it or an email with a signature at the
 * bottom, and both are better handles than a trade name somebody may be
 * spelling differently.
 */
export const clientsSearch = registerTool({
  id: 'clients.search',
  description:
    'Find a client company by name, NIT, email domain or the address of somebody who works there. Use it whenever the person mentions a customer by name and you need the record — before clients.overview, before linking anything, before recording a commitment against them. Returns the matches and says what each one matched on; if more than one comes back, ask which.',
  inputSchema: z.object({
    query: z
      .string()
      .min(2)
      .describe('Name, NIT (with or without the verification digit), domain or email address'),
    limit: z.number().int().min(1).max(20).default(8),
  }),
  outputSchema: z.object({
    matches: z.array(
      clientSchema.extend({
        matchedOn: z
          .string()
          .describe('What the query touched: nit, name, legal_name, domain or contact'),
      }),
    ),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    const hits = await searchClients(ctx.db, input.query, input.limit ?? 8);
    const matches = hits.map((h) => ({ ...adaptClient(h.client), matchedOn: h.matchedOn }));

    const markdown =
      matches.length === 0
        ? `No hay ningún cliente que empareje con "${input.query}". Si es un cliente nuevo, se registra con clients.register; si es un proveedor o una autoridad (la DIAN, una aseguradora), no va acá.`
        : matches
            .map((m) => {
              const bits = [
                m.nit ? `NIT ${m.nit}` : null,
                m.city,
                STATUS_LABEL[m.status] ?? m.status,
              ].filter(Boolean);
              return `- **${m.name}** — ${bits.join(' · ')}`;
            })
            .join('\n');

    return { matches, markdown };
  },
});

/** Exported for the overview tool, which resolves the same way. */
export function describeNit(digits: string | null): string {
  return fullNit(digits) ?? 'sin NIT registrado';
}
