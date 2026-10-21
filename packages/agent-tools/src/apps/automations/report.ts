import { formatDay, formatLoose, formatNumber } from '../../format/display';
import { type ViewSource, aggregate, formatValue, matches, todayIn } from '../../views/compute';
import { type ViewFilter, fieldType } from '../../views/spec';
import { displayTrackerValue } from '../../trackers/schema';
import {
  REPORT_DETAIL_ROWS,
  REPORT_OP_LABEL,
  type ReportMetric,
  type ReportOp,
  type ReportQuerySource,
} from './report-spec';
import { type DayRange, bogotaDayOf, inRange, resolveRange } from './report-range';

/**
 * UN REPORTE ARMADO (módulo puro: sin base, sin reloj, sin red).
 *
 * `runReportQuery` toma las filas de UNA tabla (ya leídas, con el scope que
 * corresponda) y devuelve tablas listas para pintar: el correo en HTML, el
 * Excel y el PDF salen TODOS de esta misma estructura, así que no pueden
 * decir cifras distintas. Los pesos se escriben completos (nunca «1,2 M»).
 */

export type ColumnKind = 'text' | 'number' | 'money' | 'count';
export type Cell = string | number | null;

export interface ReportColumn {
  label: string;
  kind: ColumnKind;
}

export interface ReportTable {
  title: string;
  columns: ReportColumn[];
  rows: Cell[][];
  /** Fila de totales (se pinta en negrita). */
  totals?: Cell[];
  /** Sólo en adjuntos (el cuerpo del correo no la pinta). */
  attachmentOnly?: boolean;
}

export interface ReportResult {
  tables: ReportTable[];
  /** Filas de la tabla que entraron al reporte (después de filtros y rango). */
  rowCount: number;
  /** La lectura se cortó en el tope y hay más filas que no se contaron. */
  truncated: boolean;
  range: DayRange | null;
  notes: string[];
}

const NO_GROUP = 'Sin dato';

function metricKind(op: ReportOp, fieldKindOf: ColumnKind): ColumnKind {
  if (op === 'count') return 'count';
  return fieldKindOf === 'money' ? 'money' : 'number';
}

export function metricTitle(
  m: ReportMetric,
  fields: Array<{ key: string; label: string }>,
): string {
  if (m.label) return m.label;
  if (m.op === 'count') return 'Cantidad';
  const f = fields.find((x) => x.key === m.field)?.label ?? m.field ?? '';
  return `${REPORT_OP_LABEL[m.op]} de ${f}`;
}

/** Problemas de una consulta contra la tabla real (campos que no existen, cifras sobre texto…). */
export function reportQueryProblems(
  q: ReportQuerySource,
  tracker: { slug: string; fields: Array<{ key: string; type: string }> },
): string[] {
  const out: string[] = [];
  const known = new Set(tracker.fields.map((f) => f.key));
  const builtin = new Set(['label', 'created_at', 'updated_at']);
  const has = (k: string) => known.has(k) || builtin.has(k);
  if (q.groupBy && !has(q.groupBy)) out.push(`«${q.groupBy}» no es un campo de «${q.tracker}».`);
  for (const m of q.metrics) {
    if (m.op !== 'count') {
      if (!m.field) out.push(`${REPORT_OP_LABEL[m.op]} necesita \`field\` (un campo numérico).`);
      else if (!known.has(m.field)) out.push(`«${m.field}» no es un campo de «${q.tracker}».`);
      else {
        const type = tracker.fields.find((f) => f.key === m.field)?.type;
        if (type !== 'number' && type !== 'money')
          out.push(`«${m.field}» no es numérico: ${REPORT_OP_LABEL[m.op].toLowerCase()} sólo sirve con números o dinero.`);
      }
    }
  }
  for (const f of q.where) if (!has(f.field)) out.push(`El filtro nombra «${f.field}», que no es un campo de «${q.tracker}».`);
  if (q.range) {
    if (!has(q.range.field)) out.push(`El rango nombra «${q.range.field}», que no es un campo de «${q.tracker}».`);
    else if (!builtin.has(q.range.field)) {
      const type = tracker.fields.find((f) => f.key === q.range?.field)?.type;
      if (type !== 'date') out.push(`«${q.range.field}» no es una fecha: el rango necesita un campo de fecha (o created_at).`);
    }
  }
  return out;
}

function groupLabel(source: ViewSource, row: ViewSource['rows'][number], key: string): string {
  if (key === 'label') return row.label || NO_GROUP;
  if (key === 'created_at' || key === 'updated_at')
    return dayLabel(bogotaDayOf(key === 'created_at' ? row.created_at : row.updated_at));
  const raw = row.values[key];
  if (raw === undefined || raw === '') return NO_GROUP;
  const type = fieldType(source.tracker, key);
  if (type === 'relation' || type === 'file' || type === 'checkbox')
    return displayTrackerValue({ type }, raw) || NO_GROUP;
  if (type === 'money') return formatCell(Number(raw), 'money');
  if (type === 'number') return formatCell(Number(raw), 'number');
  return formatLoose(String(raw).trim()) === '—' ? NO_GROUP : formatLoose(String(raw).trim());
}

const dayLabel = (day: string | null | undefined) => (day ? formatDay(day) : NO_GROUP);

function dayOfRow(row: ViewSource['rows'][number], key: string): string | null {
  if (key === 'created_at') return bogotaDayOf(row.created_at);
  if (key === 'updated_at') return bogotaDayOf(row.updated_at);
  return bogotaDayOf(row.values[key]);
}

