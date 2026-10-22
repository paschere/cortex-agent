import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { registerTool } from '../../index';
import { moneyText } from '../../ledger/shape';
import { originsOf } from '../../trackers/origin';
import {
  SAMPLE_ROWS,
  buildSourcePreview,
  issueSummary,
  loadSourceTable,
  proposalMarkdown,
} from './preview';
import { combineKind, loadBaseRecords } from './read';
import {
  MAPPING_FIELDS,
  MAPPING_FIELD_LABEL,
  type Mapping,
  type MappingField,
  SOURCE_KINDS,
  SOURCE_KIND_LABEL,
  type SourceKind,
  isInvoiceKind,
  normalizeRows,
} from './shape';
import {
  type AccountingSource,
  listAccountingSources,
  readTableRows,
  removeAccountingSource,
  saveAccountingSource,
} from './store';

/**
 * CONFIGURAR LAS FUENTES CONTABLES POR TEXTO (0239).
 *
 *   accounting.sources_propose  lee las columnas REALES de la tabla y unas
 *                               filas, PROPONE el mapeo y muestra cómo
 *                               quedarían 5 filas normalizadas. Sólo lee.
 *   accounting.sources_define   guarda la fuente aprobada. Pide confirmación.
 *   accounting.sources_list     qué fuentes hay, cuántas filas sirven, cuáles
 *                               se descartaron y qué facturas valen distinto.
 *   accounting.sources_remove   quita la declaración (la tabla no se toca).
 */

const kindSchema = z.enum(SOURCE_KINDS as unknown as [SourceKind, ...SourceKind[]]);
const mappingSchema = z
  .record(z.enum(MAPPING_FIELDS), z.string().trim().min(1).max(60))
  .describe(
    'campo → clave de la columna de la tabla. Campos: numero, fecha, vencimiento, nit, nombre, total, iva, saldo, moneda, trm, centro_costo, cuenta, concepto, factura (la factura que paga un pago o afecta una nota), debito, credito.',
  );

const money = (n: number) => moneyText(n, 'COP');

const rowsNote = (n: number) =>
  n >= SAMPLE_ROWS
    ? `\n(La vista previa lee las primeras ${SAMPLE_ROWS} filas; al declararla se leen todas.)`
    : '';

