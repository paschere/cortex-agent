import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { registerTool } from '../index';
import { getVisibleDocument } from '../kb/spaces';
import { readDocument } from './extract';
import { displayValue, listFields, saveReading } from './store';
import { documentTypeIds, fieldLabel, typeLabel } from './types';
import type { DocumentChunk } from './verify';

/**
 * Read a document already in Brain Knowledge and PROPOSE its fields.
 *
 * Everything this writes lands `pending`: absent from every total, absent from
 * every list of what is due, and the tool's own description says so — a model
 * that believes it just registered an invoice will tell the user it did.
 *
 * VISIBILITY GOES THROUGH SPACES, exactly as `commitments.extract_from_document`
 * does. A document id is handed out by every search hit; without
 * `getVisibleDocument`, this tool would be enough to pull the text of a
 * colleague's personal space out one quote at a time.
 */

export const documentsExtract = registerTool({
  id: 'documents.extract',
  description:
    'Read a document already in Brain Knowledge — a factura, a guía de transporte, a declaración de importación, a certificado de origen, a contrato, a póliza — work out which of those it is, and pull out its fields (número, NIT, valor, IVA, fechas, remitente y destinatario), each with the exact sentence it was read from. NOTHING here is counted as fact: every field goes to the review queue and needs a person to confirm it (documents.pending_review, then documents.confirm). Readings whose quoted sentence is not literally in the document, or whose value had to be calculated rather than read, are discarded automatically and reported as discarded. If the document does not say what kind of document it is, it is left unclassified rather than guessed. Requires confirmation.',
  inputSchema: z.object({
    documentId: z.string().uuid().describe('A document id from a Brain Knowledge search hit'),
    docType: z
      .string()
      .optional()
      .describe(
        'Force the type instead of letting Cortex classify it. Only when a person has said what the document is.',
      ),
  }),
  outputSchema: z.object({
    documentTitle: z.string(),
    docType: z.string().nullable(),
    docTypeLabel: z.string(),
    unclassifiedReason: z.string().nullable(),
    clientMatch: z.string(),
    fields: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        value: z.string(),
        quote: z.string().describe('Verified to appear verbatim in the document'),
      }),
    ),
    discarded: z.array(z.object({ field: z.string(), proposed: z.string(), reason: z.string() })),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  // Two model calls over a whole document. Slow, and not something to loop on.
  rateLimit: { perMinute: 5 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    // Throws NotFoundError when the document belongs to a space this person
    // cannot see — which reads as "it does not exist", which is correct.
    const document = await getVisibleDocument(ctx.db, ctx.userId, input.documentId);

    if (input.docType && !documentTypeIds().includes(input.docType)) {
      throw new Error(
        `"${input.docType}" no es un tipo de documento conocido. Los que hay: ${documentTypeIds().join(', ')}.`,
      );
    }

    const { data, error } = await ctx.db
      .from('kb_chunks')
      .select('id, chunk_index, content')
      .eq('document_id', input.documentId)
      .order('chunk_index', { ascending: true })
      .limit(200);
    if (error) throw error;
    const chunks = (data ?? []) as DocumentChunk[];

    if (chunks.length === 0) {
      return {
        documentTitle: document.title,
        docType: null,
        docTypeLabel: typeLabel(null),
        unclassifiedReason: 'el documento todavía no tiene texto indexado',
        clientMatch: 'sin NIT',
        fields: [],
        discarded: [],
        guidance: `"${document.title}" todavía no tiene texto indexado, así que no hay nada que leer. Espera a que termine de procesarse.`,
      };
    }

    const reading = await readDocument(chunks, today, input.docType ?? null);
    const row = await saveReading(ctx.db, {
      documentId: input.documentId,
      reading,
      createdBy: ctx.userId,
    });

    const stored = (await listFields(ctx.db, [row.id])).get(row.id) ?? [];
    const fields = stored.map((f) => ({
      key: f.field_key,
      label: fieldLabel(row.doc_type, f.field_key),
      value: displayValue(f),
      quote: f.quote,
    }));
    const discarded = reading.rejected.map((r) => ({
      field: fieldLabel(row.doc_type, r.fieldKey),
      proposed: r.proposed,
      reason: r.reason,
    }));

    return {
      documentTitle: document.title,
      docType: row.doc_type,
      docTypeLabel: typeLabel(row.doc_type),
      unclassifiedReason: row.unclassified_reason,
      clientMatch: describeMatch(row.client_match_state, row.client_nit),
      fields,
      discarded,
      guidance: report(document.title, row.doc_type, row.unclassified_reason, fields, discarded),
    };
  },
});

function describeMatch(state: string, nit: string | null): string {
  switch (state) {
    case 'matched':
      return `emparejado con el cliente cuyo NIT es ${nit}`;
    case 'ambiguous':
      return `hay más de un cliente con el NIT ${nit}; quedó sin vincular`;
    case 'unmatched':
      return `ningún cliente tiene el NIT ${nit}; quedó sin vincular`;
    default:
      return 'el documento no trae un NIT legible; quedó sin vincular';
  }
}

function report(
  title: string,
  docType: string | null,
  unclassifiedReason: string | null,
  fields: Array<{ label: string; value: string; quote: string }>,
  discarded: Array<{ field: string; proposed: string; reason: string }>,
): string {
  if (!docType) {
    return `No pude decir qué tipo de documento es "${title}": ${unclassifiedReason ?? 'no se nombra a sí mismo'}. No inventé campos. Si sabes qué es, dímelo y lo leo como ese tipo — o revísalo en la pantalla de Documentos.`;
  }

  const lines: string[] = [];
  if (fields.length === 0) {
    lines.push(
      `"${title}" es ${typeLabel(docType).toLowerCase()}, pero no saqué ningún campo verificable de él.`,
    );
  } else {
    lines.push(
      `De "${title}" (${typeLabel(docType).toLowerCase()}) saqué ${fields.length} campos, TODOS PENDIENTES DE CONFIRMAR — no entran en ninguna suma todavía:`,
    );
    for (const f of fields) lines.push(`- ${f.label}: ${f.value} — «${f.quote}»`);
  }
  if (discarded.length > 0) {
    lines.push(
      `Descarté ${discarded.length}: ${discarded.map((d) => `${d.field} (${d.reason})`).join('; ')}.`,
    );
  }
  lines.push(
    'Muéstrale a la persona la cita de cada campo y pregúntale cuáles confirma. Hasta que alguien confirme, esto no cuenta como dato de la empresa.',
  );
  return lines.join('\n');
}
