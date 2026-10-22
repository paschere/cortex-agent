import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { moneyText } from '../../ledger/shape';
import { originsOf } from '../../trackers/origin';
import {
  KIND_SPEC,
  MAPPING_FIELD_LABEL,
  type Mapping,
  type MappingField,
  type MappingProposal,
  type RawRow,
  SOURCE_KIND_LABEL,
  type SourceKind,
  isInvoiceKind,
  normalizeRows,
  proposeMapping,
  validateMapping,
} from './shape';
import { readTableRows } from './store';

const money = (n: number) => moneyText(n, 'COP');
export const SAMPLE_ROWS = 300;

export async function loadSourceTable(db: SupabaseClient, slug: string) {
  const { data, error } = await db
    .from('trackers')
    .select('id, slug, name, fields, origins')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new NotFoundError(`No hay una tabla «${slug}». Mira los slugs con trackers.list.`);
  const t = data as {
    id: string;
    slug: string;
    name: string;
    fields: Array<{ key: string; label: string; type: string }>;
    origins: unknown;
  };
  if (originsOf(t).some((o) => o.kind === 'accounting'))
    throw new ValidationError(
      `«${t.name}» la llena el programa contable: sus facturas ya entran solas a las cifras. No se declara como fuente (se contaría dos veces).`,
    );
  return t;
}

export function previewTable(
  rows: ReturnType<typeof normalizeRows>['records'],
  kind: SourceKind,
): string[] {
  if (!rows.length) return ['_Ninguna fila se pudo leer con este mapeo._'];
  const head = isInvoiceKind(kind)
    ? '| Número | Fecha | Vence | NIT | Tercero | Total | IVA | Saldo | Moneda |'
    : kind === 'movimientos'
      ? '| Fecha | Cuenta | Débito | Crédito | Tercero | Centro de costo |'
      : '| Número | Fecha | NIT | Tercero | Valor | Factura | Moneda |';
  const sep = head.replace(/[^|]+/g, '---');
  const lines = rows.map((r) => {
    if (isInvoiceKind(kind))
      return `| ${r.number} | ${r.date} | ${r.due ?? '—'} | ${r.nit || '—'} | ${r.party || '—'} | ${money(r.total)} | ${r.tax === null ? '—' : money(r.tax)} | ${r.balance === null ? '—' : money(r.balance)} | ${r.currency} |`;
    if (kind === 'movimientos')
      return `| ${r.date} | ${r.account ?? '—'} | ${r.debit === null ? '—' : money(r.debit)} | ${r.credit === null ? '—' : money(r.credit)} | ${r.party || '—'} | ${r.costCenter ?? '—'} |`;
    return `| ${r.number || '—'} | ${r.date} | ${r.nit || '—'} | ${r.party || '—'} | ${money(r.total)} | ${r.invoiceRef ?? '—'} | ${r.currency} |`;
  });
  return [head, sep, ...lines];
}

export function issueSummary(issues: ReturnType<typeof normalizeRows>['issues']): string[] {
  const byCode = new Map<string, { n: number; example: string; severity: string }>();
  for (const i of issues) {
    const c = byCode.get(i.code) ?? { n: 0, example: i.message, severity: i.severity };
    c.n += 1;
    byCode.set(i.code, c);
  }
  return [...byCode.entries()].map(
    ([code, c]) =>
      `- ${c.severity === 'rechazada' ? 'No entran' : 'Entran con aviso'} (${code}): ${c.n} fila(s). Ejemplo: ${c.example}`,
  );
}

export function proposalMarkdown(
  tableName: string,
  kind: SourceKind,
  p: MappingProposal,
  stats: ReturnType<typeof normalizeRows>['stats'],
  preview: ReturnType<typeof normalizeRows>['records'],
  issues: ReturnType<typeof normalizeRows>['issues'],
): string {
  const out: string[] = [];
  out.push(`### «${tableName}» como ${SOURCE_KIND_LABEL[kind]}`);
  out.push('| Campo | Columna | Ejemplos | Se lee bien |', '|---|---|---|---:|');
  for (const c of p.columns)
    out.push(
      `| ${MAPPING_FIELD_LABEL[c.field]} | ${c.column} | ${c.examples.join(' · ') || '—'} | ${c.totalSamples ? `${c.validSamples}/${c.totalSamples}` : '—'} |`,
    );
  if (p.missing.length)
    out.push(
      `\n**Falta mapear:** ${p.missing.map((f) => MAPPING_FIELD_LABEL[f]).join(', ')}. Sin eso no se puede usar la tabla como fuente.`,
    );
  for (const w of p.warnings) out.push(`- ${w}`);
  out.push(
    `\nCon este mapeo, de ${stats.rows} filas leídas: **${stats.used} entran**, ${stats.rejected} no entran, ${stats.warnings} entran con aviso${stats.blank ? `, ${stats.blank} vacías` : ''}.`,
  );
  out.push(...issueSummary(issues));
  out.push('\nAsí quedarían las primeras filas ya normalizadas:');
  out.push(...previewTable(preview.slice(0, 5), kind));
  return out.join('\n');
}

