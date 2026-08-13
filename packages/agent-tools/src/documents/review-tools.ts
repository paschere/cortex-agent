import { z } from 'zod';
import { registerTool } from '../index';
import { fieldLabel, typeLabel } from './types';
import {
  type FieldDecision,
  confirmExtraction,
  correctionStats,
  displayValue,
  hydrate,
  listExtractions,
  listFields,
  rejectExtraction,
} from './store';

/**
 * The waiting room, and the door out of it.
 *
 * Everything Cortex read out of a document lands here and stays here. It is in
 * no total, no list of what is due, no report. The only thing that moves a
 * reading out of this queue is a person saying yes, and their name goes on
 * every field when they do — migration 0076 will not store a confirmed field
 * without one.
 *
 * WHY A QUEUE AT ALL, rather than being careful. Because the failure is
 * asymmetric. An unreviewed invoice costs a number that is missing, and a
 * missing number is visibly missing. A wrong number that was never checked is
 * summed, reported to a client, and is invisible from that moment on — and the
 * damage is not the one figure, it is that every figure this product produces
 * afterwards is worth arguing about.
 */

export const documentsPendingReview = registerTool({
  id: 'documents.pending_review',
  description:
    'The documents Cortex has read and NOBODY has confirmed yet, with every proposed field beside the exact sentence it was read from, so a person can check the claim in one glance. None of this counts towards any total until it is confirmed with documents.confirm. Also lists the documents Cortex could not classify at all, which need a person to say what they are. Use this to answer "¿qué quedó pendiente de revisar?" and to walk somebody through the queue.',
  inputSchema: z.object({
    docType: z.string().optional().describe('Narrow to one type, e.g. "invoice"'),
    includeUnclassified: z.boolean().default(true),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  outputSchema: z.object({
    pending: z.array(
      z.object({
        extractionId: z.string(),
        documentTitle: z.string().nullable(),
        docType: z.string().nullable(),
        docTypeLabel: z.string(),
        clientName: z.string().nullable(),
        fields: z.array(
          z.object({
            key: z.string(),
            label: z.string(),
            value: z.string(),
            quote: z.string(),
          }),
        ),
      }),
    ),
    unclassified: z.array(
      z.object({
        extractionId: z.string(),
        documentTitle: z.string().nullable(),
        reason: z.string().nullable(),
      }),
    ),
    count: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const states = input.includeUnclassified
      ? (['pending', 'unclassified'] as const)
      : (['pending'] as const);
    const rows = await hydrate(
      ctx.db,
      await listExtractions(ctx.db, {
        reviewState: [...states],
        docType: input.docType,
        limit: input.limit,
      }),
    );

    const classified = rows.filter((r) => r.review_state === 'pending');
    const fieldsBy = await listFields(
      ctx.db,
      classified.map((r) => r.id),
    );

    const pending = classified.map((r) => ({
      extractionId: r.id,
      documentTitle: r.document_title ?? null,
      docType: r.doc_type,
      docTypeLabel: typeLabel(r.doc_type),
      clientName: r.client_name ?? null,
      fields: (fieldsBy.get(r.id) ?? [])
        .filter((f) => f.review_state === 'pending')
        .map((f) => ({
          key: f.field_key,
          label: fieldLabel(r.doc_type, f.field_key),
          value: displayValue(f),
          quote: f.quote,
        })),
    }));

    const unclassified = rows
      .filter((r) => r.review_state === 'unclassified')
      .map((r) => ({
        extractionId: r.id,
        documentTitle: r.document_title ?? null,
        reason: r.unclassified_reason,
      }));

    return {
      pending,
      unclassified,
      count: pending.length + unclassified.length,
      guidance: report(pending, unclassified),
    };
  },
});

function report(
  pending: Array<{ documentTitle: string | null; docTypeLabel: string; fields: unknown[] }>,
  unclassified: Array<{ documentTitle: string | null; reason: string | null }>,
): string {
  if (pending.length === 0 && unclassified.length === 0) {
    return 'No hay nada esperando revisión. Todo lo que está en las cifras lo confirmó una persona.';
  }
  const lines: string[] = [];
  if (pending.length > 0) {
    lines.push(
      `${pending.length} documento(s) leídos y sin confirmar. Ninguno entra en las sumas todavía:`,
    );
    for (const p of pending.slice(0, 10)) {
      lines.push(
        `- ${p.documentTitle ?? 'documento sin título'} (${p.docTypeLabel.toLowerCase()}): ${p.fields.length} campos por revisar`,
      );
    }
  }
  if (unclassified.length > 0) {
    lines.push(`${unclassified.length} documento(s) que no pude clasificar:`);
    for (const u of unclassified.slice(0, 10)) {
      lines.push(`- ${u.documentTitle ?? 'documento sin título'}: ${u.reason ?? 'sin motivo'}`);
    }
  }
  lines.push(
    'Muestra la cita textual de cada campo cuando preguntes si confirmar: la persona tiene que poder verificar el dato contra el documento, no confiar en que lo leí bien. La pantalla de Documentos permite confirmar varios de un golpe.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

const decisionSchema = z.object({
  fieldKey: z.string(),
  action: z.enum(['confirm', 'reject']).default('confirm'),
  text: z.string().nullable().optional().describe('Corrected text value, if the reading was off'),
  number: z.number().nullable().optional().describe('Corrected amount'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional()
    .describe('Corrected date, YYYY-MM-DD'),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional()
    .describe('The currency, when the document wrote only "$" and the person knows which'),
});

export const documentsConfirm = registerTool({
  id: 'documents.confirm',
  description:
    'Confirm what Cortex read out of a document, correcting whatever was wrong, so it starts counting as company data: from this point it enters the totals, the client attribution and the deadline lists. Confirms every field of the document in one call — that is the unit of review. Only do this after showing the person the sentence each value came from and getting a yes; the confirmation records who vouched for it, and every correction is kept beside the original reading. Requires confirmation.',
  inputSchema: z.object({
    extractionId: z.string().uuid(),
    decisions: z
      .array(decisionSchema)
      .min(1)
      .describe('One entry per field. Fields left out stay pending.'),
  }),
  outputSchema: z.object({
    confirmed: z.number(),
    corrected: z.number(),
    rejected: z.number(),
    stillPending: z.number(),
    reviewState: z.string(),
    clientMatch: z.string(),
    /** Qué pasó con el pago, si el documento era un comprobante. */
    paymentNote: z.string().nullable(),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const result = await confirmExtraction(ctx.db, {
      extractionId: input.extractionId,
      userId: ctx.userId,
      decisions: input.decisions as FieldDecision[],
    });
    const fields = (await listFields(ctx.db, [result.extraction.id])).get(result.extraction.id) ?? [];
    const stillPending = fields.filter((f) => f.review_state === 'pending').length;

    const clientMatch =
      result.extraction.client_match_state === 'matched'
        ? 'quedó vinculado al cliente por su NIT'
        : result.extraction.client_nit
          ? `el NIT ${result.extraction.client_nit} no coincide con ningún cliente, así que quedó sin vincular`
          : 'sin NIT confirmado, así que quedó sin vincular';

    return {
      confirmed: result.confirmed,
      corrected: result.corrected,
      rejected: result.rejected,
      stillPending,
      reviewState: result.extraction.review_state,
      clientMatch,
      paymentNote: result.paymentNote,
      guidance: [
        `Confirmado bajo tu nombre: ${result.confirmed} campo(s)${result.corrected > 0 ? `, ${result.corrected} corregido(s)` : ''}${result.rejected > 0 ? `, ${result.rejected} descartado(s)` : ''}.`,
        stillPending > 0
          ? `Quedan ${stillPending} campos sin revisar, así que el documento sigue pendiente y no entra en las cifras.`
          : `El documento ya cuenta: entra en los totales y en las consultas por cliente y por fecha. ${clientMatch}.`,
        // Un comprobante confirmado además registra el pago. Decirlo importa:
        // es la diferencia entre "confirmé un papel" y "la cartera cambió".
        result.paymentNote ?? '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
});

export const documentsReject = registerTool({
  id: 'documents.reject',
  description:
    'Throw out an entire reading: the document was misclassified, the scan is unreadable, or it is a duplicate. It leaves the review queue, contributes nothing to any total, and anything it had already contributed is removed. Use this rather than confirming something you are unsure about. Requires confirmation.',
  inputSchema: z.object({
    extractionId: z.string().uuid(),
    reason: z.string().max(500).optional().describe('Why, in Spanish'),
  }),
  outputSchema: z.object({ ok: z.boolean(), guidance: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    await rejectExtraction(ctx.db, {
      extractionId: input.extractionId,
      userId: ctx.userId,
      reason: input.reason ?? null,
    });
    return {
      ok: true,
      guidance:
        'Descartado. Sale de la bandeja y no cuenta en ninguna cifra. Si el documento sí servía pero se leyó como el tipo equivocado, vuelve a leerlo diciendo qué tipo es.',
    };
  },
});

// ---------------------------------------------------------------------------

export const documentsCorrectionStats = registerTool({
  id: 'documents.correction_stats',
  description:
    'Which extracted fields people always have to correct, by document type. This is the honest measure of where the reading is failing: a field corrected in four readings out of five is a bug worth fixing, and it is invisible everywhere else in the product because the corrected value looks right the moment it is saved. Answers "¿en qué se equivoca Cortex leyendo facturas?".',
  inputSchema: z.object({
    docType: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(15),
  }),
  outputSchema: z.object({
    fields: z.array(
      z.object({
        docTypeLabel: z.string(),
        fieldLabel: z.string(),
        corrected: z.number(),
        rejected: z.number(),
        confirmed: z.number(),
        errorRate: z.number(),
      }),
    ),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const stats = await correctionStats(ctx.db, { docType: input.docType, limit: input.limit });
    const fields = stats.map((s) => ({
      docTypeLabel: s.docTypeLabel,
      fieldLabel: s.fieldLabel,
      corrected: s.corrected,
      rejected: s.rejected,
      confirmed: s.confirmed,
      errorRate: Math.round(s.errorRate * 100) / 100,
    }));

    if (fields.length === 0) {
      return {
        fields,
        guidance:
          'Todavía nadie ha corregido un campo. O la lectura viene bien, o no se ha revisado lo suficiente como para saberlo.',
      };
    }
    const worst = fields.slice(0, 5).map((f) => {
      const pct = Math.round(f.errorRate * 100);
      return `${f.fieldLabel} en ${f.docTypeLabel.toLowerCase()} (${f.corrected} correcciones, ${pct}% de lo revisado)`;
    });
    return {
      fields,
      guidance: `Lo que más se corrige: ${worst.join('; ')}. Un campo que se corrige casi siempre es un problema de extracción, no del documento.`,
    };
  },
});
