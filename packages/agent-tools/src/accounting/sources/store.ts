import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { originsOf } from '../../trackers/origin';
import type { Precedence, SourceBatch } from './combine';
import {
  KIND_SPEC,
  type Mapping,
  type RawRow,
  SOURCE_KINDS,
  type SourceKind,
  isInvoiceKind,
  normalizeRows,
  validateMapping,
} from './shape';

/**
 * LAS TABLAS DECLARADAS COMO FUENTE CONTABLE (0239): guardar, listar, quitar y
 * LEER sus filas ya normalizadas. Sin la migración puesta todo responde
 * «ninguna fuente»: las cifras de siempre no se caen por esto.
 */

export interface AccountingSource {
  id: string;
  trackerId: string;
  trackerSlug: string;
  trackerName: string;
  /** El tipo de origen de la tabla: «sheet» si la llena una hoja conectada. */
  tableOrigin: 'sheet' | 'drive_folder' | 'accounting' | 'own';
  kind: SourceKind;
  label: string;
  /** Lo que ven las cifras: «Hoja: Ventas Medellín» o «Tabla: …». */
  origin: string;
  mapping: Mapping;
  precedence: Precedence;
  currency: string;
  sumRepeated: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS =
  'id, tracker_id, kind, label, mapping, precedence, options, enabled, created_at, updated_at';
const PAGE = 1000;
export const MAX_SOURCE_ROWS = 20_000;

function isMissingTable(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return (
    e?.code === '42P01' ||
    e?.code === 'PGRST205' ||
    (/accounting_sources/.test(e?.message ?? '') &&
      /does not exist|schema cache/i.test(e?.message ?? ''))
  );
}

export function originLabel(tableOrigin: AccountingSource['tableOrigin'], label: string): string {
  return tableOrigin === 'sheet' ? `Hoja: ${label}` : `Tabla: ${label}`;
}

interface DbSource {
  id: string;
  tracker_id: string;
  kind: SourceKind;
  label: string;
  mapping: Mapping;
  precedence: Precedence;
  options: { currency?: string; sumRepeated?: boolean } | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

async function trackerInfo(db: SupabaseClient, ids: string[]) {
  const out = new Map<
    string,
    { slug: string; name: string; origin: AccountingSource['tableOrigin']; columns: string[] }
  >();
  if (!ids.length) return out;
  const { data } = await db
    .from('trackers')
    .select('id, slug, name, fields, origins')
    .in('id', ids);
  for (const t of (data ?? []) as Array<{
    id: string;
    slug: string;
    name: string;
    fields: Array<{ key: string }> | null;
    origins: unknown;
  }>) {
    const origins = originsOf(t);
    const kind = origins.find((o) => o.kind === 'accounting')
      ? 'accounting'
      : (origins.find((o) => o.kind === 'sheet')?.kind ?? origins[0]?.kind ?? 'own');
    out.set(t.id, {
      slug: t.slug,
      name: t.name,
      origin: kind as AccountingSource['tableOrigin'],
      columns: (t.fields ?? []).map((f) => f.key),
    });
  }
  return out;
}

export async function listAccountingSources(
  db: SupabaseClient,
  opts: { kind?: SourceKind; onlyEnabled?: boolean } = {},
): Promise<AccountingSource[]> {
  let q = db.from('accounting_sources').select(COLUMNS).order('created_at', { ascending: true });
  if (opts.kind) q = q.eq('kind', opts.kind);
  if (opts.onlyEnabled) q = q.eq('enabled', true);
  const { data, error } = await q;
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  const rows = (data ?? []) as unknown as DbSource[];
  const info = await trackerInfo(db, [...new Set(rows.map((r) => r.tracker_id))]);
  return rows
    .filter((r) => info.has(r.tracker_id))
    .map((r) => {
      const t = info.get(r.tracker_id) as NonNullable<ReturnType<typeof info.get>>;
      return {
        id: r.id,
        trackerId: r.tracker_id,
        trackerSlug: t.slug,
        trackerName: t.name,
        tableOrigin: t.origin,
        kind: r.kind,
        label: r.label,
        origin: originLabel(t.origin, r.label),
        mapping: r.mapping ?? {},
        precedence: r.precedence,
        currency: (r.options?.currency ?? 'COP').toUpperCase(),
        sumRepeated: Boolean(r.options?.sumRepeated),
        enabled: r.enabled,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
}

export interface SaveSourceInput {
  tracker: string;
  kind: SourceKind;
  label?: string;
  mapping: Mapping;
  precedence?: Precedence;
  currency?: string;
  sumRepeated?: boolean;
  userId?: string | null;
}

export async function saveAccountingSource(
  db: SupabaseClient,
  input: SaveSourceInput,
): Promise<AccountingSource> {
  if (!SOURCE_KINDS.includes(input.kind)) throw new ValidationError('Tipo de fuente desconocido.');
  const { data: t, error: te } = await db
    .from('trackers')
    .select('id, slug, name, fields, origins')
    .eq('slug', input.tracker)
    .maybeSingle();
  if (te) throw te;
  if (!t)
    throw new NotFoundError(
      `No hay una tabla «${input.tracker}». Mira los slugs con trackers.list.`,
    );
  const tracker = t as {
    id: string;
    slug: string;
    name: string;
    fields: Array<{ key: string }>;
    origins: unknown;
  };
  if (originsOf(tracker).some((o) => o.kind === 'accounting'))
    throw new ValidationError(
      `«${tracker.name}» ya la llena el programa contable: sus facturas entran solas a las cifras. Declarar esa tabla como fuente las contaría dos veces.`,
    );
  const check = validateMapping(
    input.kind,
    input.mapping,
    (tracker.fields ?? []).map((f) => f.key),
  );
  if (!check.ok) throw new ValidationError(check.problems.join(' '));
  const label = (input.label ?? tracker.name).trim().slice(0, 80) || tracker.name;
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('accounting_sources')
    .upsert(
      {
        tracker_id: tracker.id,
        kind: input.kind,
        label,
        mapping: input.mapping,
        precedence: input.precedence ?? 'program',
        options: {
          currency: (input.currency ?? 'COP').toUpperCase(),
          sumRepeated: Boolean(input.sumRepeated),
        },
        enabled: true,
        created_by: input.userId ?? null,
        updated_at: now,
      },
      { onConflict: 'organization_id,tracker_id,kind' },
    )
    .select(COLUMNS)
    .single();
  if (error) throw new Error(`No se pudo guardar la fuente: ${error.message}`);
  const all = await listAccountingSources(db, { kind: input.kind });
  const saved = all.find((s) => s.id === (data as unknown as DbSource).id);
  if (!saved) throw new Error('La fuente se guardó pero no se pudo leer de vuelta.');
  return saved;
}

export async function removeAccountingSource(
  db: SupabaseClient,
  ref: { id?: string; tracker?: string; kind?: SourceKind },
): Promise<AccountingSource[]> {
  const all = await listAccountingSources(db);
  const hit = all.filter((s) =>
    ref.id ? s.id === ref.id : s.trackerSlug === ref.tracker && (!ref.kind || s.kind === ref.kind),
  );
  if (!hit.length) throw new NotFoundError('No hay una fuente contable con esos datos.');
  const { error } = await db
    .from('accounting_sources')
    .delete()
    .in(
      'id',
      hit.map((h) => h.id),
    );
  if (error) throw new Error(`No se pudo quitar la fuente: ${error.message}`);
  return hit;
}

export async function setAccountingSourceEnabled(
  db: SupabaseClient,
  id: string,
  enabled: boolean,
): Promise<void> {
  const { error } = await db
    .from('accounting_sources')
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`No se pudo cambiar la fuente: ${error.message}`);
}

/** Las filas de una tabla, de a mil, hasta el tope. */
export async function readTableRows(
  db: SupabaseClient,
  trackerId: string,
  limit = MAX_SOURCE_ROWS,
): Promise<{ rows: RawRow[]; truncated: boolean }> {
  const rows: RawRow[] = [];
  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await db
      .from('tracker_rows')
      .select('id, values')
      .eq('tracker_id', trackerId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data ?? []) as Array<{ id: string; values: Record<string, unknown> | null }>;
    for (const r of page) rows.push({ id: r.id, values: r.values ?? {} });
    if (page.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export interface LoadedBatch extends SourceBatch {
  source: AccountingSource;
  stats: ReturnType<typeof normalizeRows>['stats'];
  truncated: boolean;
}

/**
 * Lee y normaliza cada fuente habilitada de un tipo. Una tabla que no se puede
 * leer deja un aviso y sigue: una hoja rota no tumba la cartera.
 */
export async function loadSourceBatches(
  db: SupabaseClient,
  kind: SourceKind,
): Promise<LoadedBatch[]> {
  const sources = await listAccountingSources(db, { kind, onlyEnabled: true });
  const out: LoadedBatch[] = [];
  for (const source of sources) {
    try {
      const { rows, truncated } = await readTableRows(db, source.trackerId);
      const n = normalizeRows(kind, source.mapping, rows, {
        sourceId: source.id,
        origin: source.origin,
        currency: source.currency,
        sumRepeated: source.sumRepeated,
      });
      const issues = [...n.issues];
      if (truncated)
        issues.push({
          rowId: null,
          code: 'fuente_ilegible',
          severity: 'aviso',
          message: `${source.origin}: tiene más de ${MAX_SOURCE_ROWS} filas; sólo se leyeron las primeras.`,
        });
      out.push({
        sourceId: source.id,
        label: source.origin,
        precedence: source.precedence,
        records: n.records,
        issues,
        source,
        stats: n.stats,
        truncated,
      });
    } catch (err) {
      out.push({
        sourceId: source.id,
        label: source.origin,
        precedence: source.precedence,
        records: [],
        issues: [
          {
            rowId: null,
            code: 'fuente_ilegible',
            severity: 'aviso',
            message: `${source.origin}: no se pudo leer la tabla (${err instanceof Error ? err.message : 'error'}).`,
          },
        ],
        source,
        stats: { rows: 0, used: 0, rejected: 0, warnings: 0, blank: 0 },
        truncated: false,
      });
    }
  }
  return out;
}

export const requiredFieldsText = (kind: SourceKind): string =>
  KIND_SPEC[kind].required.join(', ') +
  (isInvoiceKind(kind) ? ' (saldo y vencimiento opcionales)' : '');
