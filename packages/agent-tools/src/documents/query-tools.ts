import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { registerTool } from '../index';
import {
  type ExtractionRecord,
  type GroupBy,
  type RecordFilters,
  aggregateRecords,
  queryRecords,
} from './store';
import { documentTypeIds, money, typeLabel } from './types';

/**
 * The documents, as data.
 *
 * This is what the whole module is for. Brain Knowledge could already answer
 * "¿qué dice esta factura?" — one document at a time, in prose. It could not
 * answer "¿cuánto le facturamos a Coltrans en julio?" or "¿qué guías tienen el
 * plazo vencido?", because those are not questions about a document, they are
 * questions about a column.
 *
 * TWO THINGS EVERY ANSWER HERE CARRIES, and both are non-negotiable:
 *
 *   ONLY CONFIRMED DATA IS COUNTED. `queryRecords` pins
 *   `review_state = 'confirmed'` and does not expose it as a parameter.
 *
 *   WHAT WAS LEFT OUT IS PART OF THE ANSWER. Every total says how many matching
 *   documents are still waiting for a person. "$84.500.000" and "$84.500.000, y
 *   hay 6 facturas sin revisar" are different claims, and a tool that reported
 *   the first would be teaching people to read an incomplete total as a
 *   complete one.
 */

const filterSchema = {
  docType: z
    .string()
    .optional()
    .describe(`One of: ${documentTypeIds().join(', ')}. Omit for every kind of document.`),
  clientId: z.string().uuid().optional().describe('A client id, when you already have one'),
  nit: z
    .string()
    .optional()
    .describe('The counterparty NIT, in any format. Matched digit by digit.'),
  counterparty: z
    .string()
    .optional()
    .describe('Part of the client or counterparty name, e.g. "Coltrans"'),
  issuedFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Issued on or after this date. For "julio de 2026", use 2026-07-01.'),
  issuedTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Issued on or before this date. For "julio de 2026", use 2026-07-31.'),
  dueFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dueTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  overdueOnly: z
    .boolean()
    .default(false)
    .describe(
      'Only documents whose deadline has already passed. Answers "guías con plazo vencido".',
    ),
  minAmount: z.number().min(0).optional(),
};

