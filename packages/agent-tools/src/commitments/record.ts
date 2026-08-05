import { z } from 'zod';
import { registerTool } from '../index';
import {
  COMMITMENT_KINDS,
  DEFAULT_NOTICE_DAYS,
  RECURRENCES,
  adaptCommitment,
  bogotaToday,
  commitmentSchema,
  isoDate,
  whenPhrase,
} from './shape';
import { createCommitment, hydrate } from './store';

/**
 * Register a commitment somebody stated.
 *
 * THE SOURCE IS THE CALLER. This tool only ever writes `source_kind='manual'`
 * with the acting user on the row — there is no argument for "where did this
 * date come from", and that is intentional. If the model could pass a source,
 * the model could pass "RUNT" for a date it worked out itself, and every
 * guarantee in this module would rest on the model's honesty about its own
 * reasoning. A date that arrives through a chat turn is a date a person said,
 * so it is filed as one, under their name.
 *
 * Confirmation-gated like every write: the person sees the date and the
 * warning window before anything starts watching them.
 */

export const commitmentsRecord = registerTool({
  id: 'commitments.record',
  description:
    'Register a dated commitment so Cortex watches it and warns before it lapses: a contract renewal, an insurance policy, a customs deadline, a payment promised for a date. The date is filed as stated BY THIS PERSON — never use this to record something you read in a document (that is commitments.extract_from_document, which goes to review) or something a registry reported. Requires confirmation.',
  inputSchema: z.object({
    title: z.string().min(3).max(200).describe('What is owed, in a short phrase in Spanish'),
    dueOn: isoDate,
    kind: z
      .enum(COMMITMENT_KINDS)
      .default('other')
      .describe('Drives how far ahead the first warning goes out'),
    detail: z.string().max(2000).optional().describe('Anything the person adds about it'),
    counterparty: z
      .string()
      .max(160)
      .optional()
      .describe('Client, supplier or authority this is with'),
    amountCop: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Amount in Colombian pesos, for a payment'),
    noticeDays: z
      .number()
      .int()
      .min(0)
      .max(365)
      .optional()
      .describe(
        'Days of warning. Leave empty for the sensible default for the kind — a month for a SOAT, three days for a payment.',
      ),
    ownerEmail: z
      .string()
      .email()
      .optional()
      .describe('Who answers for it. Defaults to the person registering it.'),
    escalateToEmail: z
      .string()
      .email()
      .optional()
      .describe('Who to warn if the day arrives and nothing happened'),
    escalateAfterDays: z.number().int().min(0).max(90).optional(),
    recurrence: z
      .enum(RECURRENCES)
      .default('none')
      .describe(
        'Only use monthly/quarterly/yearly when the PERSON stated the cadence. Repeating it is repeating what they said; guessing it is not.',
      ),
  }),
  outputSchema: z.object({
    commitment: commitmentSchema,
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const kind = input.kind ?? 'other';
    const ownerUserId = input.ownerEmail ? await resolveUser(ctx.db, input.ownerEmail) : ctx.userId;
    const escalateToUserId = input.escalateToEmail
      ? await resolveUser(ctx.db, input.escalateToEmail)
      : null;

    const row = await createCommitment(ctx.db, {
      title: input.title,
      detail: input.detail ?? null,
      kind,
      dueOn: input.dueOn,
      noticeDays: input.noticeDays ?? null,
      counterparty: input.counterparty ?? null,
      amountCop: input.amountCop ?? null,
      ownerUserId: ownerUserId ?? ctx.userId,
      escalateToUserId,
      escalateAfterDays: input.escalateAfterDays ?? null,
      recurrence: input.recurrence ?? 'none',
      // Not a parameter. See the note at the top of the file.
      source: { kind: 'manual', userId: ctx.userId },
      createdBy: ctx.userId,
    });

    const [hydrated] = await hydrate(ctx.db, [row]);
    const commitment = adaptCommitment(hydrated ?? row, today);
    const notice = input.noticeDays ?? DEFAULT_NOTICE_DAYS[kind];

    return {
      commitment,
      guidance: `Queda registrado: ${commitment.title}, vence ${commitment.dueOn} (${whenPhrase(commitment.daysLeft)}). El primer aviso sale ${notice} días antes${
        input.ownerEmail ? ` y va para ${input.ownerEmail}` : ''
      }. La fuente de esta fecha queda como "registrada por ti", que es lo que es.`,
    };
  },
});

/**
 * An email to a colleague's directory id.
 *
 * Scoped, so an address belonging to somebody at another company resolves to
 * nothing and the commitment simply keeps its default owner — rather than
 * failing, or worse, matching.
 */
async function resolveUser(
  db: Parameters<typeof hydrate>[0],
  email: string,
): Promise<string | null> {
  const { data } = await db
    .from('users')
    .select('id')
    .eq('email', email.trim().toLowerCase())
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}
