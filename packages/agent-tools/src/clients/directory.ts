import { z } from 'zod';
import { registerTool } from '../index';
import { STATUS_LABEL, adaptClient, clientSchema } from './shape';
import { listClients } from './store';

/**
 * The client directory, as a list.
 *
 * `clients.search` needs a query of two characters because it is a finder:
 * calling it empty would look like a search that found nothing. This is the
 * other question — "who do we work with" — and it is what the panel beside
 * the chat runs. The model can call it too when somebody asks to see the
 * book rather than one name.
 */
export const clientsDirectory = registerTool({
  id: 'clients.directory',
  description:
    'List the client companies in this workspace, newest first. Use it when the person wants to see the directory — who we work with — rather than find one name. To look up a specific company by name or NIT, use clients.search.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(80).default(40),
  }),
  outputSchema: z.object({
    clients: z.array(clientSchema),
    total: z.number().int(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 40 },
  handler: async (input, ctx) => {
    const rows = await listClients(ctx.db, { limit: input.limit ?? 40 });
    const clients = rows.map(adaptClient);

    const markdown =
      clients.length === 0
        ? 'Todavía no hay clientes en este espacio. Se registran con clients.register.'
        : clients
            .map((c) => {
              const bits = [
                c.nit ? `NIT ${c.nit}` : null,
                c.city,
                STATUS_LABEL[c.status] ?? c.status,
              ].filter(Boolean);
              return `- **${c.name}** — ${bits.join(' · ')}`;
            })
            .join('\n');

    return { clients, total: clients.length, markdown };
  },
});