export const accountingSourcesPropose = registerTool({
  id: 'accounting.sources_propose',
  description:
    'Look at a company table (usually a connected Google Sheet: slug from trackers.list) and PROPOSE how its columns map to an accounting source of a given kind — ventas (sales invoices), compras (supplier invoices and expenses), pagos_recibidos, pagos_proveedores, movimientos (journal lines) or presupuesto — WITHOUT saving anything. It reads the real columns and a sample of rows, matches headers and checks the content (dates, Colombian money like "$ 1.234.567,89", NIT with or without check digit), and returns the mapping, the sample values per column, how many rows would be used, how many would be rejected (no number, no date, no amount: they are reported, never counted silently) and 5 rows already normalized. ALWAYS call it before accounting.sources_define, show the markdown to the person and wait for their approval or corrections (a column they point to, precedence, currency). Read-only. Not for tables the accounting program fills (siigo_*): those already feed the figures.',
  inputSchema: z.object({
    table: z.string().trim().min(2).max(60).describe('Slug of the table (trackers.list).'),
    kind: kindSchema,
    currency: z
      .string()
      .trim()
      .length(3)
      .optional()
      .describe('Currency of rows without a currency column (default COP).'),
    mapping: mappingSchema
      .optional()
      .describe('Corrections from the person: these columns are used instead of the guess.'),
  }),
  outputSchema: z.object({
    markdown: z.string(),
    mapping: z.record(z.string(), z.string()),
    ready: z.boolean(),
    rows: z.number().int(),
    usable: z.number().int(),
    rejected: z.number().int(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const p = await buildSourcePreview(ctx.db, {
      table: input.table,
      kind: input.kind,
      mapping: input.mapping as Mapping | undefined,
      currency: input.currency,
    });
    // Lo que la persona corrige se suma a la suposición; lo demás queda como se propuso.
    const mapping: Mapping = input.mapping
      ? { ...p.proposal.mapping, ...(input.mapping as Mapping) }
      : p.mapping;
    const merged =
      input.mapping === undefined
        ? p
        : await buildSourcePreview(ctx.db, {
            table: input.table,
            kind: input.kind,
            mapping,
            currency: input.currency,
          });
    const columnsOut = p.proposal.columns.filter((c) => merged.mapping[c.field] === c.column);
    for (const [f, col] of Object.entries(merged.mapping) as Array<[MappingField, string]>)
      if (!columnsOut.some((c) => c.field === f))
        columnsOut.push({
          field: f,
          column: col,
          confidence: 1,
          validSamples: 0,
          totalSamples: 0,
          examples: [],
        });
    const md = proposalMarkdown(
      p.table.name,
      input.kind,
      { ...p.proposal, columns: columnsOut, missing: merged.ready ? [] : p.proposal.missing },
      merged.normalized.stats,
      merged.normalized.records,
      merged.normalized.issues,
    );
    return {
      markdown: `${md}${merged.ready ? '' : `\n\n${merged.problems.map((x) => `- ${x}`).join('\n')}`}\n\n¿Lo declaro así? Dime si cambias alguna columna, la regla (por defecto manda el programa contable si la misma factura está en los dos) o la moneda.${rowsNote(merged.rows)}`,
      mapping: merged.mapping as Record<string, string>,
      ready: merged.ready,
      rows: merged.normalized.stats.rows,
      usable: merged.normalized.stats.used,
      rejected: merged.normalized.stats.rejected,
    };
  },
});

export const accountingSourcesDefine = registerTool({
  id: 'accounting.sources_define',
  description:
    'Declare a company table (usually a connected Google Sheet) as an ACCOUNTING SOURCE of a kind — ventas, compras, pagos_recibidos, pagos_proveedores, movimientos or presupuesto — with the approved column mapping. From then on its rows feed the SAME figures the accounting program feeds: cortex.ventas / cortex.por_pagar / cortex.pagos, receivables (cartera), accounts payable, monthly results (marked as sheets, not accounting), Today and views — without counting an invoice twice (dedupe by kind + number + NIT; the same invoice in Siigo and the sheet counts once). precedence: "program" (default: the accounting program wins) or "sheet" (the sheet wins); a value that differs between the two is always listed as a warning, never added up twice. Each figure keeps its origin («Siigo», «Hoja: Ventas Medellín»). Call accounting.sources_propose FIRST and pass the approved mapping. Calling it again for the same table and kind replaces the mapping. Requires confirmation. Not for tables the accounting program fills (siigo_*).',
  inputSchema: z.object({
    table: z.string().trim().min(2).max(60),
    kind: kindSchema,
    mapping: mappingSchema,
    label: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe(
        'Name shown as the origin, e.g. "Ventas Medellín" → «Hoja: Ventas Medellín». Defaults to the table name.',
      ),
    precedence: z.enum(['program', 'sheet']).default('program'),
    currency: z.string().trim().length(3).default('COP'),
    sumRepeated: z
      .boolean()
      .default(false)
      .describe(
        'Several rows with the same number are lines of one invoice: add them up instead of counting the first only.',
      ),
  }),
  outputSchema: z.object({
    id: z.string(),
    origin: z.string(),
    markdown: z.string(),
    usable: z.number().int(),
    rejected: z.number().int(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const t = await loadSourceTable(ctx.db, input.table);
    const saved = await saveAccountingSource(ctx.db, {
      tracker: input.table,
      kind: input.kind,
      label: input.label,
      mapping: input.mapping as Mapping,
      precedence: input.precedence,
      currency: input.currency,
      sumRepeated: input.sumRepeated,
      userId: ctx.userId,
    });
    const { rows } = await readTableRows(ctx.db, t.id);
    const n = normalizeRows(input.kind, saved.mapping, rows, {
      sourceId: saved.id,
      origin: saved.origin,
      currency: saved.currency,
      sumRepeated: saved.sumRepeated,
    });
    const lines = [
      `Listo: «${t.name}» alimenta ${SOURCE_KIND_LABEL[input.kind]} con el origen «${saved.origin}».`,
      `De ${n.stats.rows} filas, ${n.stats.used} entran a las cifras y ${n.stats.rejected} no entran por no tener ${isInvoiceKind(input.kind) ? 'número, fecha o valor' : 'fecha o valor'}${n.stats.warnings ? ` (${n.stats.warnings} entran con aviso)` : ''}.`,
      saved.precedence === 'program'
        ? 'Si la misma factura está en el programa contable, manda el programa; si el valor difiere, queda como aviso.'
        : 'Si la misma factura está en el programa contable, manda esta hoja; si el valor difiere, queda como aviso.',
      ...issueSummary(n.issues).slice(0, 5),
      'Las cifras de Cartera, Por pagar, resultados y Hoy ya lo incluyen. Para ver diferencias y filas descartadas: accounting.sources_list.',
    ];
    return {
      id: saved.id,
      origin: saved.origin,
      markdown: lines.join('\n'),
      usable: n.stats.used,
      rejected: n.stats.rejected,
    };
  },
});

function describeSource(
  s: AccountingSource,
  stats: ReturnType<typeof normalizeRows>['stats'],
): string {
  const cols = (Object.entries(s.mapping) as Array<[keyof Mapping, string]>)
    .map(([f, c]) => `${MAPPING_FIELD_LABEL[f]} ← ${c}`)
    .join(', ');
  return `- **${s.origin}** (${SOURCE_KIND_LABEL[s.kind]}; tabla «${s.trackerName}», \`${s.trackerSlug}\`): ${s.enabled ? 'activa' : 'en pausa'}, manda ${s.precedence === 'program' ? 'el programa contable' : 'la hoja'}. ${stats.used} filas entran, ${stats.rejected} no entran, ${stats.warnings} con aviso. Columnas: ${cols}.`;
}

export const accountingSourcesList = registerTool({
  id: 'accounting.sources_list',
  description:
    'List the tables declared as accounting sources (ventas, compras, pagos, movimientos, presupuesto): which table, which origin label, which column feeds what, who wins when the program and the sheet both have the invoice, how many rows are used and how many were rejected (no number / date / amount: with examples), and the DIFFERENCES between the accounting program and the sheet for the same invoice («FV-102 vale $X en Siigo y $Y en la hoja»), plus how much each origin contributes. Use it to answer «de dónde salen estas cifras», to review dirty data, or after changing a sheet. Read-only.',
  inputSchema: z.object({ kind: kindSchema.optional() }),
  outputSchema: z.object({ markdown: z.string(), sources: z.number().int() }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const sources = await listAccountingSources(ctx.db, { kind: input.kind });
    if (!sources.length)
      return {
        sources: 0,
        markdown:
          'Ninguna tabla está declarada como fuente contable. Se hace con accounting.sources_propose (propone el mapeo de columnas) y accounting.sources_define; también desde Integraciones.',
      };
    const out: string[] = [];
    const kinds = [...new Set(sources.map((s) => s.kind))];
    for (const kind of kinds) {
      out.push(`### ${SOURCE_KIND_LABEL[kind]}`);
      const base =
        kind === 'ventas' || kind === 'compras' ? await loadBaseRecords(ctx.db, kind) : [];
      const c = await combineKind(ctx.db, kind, base);
      for (const s of sources.filter((x) => x.kind === kind)) {
        const b = c.batches.find((x) => x.sourceId === s.id);
        out.push(
          describeSource(s, b?.stats ?? { rows: 0, used: 0, rejected: 0, warnings: 0, blank: 0 }),
        );
      }
      out.push('Aporte de cada origen a las cifras:');
      for (const o of c.result.origins)
        out.push(
          `- ${o.origin}: ${o.count} registros, ${money(o.total)}${isInvoiceKind(kind) ? `, saldo ${money(o.balance)}` : ''}${o.dropped ? ` (${o.dropped} ya estaban en otro origen y no se sumaron)` : ''}`,
        );
      if (c.result.differences.length) {
        out.push(`Diferencias entre fuentes (${c.result.differences.length}):`);
        for (const d of c.result.differences.slice(0, 15)) out.push(`- ${d.message}`);
      }
      const rejected = c.result.issues.filter((i) => i.severity === 'rechazada');
      if (rejected.length) {
        out.push(`Filas que NO entran (${rejected.length}):`);
        for (const i of rejected.slice(0, 10))
          out.push(`- ${i.sourceLabel ?? ''}: ${i.number ? `${i.number}: ` : ''}${i.message}`);
      }
      const warned = c.result.issues.filter((i) => i.severity === 'aviso');
      if (warned.length) {
        out.push(`Avisos (${warned.length}):`);
        for (const i of warned.slice(0, 8))
          out.push(`- ${i.sourceLabel ?? ''}: ${i.number ? `${i.number}: ` : ''}${i.message}`);
      }
    }
    return { sources: sources.length, markdown: out.join('\n') };
  },
});

export const accountingSourcesRemove = registerTool({
  id: 'accounting.sources_remove',
  description:
    'Stop using a table as an accounting source. The table and its rows are NOT touched; only the declaration goes, so its invoices and payments leave the combined figures (cartera, accounts payable, results, Today). Pass the table slug and, if the table is a source of several kinds, the kind. Requires confirmation.',
  inputSchema: z.object({ table: z.string().trim().min(2).max(60), kind: kindSchema.optional() }),
  outputSchema: z.object({ removed: z.number().int(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const gone = await removeAccountingSource(ctx.db, { tracker: input.table, kind: input.kind });
    return {
      removed: gone.length,
      markdown: `Quité ${gone.map((g) => `«${g.origin}» (${SOURCE_KIND_LABEL[g.kind]})`).join(', ')}. La tabla sigue como estaba; sus facturas y pagos ya no entran en las cifras combinadas.`,
    };
  },
});