export const documentsRecords = registerTool({
  id: 'documents.records',
  description:
    'The confirmed documents themselves, filtered: by type (factura, guía, declaración, certificado, contrato, póliza), by client or NIT, by issue date, by deadline, by amount. Answers "qué facturas le emitimos a este cliente en julio", "qué guías tienen el plazo vencido", "qué declaraciones vencen esta semana". Only documents a person has confirmed appear here — anything Cortex read but nobody checked is in documents.pending_review and is deliberately absent.',
  inputSchema: z.object({
    ...filterSchema,
    limit: z.number().int().min(1).max(200).default(50),
  }),
  outputSchema: z.object({
    today: z.string(),
    records: z.array(
      z.object({
        documentId: z.string(),
        documentTitle: z.string().nullable(),
        docTypeLabel: z.string(),
        docNumber: z.string().nullable(),
        client: z.string().nullable(),
        nit: z.string().nullable(),
        amount: z.string(),
        amountValue: z.number().nullable(),
        currency: z.string().nullable(),
        issuedOn: z.string().nullable(),
        dueOn: z.string().nullable(),
        daysToDue: z.number().nullable(),
        overdue: z.boolean(),
      }),
    ),
    count: z.number(),
    overdue: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const records = await queryRecords(ctx.db, { ...(input as RecordFilters), today });
    const overdue = records.filter((r) => r.overdue);

    return {
      today,
      records: records.map((r) => ({
        documentId: r.documentId,
        documentTitle: r.documentTitle,
        docTypeLabel: r.docTypeLabel,
        docNumber: r.docNumber,
        client: r.clientName ?? r.counterpartyName,
        nit: r.counterpartyNit,
        amount: money(r.totalAmount, r.currency),
        amountValue: r.totalAmount,
        currency: r.currency,
        issuedOn: r.issuedOn,
        dueOn: r.dueOn,
        daysToDue: r.daysToDue,
        overdue: r.overdue,
      })),
      count: records.length,
      overdue: overdue.length,
      guidance: describeRecords(records, overdue),
    };
  },
});

function describeRecords(records: ExtractionRecord[], overdue: ExtractionRecord[]): string {
  if (records.length === 0) {
    return 'Ningún documento confirmado cumple ese filtro. Puede que no haya ninguno, o que los que hay sigan esperando revisión — mira documents.pending_review antes de decir que no existe.';
  }
  const lines = [`${records.length} documento(s) confirmados.`];
  if (overdue.length > 0) {
    lines.push(`VENCIDOS (${overdue.length}):`);
    for (const r of overdue.slice(0, 15)) {
      lines.push(
        `- ${r.docTypeLabel} ${r.docNumber ?? ''} de ${r.clientName ?? r.counterpartyName ?? 'contraparte sin identificar'}: venció ${r.dueOn} (hace ${Math.abs(r.daysToDue ?? 0)} días), ${money(r.totalAmount, r.currency)}`,
      );
    }
  }
  const rest = records.filter((r) => !r.overdue).slice(0, 10);
  for (const r of rest) {
    lines.push(
      `- ${r.docTypeLabel} ${r.docNumber ?? ''} de ${r.clientName ?? r.counterpartyName ?? 'contraparte sin identificar'}: ${money(r.totalAmount, r.currency)}${r.issuedOn ? `, del ${r.issuedOn}` : ''}${r.dueOn ? `, vence ${r.dueOn}` : ''}`,
    );
  }
  lines.push(
    'Cada cifra viene de un campo que una persona confirmó contra la frase del documento. Si necesitas la frase, está en la pantalla de Documentos.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

export const documentsTotals = registerTool({
  id: 'documents.totals',
  description:
    'Add up the confirmed documents: totals and counts grouped by client, by document type, by month or by currency, over any filter. Answers "cuánto le facturamos a Coltrans en julio", "cuánto llevamos facturado este año por cliente", "cuánto vale la mercancía declarada este mes". Amounts in different currencies are NEVER added together — each currency is its own group. The answer always says how many matching documents are still waiting for review and therefore are not in the figure.',
  inputSchema: z.object({
    ...filterSchema,
    groupBy: z
      .enum(['client', 'doc_type', 'month', 'currency'])
      .default('client')
      .describe('client: por cliente. month: por mes de expedición. doc_type: por tipo.'),
    metric: z
      .enum(['total_amount', 'tax_amount', 'count'])
      .default('total_amount')
      .describe('total_amount: el valor. tax_amount: el IVA o los tributos. count: cuántos.'),
  }),
  outputSchema: z.object({
    today: z.string(),
    groups: z.array(
      z.object({
        label: z.string(),
        currency: z.string().nullable(),
        count: z.number(),
        total: z.number(),
        totalLabel: z.string(),
      }),
    ),
    pendingExcluded: z.number(),
    withoutAmount: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const { groupBy: rawGroup, metric: rawMetric, ...filters } = input;
    // Zod defaults describe what the schema PRODUCES; the handler is typed with
    // what the caller may send, so an omitted field is still undefined here.
    const groupBy: GroupBy = (rawGroup as GroupBy | undefined) ?? 'client';
    const metric = rawMetric ?? 'total_amount';
    const result = await aggregateRecords(ctx.db, {
      filters: filters as RecordFilters,
      groupBy,
      metric,
    });

    const groups = result.groups.map((g) => ({
      label: g.label,
      currency: g.currency,
      count: g.count,
      total: g.total,
      totalLabel: metric === 'count' ? `${g.total} documento(s)` : money(g.total, g.currency),
    }));

    return {
      today: result.today,
      groups,
      pendingExcluded: result.pendingExcluded,
      withoutAmount: result.withoutAmount,
      guidance: describeTotals(groups, result.pendingExcluded, result.withoutAmount, metric),
    };
  },
});

function describeTotals(
  groups: Array<{ label: string; count: number; totalLabel: string }>,
  pendingExcluded: number,
  withoutAmount: number,
  metric: string,
): string {
  if (groups.length === 0) {
    return pendingExcluded > 0
      ? `No hay nada confirmado que cumpla ese filtro, pero hay ${pendingExcluded} documento(s) esperando revisión. Dilo así: la cifra es cero porque nadie ha confirmado todavía, no porque no exista.`
      : 'No hay documentos confirmados que cumplan ese filtro.';
  }

  const lines = groups
    .slice(0, 15)
    .map((g) => `- ${g.label}: ${g.totalLabel} en ${g.count} documento(s)`);

  const caveats: string[] = [];
  if (pendingExcluded > 0) {
    caveats.push(
      `${pendingExcluded} documento(s) del mismo tipo siguen sin revisar y NO están en esta cifra — dilo cuando reportes el número`,
    );
  }
  if (withoutAmount > 0 && metric !== 'count') {
    caveats.push(`${withoutAmount} documento(s) confirmados no traen importe`);
  }

  return [
    ...lines,
    caveats.length > 0 ? `Advertencias: ${caveats.join('; ')}.` : '',
    'Todo lo sumado aquí lo confirmó una persona contra la frase del documento; nada leído automáticamente entra en un total.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Re-exported so a caller can name a type without importing the spec module. */
export { typeLabel };