const MONEY_FULL = (n: number) => formatValue(n, 'money');

/** Un número como se lee en el reporte (pesos completos, nada de «M»). */
export function formatCell(value: Cell, kind: ColumnKind): string {
  if (value === null || value === '') return '—';
  if (typeof value === 'string') return value;
  if (kind === 'money') return MONEY_FULL(value);
  if (kind === 'count') return formatNumber(value, 0);
  return formatNumber(value, 2);
}

export function runReportQuery(q: ReportQuerySource, source: ViewSource, now: Date): ReportResult {
  const tracker = source.tracker;
  const today = todayIn(now);
  const range = q.range ? resolveRange(q.range.preset, now) : null;
  const filters: ViewFilter[] = q.where;
  const rows = source.rows.filter((r) => {
    if (range && q.range && !inRange(dayOfRow(r, q.range.field), range)) return false;
    return filters.every((f) => matches(tracker, r, f, today));
  });

  const labelOf = (key: string) => tracker.fields.find((f) => f.key === key)?.label ?? key;
  const kindOfField = (key: string | undefined): ColumnKind =>
    key && fieldType(tracker, key) === 'money' ? 'money' : 'number';
  const metricCols: ReportColumn[] = q.metrics.map((m) => ({
    label: metricTitle(m, tracker.fields),
    kind: metricKind(m.op, kindOfField(m.field)),
  }));
  const calc = (list: typeof rows): Cell[] =>
    q.metrics.map((m) => {
      const v = aggregate(list, m.op, m.field);
      return v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
    });

  const notes: string[] = [];
  if (source.truncated)
    notes.push('La tabla tiene más filas de las que se pueden leer de una vez; las cifras no incluyen las más antiguas.');

  let main: ReportTable;
  if (q.groupBy) {
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const g = groupLabel(source, r, q.groupBy);
      const list = groups.get(g);
      if (list) list.push(r);
      else groups.set(g, [r]);
    }
    let out = [...groups.entries()].map(([g, list]) => ({ g, values: calc(list) }));
    if (q.sort === 'label') out.sort((a, b) => a.g.localeCompare(b.g, 'es'));
    else {
      const dir = q.sort === 'asc' ? 1 : -1;
      out.sort((a, b) => dir * (Number(a.values[0] ?? 0) - Number(b.values[0] ?? 0)) || a.g.localeCompare(b.g, 'es'));
    }
    if (out.length > q.limit) {
      notes.push(`Hay ${out.length} grupos; se muestran los primeros ${q.limit}. El total incluye todos.`);
      out = out.slice(0, q.limit);
    }
    main = {
      title: q.range ? tracker.name : tracker.name,
      columns: [{ label: labelOf(q.groupBy), kind: 'text' }, ...metricCols],
      rows: out.map((o) => [o.g, ...o.values]),
      totals: ['Total', ...calc(rows)],
    };
  } else {
    main = {
      title: tracker.name,
      columns: metricCols,
      rows: [calc(rows)],
    };
  }

  const tables = [main];
  if (q.detail) {
    const detailFields = [
      ...(q.groupBy && q.groupBy !== 'label' ? [q.groupBy] : []),
      ...(q.range && q.range.field !== q.groupBy ? [q.range.field] : []),
      ...q.metrics.flatMap((m) => (m.field ? [m.field] : [])),
    ].filter((k, i, a) => a.indexOf(k) === i);
    const detailRows = rows.slice(0, REPORT_DETAIL_ROWS);
    if (rows.length > REPORT_DETAIL_ROWS)
      notes.push(`El detalle trae las primeras ${REPORT_DETAIL_ROWS} de ${rows.length} filas.`);
    main.attachmentOnly = false;
    tables.push({
      title: `Detalle · ${tracker.name}`,
      attachmentOnly: true,
      columns: [
        { label: 'Registro', kind: 'text' },
        ...detailFields.map((k) => ({
          label: labelOf(k),
          kind: (fieldType(tracker, k) === 'money' ? 'money' : fieldType(tracker, k) === 'number' ? 'number' : 'text') as ColumnKind,
        })),
      ],
      rows: detailRows.map((r) => [
        r.label,
        ...detailFields.map((k): Cell => {
          const type = fieldType(tracker, k);
          if (type === 'money' || type === 'number') {
            const n = Number(r.values[k]);
            return r.values[k] === undefined || r.values[k] === '' || !Number.isFinite(n) ? null : n;
          }
          return groupLabel(source, r, k) === NO_GROUP ? null : groupLabel(source, r, k);
        }),
      ]),
    });
  }
  return { tables, rowCount: rows.length, truncated: source.truncated, range, notes };
}

/** Una frase que describe el reporte, para el historial de la corrida y la lista de reglas. */
export function describeReportSource(
  s: ReportQuerySource | { kind: 'screen'; screen: string },
): string {
  if (s.kind === 'screen') return `la pantalla «${s.screen}»`;
  const what = s.metrics
    .map((m) => (m.op === 'count' ? 'cantidad' : `${REPORT_OP_LABEL[m.op].toLowerCase()} de ${m.field}`))
    .join(' y ');
  return `${what} de «${s.tracker}»${s.groupBy ? ` por ${s.groupBy}` : ''}${s.range ? ` (${s.range.preset})` : ''}`;
}
