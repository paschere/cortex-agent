import { z } from 'zod';
import { registerTool } from '../index';
import { mergeClients, mergeRefusal } from './merge';
import { resolveClientRef } from './overview';
import { adaptClient, clientSchema } from './shape';
import { getClient } from './store';

/**
 * Unir dos clientes que son la misma empresa, cuando una persona lo pide.
 *
 * Con confirmación siempre: después de unir, todo lo de uno queda en la ficha
 * del otro. Nunca une dos NIT distintos (la respuesta dice por qué), y el
 * nombre del que se va queda como alias del que se queda.
 */
export const clientsMerge = registerTool({
  id: 'clients.merge',
  description:
    'Merge two client records that are the same company — e.g. "Coltrans" and "COLTRANS S.A.S." were registered twice. Everything attached to `merge` (invoices, payments, ledger movements, commitments, emails, contacts, domains, notes, links) moves to `keep`, and the merged name is kept as an alias so it keeps matching. Refuses when both have different NITs (two legal companies). Only when the person asks for it or confirms they are the same; never on a hunch. Requires confirmation.',
  inputSchema: z.object({
    keep: z.string().min(2).describe('The client that stays: id, name or NIT'),
    merge: z.string().min(2).describe('The duplicate that disappears into `keep`: id, name or NIT'),
  }),
  outputSchema: z.object({
    kept: clientSchema,
    moved: z.record(z.number()).describe('Rows moved per table'),
    aliasesAdded: z.array(z.string()),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const keepId = await resolveClientRef(ctx.db, input.keep);
    const mergeId = await resolveClientRef(ctx.db, input.merge);
    const [keep, merge] = await Promise.all([
      getClient(ctx.db, keepId),
      getClient(ctx.db, mergeId),
    ]);
    const refusal = keep && merge ? mergeRefusal(keep, merge) : null;
    if (refusal) {
      return {
        kept: adaptClient(keep as NonNullable<typeof keep>),
        moved: {},
        aliasesAdded: [],
        guidance: refusal,
      };
    }
    const result = await mergeClients(ctx.db, { keepId, mergeId, userId: ctx.userId });
    const total = Object.values(result.moved).reduce((s, n) => s + n, 0);
    return {
      kept: adaptClient(result.kept),
      moved: result.moved,
      aliasesAdded: result.aliasesAdded,
      guidance: `Listo: ${merge?.name ?? 'el duplicado'} quedó unido a ${result.kept.name}. Pasé ${total} cosa${total === 1 ? '' : 's'} a su ficha${result.aliasesAdded.length ? ` y «${result.aliasesAdded.join('», «')}» queda como otro nombre suyo` : ''}.`,
    };
  },
});