/** Las filas para proponer: una muestra repartida, no sólo las primeras. */
export function sampleOf(rows: RawRow[], n = 30): Array<Record<string, unknown>> {
  const filled = rows.filter((r) => Object.values(r.values).some((v) => String(v ?? '').trim()));
  if (filled.length <= n) return filled.map((r) => r.values);
  const step = filled.length / n;
  return Array.from({ length: n }, (_, i) => (filled[Math.floor(i * step)] as RawRow).values);
}

export interface SourcePreview {
  table: { id: string; slug: string; name: string };
  kind: SourceKind;
  columns: Array<{ key: string; label: string }>;
  /** Cada campo del tipo, para dibujar un desplegable por campo. */
  fields: Array<{ field: MappingField; label: string; required: boolean }>;
  mapping: Mapping;
  proposal: MappingProposal;
  ready: boolean;
  problems: string[];
  rows: number;
  /** Se leyó sólo una muestra (la tabla tiene más filas). */
  sampled: boolean;
  normalized: ReturnType<typeof normalizeRows>;
}

/**
 * Lo que hace falta para proponer y mostrar un mapeo: las columnas reales, la
 * suposición (o lo que la persona corrigió), si es válido y 5 filas ya
 * normalizadas. Compartido por la herramienta y por la pantalla de Integraciones.
 */
export async function buildSourcePreview(
  db: SupabaseClient,
  input: { table: string; kind: SourceKind; mapping?: Mapping; currency?: string },
): Promise<SourcePreview> {
  const t = await loadSourceTable(db, input.table);
  const { rows } = await readTableRows(db, t.id, SAMPLE_ROWS);
  if (!rows.length)
    throw new ValidationError(
      `La tabla «${t.name}» no tiene filas todavía: no hay nada que mirar. Si es una hoja, espera a que sincronice o actualízala desde Tablas.`,
    );
  const proposal = proposeMapping(input.kind, t.fields, sampleOf(rows));
  // Lo que la persona corrige manda sobre la suposición.
  const mapping: Mapping = input.mapping ? { ...input.mapping } : { ...proposal.mapping };
  for (const k of Object.keys(mapping) as MappingField[]) if (!mapping[k]) delete mapping[k];
  const check = validateMapping(
    input.kind,
    mapping,
    t.fields.map((f) => f.key),
  );
  const normalized = normalizeRows(input.kind, mapping, rows, {
    sourceId: 'preview',
    origin: `Hoja: ${t.name}`,
    currency: input.currency,
  });
  const spec = KIND_SPEC[input.kind];
  return {
    table: { id: t.id, slug: t.slug, name: t.name },
    kind: input.kind,
    columns: t.fields.map((f) => ({ key: f.key, label: f.label })),
    fields: spec.allowed.map((field) => ({
      field,
      label: MAPPING_FIELD_LABEL[field],
      required: spec.required.includes(field),
    })),
    mapping,
    proposal,
    ready: check.ok,
    problems: check.problems,
    rows: rows.length,
    sampled: rows.length >= SAMPLE_ROWS,
    normalized,
  };
}

/** Las filas normalizadas como texto para una tabla de vista previa (encabezado + filas). */
export function previewGrid(
  kind: SourceKind,
  records: ReturnType<typeof normalizeRows>['records'],
  limit = 5,
): { head: string[]; rows: string[][] } {
  const m = (n: number | null) => (n === null ? '—' : money(n));
  if (isInvoiceKind(kind))
    return {
      head: ['Número', 'Fecha', 'Vence', 'NIT', 'Tercero', 'Total', 'IVA', 'Saldo', 'Moneda'],
      rows: records
        .slice(0, limit)
        .map((r) => [
          r.number,
          r.date,
          r.due ?? '—',
          r.nit || '—',
          r.party || '—',
          m(r.total),
          m(r.tax),
          m(r.balance),
          r.currency,
        ]),
    };
  if (kind === 'movimientos')
    return {
      head: ['Fecha', 'Cuenta', 'Débito', 'Crédito', 'Tercero', 'Centro de costo'],
      rows: records
        .slice(0, limit)
        .map((r) => [
          r.date,
          r.account ?? '—',
          m(r.debit),
          m(r.credit),
          r.party || '—',
          r.costCenter ?? '—',
        ]),
    };
  if (kind === 'presupuesto')
    return {
      head: ['Período', 'Cuenta', 'Centro de costo', 'Concepto', 'Valor'],
      rows: records
        .slice(0, limit)
        .map((r) => [
          r.date.slice(0, 7),
          r.account ?? '—',
          r.costCenter ?? '—',
          r.concept ?? '—',
          m(r.total),
        ]),
    };
  return {
    head: ['Número', 'Fecha', 'NIT', 'Tercero', 'Valor', 'Factura', 'Moneda'],
    rows: records
      .slice(0, limit)
      .map((r) => [
        r.number || '—',
        r.date,
        r.nit || '—',
        r.party || '—',
        m(r.total),
        r.invoiceRef ?? '—',
        r.currency,
      ]),
  };
}
