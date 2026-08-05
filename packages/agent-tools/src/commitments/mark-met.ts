import { NotFoundError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { registerTool } from '../index';
import { adaptCommitment, bogotaToday, commitmentSchema, whenPhrase } from './shape';
import { hydrate, listCommitments, markMet } from './store';

/**
 * Close a commitment: it was renewed, paid, filed, done.
 *
 * WHAT HAPPENS TO THE OLD ROW: nothing except its outcome. The date is never
 * moved forward in place. "¿Cuándo renovamos el SOAT de WGY482 la vez pasada, y
 * quién lo dijo?" is a question a fleet manager asks out loud, and it has no
 * answer in a schema where fulfilment overwrites the date.
 *
 * WHAT HAPPENS NEXT depends on where the date came from, and this is the one
 * place the difference is visible to a user. A cadence a person stated rolls
 * forward automatically. A date a REGISTRY reported does not: the next SOAT
 * expiry is whatever RUNT says after the renewal, and the tool says so in
 * words rather than quietly producing nothing.
 */

export const commitmentsMarkMet = registerTool({
  id: 'commitments.mark_met',
  description:
    'Mark a commitment as fulfilled — the SOAT was renewed, the payment went out, the customs filing was made. The old one is kept as history with who closed it and when. If it repeats on a cadence somebody stated, the next one is created automatically; if its date comes from a registry like RUNT, the next one waits for the registry to report it and this will tell you so. Requires confirmation. Find the id with commitments.due_soon first, or pass a search phrase.',
  inputSchema: z
    .object({
      commitmentId: z.string().uuid().optional().describe('Preferred: the exact commitment'),
      match: z
        .string()
        .min(3)
        .optional()
        .describe(
          'A phrase from the title, when you do not have the id — "SOAT WGY482". Refuses if it matches more than one.',
        ),
      note: z
        .string()
        .max(500)
        .optional()
        .describe('What was actually done, e.g. "renovado en Seguros Bolívar, póliza 44821"'),
    })
    .refine((v) => v.commitmentId || v.match, {
      message: 'Give either commitmentId or match',
    }),
  outputSchema: z.object({
    commitment: commitmentSchema,
    successor: commitmentSchema.nullable().describe('The next occurrence, when there is one'),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const id = input.commitmentId ?? (await resolveByPhrase(ctx.db, input.match as string, today));

    const result = await markMet(ctx.db, {
      id,
      userId: ctx.userId,
      note: input.note ?? null,
      today,
    });

    const [metRow] = await hydrate(ctx.db, [result.commitment]);
    const commitment = adaptCommitment(metRow ?? result.commitment, today);
    const successor = result.successor
      ? adaptCommitment((await hydrate(ctx.db, [result.successor]))[0] ?? result.successor, today)
      : null;

    const notes: string[] = [];
    if (result.alreadyMet) {
      notes.push(`"${commitment.title}" ya estaba marcado como cumplido; no cambié nada.`);
    } else {
      notes.push(`Listo: "${commitment.title}" queda cumplido y sale de la vigilancia.`);
    }
    if (successor) {
      notes.push(
        `El siguiente ya está creado: vence ${successor.dueOn} (${whenPhrase(successor.daysLeft)})${
          successor.source.confirmed
            ? ''
            : ' y quedó pendiente de confirmar, porque el documento fijó una fecha, no todas las siguientes'
        }.`,
      );
    } else if (result.successorDeferred) {
      notes.push(result.successorDeferred);
    }

    return { commitment, successor, guidance: notes.join(' ') };
  },
});

/**
 * Find one commitment by a phrase from its title.
 *
 * Refuses on ambiguity rather than picking the best match. This tool closes
 * things; closing the wrong SOAT means a truck keeps rolling on lapsed
 * insurance while the screen says it is fine, and "the model picked the most
 * similar one" is not a defence anybody wants to hear afterwards.
 */
async function resolveByPhrase(db: SupabaseClient, phrase: string, today: string): Promise<string> {
  const rows = await listCommitments(db, {
    states: ['overdue', 'due_soon', 'in_force'],
    today,
    limit: 300,
  });
  const needle = phrase.trim().toLowerCase();
  const hits = rows.filter(
    (r) =>
      r.title.toLowerCase().includes(needle) ||
      (r.counterparty ?? '').toLowerCase().includes(needle) ||
      (r.vehicle_plate ?? '').toLowerCase().includes(needle),
  );

  if (hits.length === 0) {
    throw new NotFoundError(
      `No hay ningún compromiso abierto que coincida con "${phrase}". Revisa con commitments.due_soon.`,
    );
  }
  if (hits.length > 1) {
    const list = hits
      .slice(0, 6)
      .map((h) => `${h.title} (vence ${h.due_on})`)
      .join('; ');
    throw new NotFoundError(
      `"${phrase}" coincide con ${hits.length} compromisos: ${list}. Dime cuál es, o pásame el id.`,
    );
  }
  return (hits[0] as { id: string }).id;
}
