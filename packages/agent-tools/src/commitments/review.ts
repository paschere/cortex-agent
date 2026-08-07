import { z } from 'zod';
import { registerTool } from '../index';
import {
  adaptCommitment,
  bogotaToday,
  commitmentSchema,
  isoDate,
  plural,
  whenPhrase,
} from './shape';
import { confirmExtracted, hydrate, listCommitments, rejectExtracted } from './store';

/**
 * The waiting room, and the door out of it.
 *
 * Everything Cortex read out of a document lands here and stays here. It is
 * not on the vencimientos screen, it is not in `commitments.due_soon`, no mail
 * goes out about it and no calendar event is created for it. The only thing
 * that moves a row out of this queue is a person saying yes, and their name
 * goes on the row when they do — migration 0069 will not store a confirmed
 * extraction without one.
 *
 * WHY A QUEUE AT ALL, rather than just being careful. Because the failure is
 * asymmetric and irreversible in the way that matters. A proposal nobody looks
 * at costs a deadline that was already being missed before Cortex existed. A
 * fabricated date that fires an alarm costs the credibility of every other
 * alarm the system raises, including the ones about the trucks — and there is
 * no way to earn that back by being right afterwards.
 */

export const commitmentsPendingReview = registerTool({
  id: 'commitments.pending_review',
  description:
    'The commitments Cortex extracted from documents and has NOT started watching, because nobody has confirmed them yet. Each comes with the document and the exact sentence the date was read from, so a person can check the claim in one glance. These raise no alarms and send no mail until they are confirmed with commitments.confirm_extracted. Use this to answer "¿qué quedó pendiente de revisar?" and to walk somebody through the queue.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).default(25),
  }),
  outputSchema: z.object({
    pending: z.array(
      commitmentSchema.extend({
        quote: z.string().nullable().describe('The literal sentence the date was read from'),
        documentTitle: z.string().nullable(),
      }),
    ),
    count: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const rows = await listCommitments(ctx.db, {
      reviewState: 'pending',
      today,
      limit: input.limit,
    });

    const pending = rows.map((r) => ({
      ...adaptCommitment(r, today),
      quote: r.source_quote,
      documentTitle: r.source_document_title ?? null,
    }));

    if (pending.length === 0) {
      return {
        pending,
        count: 0,
        guidance:
          'No hay nada esperando revisión. Todo lo que se está vigilando tiene fuente confirmada.',
      };
    }

    const lines = [
      `${plural(pending.length, 'compromiso extraído', 'compromisos extraídos')} de documentos, sin confirmar. Ninguno está vigilándose todavía.`,
      ...pending
        .slice(0, 10)
        .map(
          (p) =>
            `- ${p.title} — propone ${p.dueOn} (${whenPhrase(p.daysLeft)}), leído de ${p.documentTitle ?? 'un documento'}: «${p.quote ?? ''}»`,
        ),
      'Muestra la cita textual cuando preguntes si confirmar: la persona tiene que poder verificar la fecha contra el documento, no confiar en que la leí bien.',
    ];
    return { pending, count: pending.length, guidance: lines.join('\n') };
  },
});

export const commitmentsConfirmExtracted = registerTool({
  id: 'commitments.confirm_extracted',
  description:
    'Confirm an extracted commitment so Cortex starts watching it: from this point it counts towards "qué se vence", sends warnings and can go on the calendar. Only do this after showing the person the exact sentence the date came from and getting a yes — the confirmation records who vouched for it. The date can be corrected while confirming, which is the point of the review step. Requires confirmation.',
  inputSchema: z.object({
    commitmentId: z.string().uuid(),
    dueOn: isoDate.optional().describe('Corrected date, if the person says the extraction was off'),
    noticeDays: z.number().int().min(0).max(365).optional(),
  }),
  outputSchema: z.object({
    commitment: commitmentSchema,
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const row = await confirmExtracted(ctx.db, {
      id: input.commitmentId,
      userId: ctx.userId,
      dueOn: input.dueOn,
      noticeDays: input.noticeDays,
      // So the review also counts as evidence about the document the date was
      // read out of. See learning/derive.ts on why a correction weighs three.
      organizationId: ctx.organizationId,
    });
    const [hydrated] = await hydrate(ctx.db, [row]);
    const commitment = adaptCommitment(hydrated ?? row, today);
    return {
      commitment,
      guidance: `Confirmado bajo tu nombre: "${commitment.title}" vence ${commitment.dueOn} (${whenPhrase(commitment.daysLeft)}) y ya entra en vigilancia. El primer aviso sale ${commitment.noticeDays} días antes.${
        input.dueOn
          ? ' Guardé la fecha que corregiste junto a la cita original, para que se vea la diferencia.'
          : ''
      }`,
    };
  },
});

export const commitmentsRejectExtracted = registerTool({
  id: 'commitments.reject_extracted',
  description:
    'Discard an extracted commitment because the date is wrong or it is not really a commitment. It stops appearing in the review queue and is never watched. Use this rather than confirming something you are unsure about. Requires confirmation.',
  inputSchema: z.object({
    commitmentId: z.string().uuid(),
    reason: z.string().max(500).optional().describe('Why it was discarded, in Spanish'),
  }),
  outputSchema: z.object({ ok: z.boolean(), guidance: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    await rejectExtracted(ctx.db, {
      id: input.commitmentId,
      userId: ctx.userId,
      reason: input.reason,
      organizationId: ctx.organizationId,
    });
    return {
      ok: true,
      guidance:
        'Descartado. Sale de la bandeja de revisión y no se vigila. Si la fecha era correcta pero mal leída, regístrala a mano con commitments.record.',
    };
  },
});
