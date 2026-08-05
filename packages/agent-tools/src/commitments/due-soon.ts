import { z } from 'zod';
import { registerTool } from '../index';
import {
  COMMITMENT_KINDS,
  type Commitment,
  adaptCommitment,
  bogotaToday,
  commitmentSchema,
  cop,
  plural,
  sourceSentence,
  whenPhrase,
} from './shape';
import { listCommitments } from './store';

/**
 * What is about to fall due, with the provenance of every date attached.
 *
 * THE OUTPUT SHAPE IS THE POINT. Each row carries `source` — the system it was
 * read from and when, or the document and the sentence, or the person who
 * typed it — so the model can say "el SOAT de WGY482 vence el 14 de septiembre,
 * según RUNT leído el 2 de agosto" instead of asserting a date out of nowhere.
 * A date with no attribution in a chat window is indistinguishable from a
 * hallucinated one, including to the person reading it, and this product's
 * entire claim is that the difference is visible.
 *
 * Only CONFIRMED commitments appear here. Anything extracted from a document
 * and not yet vouched for by a person is in `commitments.pending_review` and
 * nowhere else.
 */

export const commitmentsDueSoon = registerTool({
  id: 'commitments.due_soon',
  description:
    'What the company owes and when: SOAT and tecnomecánica of the fleet, client contracts, insurance policies, warranties, customs deadlines and promised payments — everything falling due inside a window, overdue items first. Every date comes back with WHERE IT CAME FROM (the registry it was read from and when, the document and the exact sentence, or the person who registered it), so cite that source when you report the date instead of stating it flat. Answers "qué se nos vence", "qué está vencido", "qué hay que pagar esta semana". Reads only confirmed commitments; use commitments.pending_review for extracted ones still waiting to be checked.',
  inputSchema: z.object({
    withinDays: z
      .number()
      .int()
      .min(0)
      .max(365)
      .default(30)
      .describe('How far ahead to look, in days. 0 means only what is overdue or due today.'),
    includeOverdue: z
      .boolean()
      .default(true)
      .describe('Include what has already lapsed. Almost always yes — it is the urgent part.'),
    kind: z
      .enum(COMMITMENT_KINDS)
      .optional()
      .describe('Narrow to one kind, e.g. "soat" or "payment"'),
    mineOnly: z
      .boolean()
      .default(false)
      .describe('Only the commitments this person answers for, rather than the whole workspace'),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  outputSchema: z.object({
    today: z.string().describe('The calendar day in Colombia this answer was computed for'),
    commitments: z.array(commitmentSchema),
    overdue: z.number(),
    dueSoon: z.number(),
    guidance: z
      .string()
      .describe('The report in words, worst first, with the source of each date named'),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const withinDays = input.withinDays ?? 30;
    const limit = input.limit ?? 50;
    const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + withinDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const rows = await listCommitments(ctx.db, {
      states: input.includeOverdue ? ['overdue', 'due_soon', 'in_force'] : ['due_soon', 'in_force'],
      reviewState: 'confirmed',
      kind: input.kind,
      ownerUserId: input.mineOnly ? ctx.userId : undefined,
      dueBefore: horizon,
      today,
      limit,
    });

    const commitments = rows
      .map((r) => adaptCommitment(r, today))
      // Worst first: the most overdue at the top, then the soonest.
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .slice(0, limit);

    const overdue = commitments.filter((c) => c.state === 'overdue');
    const dueSoon = commitments.filter((c) => c.state === 'due_soon');

    return {
      today,
      commitments,
      overdue: overdue.length,
      dueSoon: dueSoon.length,
      guidance: report(commitments, overdue, dueSoon, withinDays),
    };
  },
});

/**
 * The answer, already in sentences.
 *
 * Written here rather than left to the model because the ordering ("vencido"
 * before "por vencer") and the attribution are not stylistic — they are the
 * substance. A model handed a flat array reliably reports the first row first.
 */
function report(
  all: Commitment[],
  overdue: Commitment[],
  dueSoon: Commitment[],
  withinDays: number,
): string {
  if (all.length === 0) {
    return `Nada vencido ni por vencer en los próximos ${plural(withinDays, 'día')}. Si esperabas ver algo, puede que no esté registrado todavía o que siga esperando confirmación en la bandeja de revisión.`;
  }

  const lines: string[] = [];
  if (overdue.length > 0) {
    lines.push(`VENCIDO (${overdue.length}):`);
    for (const c of overdue.slice(0, 15)) {
      lines.push(`- ${describe(c)}`);
    }
  }
  if (dueSoon.length > 0) {
    lines.push(`POR VENCER (${dueSoon.length}):`);
    for (const c of dueSoon.slice(0, 15)) {
      lines.push(`- ${describe(c)}`);
    }
  }
  const later = all.length - overdue.length - dueSoon.length;
  if (later > 0) {
    lines.push(`${plural(later, 'compromiso')} más dentro de la ventana, todavía con holgura.`);
  }
  lines.push(
    'Al reportar cualquiera de estas fechas, di de dónde salió — la fuente viene en cada una.',
  );
  return lines.join('\n');
}

function describe(c: Commitment): string {
  const parts = [
    `${c.title} — vence ${c.dueOn} (${whenPhrase(c.daysLeft)})`,
    c.counterparty ? `con ${c.counterparty}` : '',
    c.amountCop ? cop(c.amountCop) : '',
    c.owner ? `responde ${c.owner}` : 'sin responsable asignado',
  ].filter(Boolean);
  return `${parts.join('; ')}. ${sourceSentence(c.source)}`;
}
