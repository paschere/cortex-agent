/**
 * LA PARTE PURA DE TRABAJAR LA HOJA CON LAS MANOS: rellenar hacia abajo,
 * estadísticas de un rango, deshacer/rehacer de la sesión, la fila fantasma
 * que hereda el grupo, duplicar una fila, el tono de un estado y cómo se
 * reconoce una relación que ya existe (sin duplicar por nombre ni NIT).
 *
 * Sin base de datos ni React: la usan la hoja (navegador, por ruta profunda
 * —nunca el barril—) y el servidor (`createRelationRow`).
 */

import { parsePastedDate, parsePastedNumber } from './sheet-paste';

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Nombre normalizado: sin tildes, mayúsculas ni espacios de más. */
export const foldName = fold;

/**
 * Las claves con que se compara un NIT: sólo dígitos, con y sin dígito de
 * verificación («900.123.456-7» → «9001234567» y «900123456»). Un texto con
 * letras (un nombre) no es un NIT.
 */
export function nitKeys(raw: unknown): string[] {
  const t = String(raw ?? '').trim();
  if (!t || /\p{L}/u.test(t)) return [];
  const m = /^(\d[\d.\s]*)(?:-\s*(\d))?$/.exec(t);
  if (!m) return [];
  const body = (m[1] as string).replace(/\D/g, '');
  if (body.length < 5) return [];
  return m[2] ? [body, `${body}${m[2]}`] : [body];
}

/**
 * ¿Ya existe esa fila de la tabla relacionada? Por nombre normalizado; y si lo
 * escrito es un NIT, por el campo `nit` de las filas. Devuelve la primera
 * (la más reciente, si así vienen ordenadas) o null.
 */
export function matchExistingRelation<T extends { id: string; label: string; values?: Record<string, unknown> | null }>(
  existing: T[],
  typed: string,
): T | null {
  const name = fold(typed);
  if (name) {
    const byName = existing.find((r) => fold(String(r.label)) === name);
    if (byName) return byName;
  }
  const wanted = nitKeys(typed);
  if (wanted.length) {
    const byNit = existing.find((r) => nitKeys(r.values?.nit).some((k) => wanted.includes(k)));
    if (byNit) return byNit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rellenar (fill handle)
// ---------------------------------------------------------------------------

function decimalsOf(n: string): number {
  const m = /[.,](\d+)$/.exec(n.trim());
  return m ? (m[1] as string).length : 0;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const dayNumber = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

/** «FLEX 12» → prefijo «FLEX », 12; sin número al final, null. */
function splitTrailingNumber(s: string): { prefix: string; n: number; width: number } | null {
  const m = /^(.*?)(\d+)$/.exec(s.trim());
  if (!m) return null;
  return { prefix: m[1] as string, n: Number(m[2]), width: (m[2] as string).length };
}

/**
 * Los valores que cubren `count` celdas más hacia abajo, a partir de lo que ya
 * hay en el origen. Con una sola celda, o sin patrón, se copia (el origen se
 * repite en ciclo). Con patrón (números con paso fijo, fechas con paso fijo en
 * días, o texto que termina en un número que sube igual: «FLEX 1», «FLEX 2»)
 * continúa la serie. `series: false` (relaciones, opciones, sí/no) sólo copia.
 */
export function fillSeries(source: string[], count: number, series = true): string[] {
  if (count <= 0 || source.length === 0) return [];
  const copy = () => Array.from({ length: count }, (_, i) => source[i % source.length] as string);
  if (!series || source.length < 2) return copy();
  const clean = source.map((s) => s.trim());
  if (clean.some((s) => s === '')) return copy();

  // Fechas ISO con paso fijo.
  const dates = clean.map((s) => (parsePastedDate(s) ? s : null));
  if (dates.every((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d))) {
    const days = clean.map(dayNumber);
    const step = (days[1] as number) - (days[0] as number);
    if (step !== 0 && days.every((d, i) => i === 0 || d - (days[i - 1] as number) === step)) {
      const last = days[days.length - 1] as number;
      return Array.from({ length: count }, (_, i) => isoDay(new Date((last + step * (i + 1)) * 86_400_000)));
    }
    return copy();
  }

  // Números con paso fijo.
  const nums = clean.map((s) => parsePastedNumber(s));
  if (nums.every((n): n is number => n !== null)) {
    const step = (nums[1] as number) - (nums[0] as number);
    const eps = 1e-9 * Math.max(1, Math.abs(step));
    if (Math.abs(step) > eps && nums.every((n, i) => i === 0 || Math.abs(n - (nums[i - 1] as number) - step) < eps)) {
      const dec = Math.max(...clean.map(decimalsOf), decimalsOf(String(step)));
      const last = nums[nums.length - 1] as number;
      return Array.from({ length: count }, (_, i) => String(Number((last + step * (i + 1)).toFixed(Math.min(dec, 6)))));
    }
    return copy();
  }

  // Texto que termina en un número que sube igual.
  const parts = clean.map(splitTrailingNumber);
  if (parts.every((p): p is NonNullable<typeof p> => p !== null)) {
    const first = parts[0] as NonNullable<(typeof parts)[number]>;
    const step = (parts[1] as NonNullable<(typeof parts)[number]>).n - first.n;
    const samePrefix = parts.every((p) => p.prefix === first.prefix);
    if (samePrefix && step !== 0 && parts.every((p, i) => i === 0 || p.n - (parts[i - 1] as typeof p).n === step)) {
      const last = parts[parts.length - 1] as typeof first;
      const width = parts.every((p) => p.width === first.width) ? first.width : 0;
      return Array.from({ length: count }, (_, i) => {
        const n = last.n + step * (i + 1);
        return `${first.prefix}${width ? String(n).padStart(width, '0') : n}`;
      });
    }
  }
  return copy();
}

export interface FillTarget {
  id: string;
  /** El valor de la celda ahora (crudo). */
  before: string;
}

/**
 * Un relleno como un solo lote: sólo las filas cuyo valor cambia, con lo que
 * había (para deshacer). `source` es lo que se arrastra; `targets`, las filas
 * que se cubren, de arriba abajo.
 */
export function planFill(
  key: string,
  source: string[],
  targets: FillTarget[],
  series = true,
): Array<{ rowId: string; key: string; before: string; after: string }> {
  const values = fillSeries(source, targets.length, series);
  return targets.flatMap((t, i) => {
    const after = values[i] ?? '';
    return after === t.before ? [] : [{ rowId: t.id, key, before: t.before, after }];
  });
}

// ---------------------------------------------------------------------------
// Estadísticas de un rango
// ---------------------------------------------------------------------------

export interface RangeStats {
  count: number;
  numeric: number;
  sum: number;
  avg: number | null;
  min: number | null;
  max: number | null;
}

/** Suma, promedio, conteo, mínimo y máximo de los numéricos de un rango (los vacíos no cuentan). */
export function rangeStats(values: Array<string | number | null | undefined>): RangeStats {
  let count = 0;
  const nums: number[] = [];
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    count += 1;
    const n = typeof v === 'number' ? v : parsePastedNumber(String(v));
    if (n !== null && Number.isFinite(n)) nums.push(n);
  }
  const sum = nums.reduce((a, b) => a + b, 0);
  return {
    count,
    numeric: nums.length,
    sum,
    avg: nums.length ? sum / nums.length : null,
    min: nums.length ? Math.min(...nums) : null,
    max: nums.length ? Math.max(...nums) : null,
  };
}

// ---------------------------------------------------------------------------
// Deshacer y rehacer de la sesión
// ---------------------------------------------------------------------------

export interface EditChange {
  rowId: string;
  key: string;
  before: string;
  after: string;
}

export interface HistoryEntry {
  label: string;
  changes: EditChange[];
}

/**
 * La pila de ediciones de esta sesión. Deshacer devuelve el lote que hay que
 * escribir con el valor de antes (y `expect` = el valor de después, para no
 * pisar lo que otro cambió); rehacer, al revés. Un cambio nuevo borra lo
 * que se podía rehacer.
 */
export class EditHistory {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  constructor(private readonly limit = 60) {}

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get nextUndo(): HistoryEntry | null {
    return this.past[this.past.length - 1] ?? null;
  }
  get nextRedo(): HistoryEntry | null {
    return this.future[this.future.length - 1] ?? null;
  }

  push(entry: HistoryEntry): void {
    if (!entry.changes.length) return;
    this.past.push(entry);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  /** Saca lo último; quien llama lo escribe al revés y, si falla, lo devuelve con `restore`. */
  takeUndo(): { entry: HistoryEntry; write: EditChange[] } | null {
    const entry = this.past.pop();
    if (!entry) return null;
    return { entry, write: entry.changes.map((c) => ({ ...c, before: c.after, after: c.before })) };
  }
  takeRedo(): { entry: HistoryEntry; write: EditChange[] } | null {
    const entry = this.future.pop();
    if (!entry) return null;
    return { entry, write: entry.changes };
  }
  /** Se escribió: pasa al otro lado. */
  confirmUndo(entry: HistoryEntry): void {
    this.future.push(entry);
  }
  confirmRedo(entry: HistoryEntry): void {
    this.past.push(entry);
  }
  /** No se pudo escribir: vuelve a donde estaba. */
  restoreUndo(entry: HistoryEntry): void {
    this.past.push(entry);
  }
  restoreRedo(entry: HistoryEntry): void {
    this.future.push(entry);
  }
}

/** Un lote de cambios agrupado por fila: lo que pide el servidor. */
export function groupByRow(changes: EditChange[]): Array<{ rowId: string; patch: Record<string, string>; expect: Record<string, string> }> {
  const out = new Map<string, { rowId: string; patch: Record<string, string>; expect: Record<string, string> }>();
  for (const c of changes) {
    const row = out.get(c.rowId) ?? { rowId: c.rowId, patch: {}, expect: {} };
    row.patch[c.key] = c.after;
    row.expect[c.key] = c.before;
    out.set(c.rowId, row);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Fila fantasma y duplicar
// ---------------------------------------------------------------------------

/**
 * Los valores de una fila que nace de la fila fantasma: lo escrito celda por
 * celda (el borrador) y, dentro de un grupo, el valor de agrupación (el
 * manifiesto), igual que el botón «Fila aquí». Si el borrador ya trae el campo
 * de agrupación (la persona lo eligió a mano), manda lo escrito.
 */
export function ghostValues(input: {
  draft: Record<string, string>;
  groupField?: string | null;
  groupKey?: string | null;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.draft)) if (v.trim() !== '') out[k] = v.trim();
  if (input.groupField && input.groupKey && !(input.groupField in out))
    out[input.groupField] = input.groupKey;
  return out;
}

/** El valor de agrupación sólo sirve si es un id o un valor común (nunca la clave del grupo «Sin …»). */
export function groupKeyUsable(key: string): boolean {
  return key !== '';
}

/**
 * La copia de una fila: todos los campos que la hoja deja escribir, con la
 * clave de pegado marcada «(copia)» (o vacía si no es texto) para que no se
 * confunda con la original ni la pise.
 */
export function duplicateValues(
  fields: Array<{ key: string; type: string }>,
  raw: Record<string, string | number | null | undefined>,
  pasteKey: string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = raw[f.key];
    if (v === null || v === undefined || v === '') continue;
    if (f.key === pasteKey) {
      if (f.type === 'text') out[f.key] = `${String(v)} (copia)`;
      continue;
    }
    out[f.key] = String(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Estados: tono y avance
// ---------------------------------------------------------------------------

export type StatusTone = 'emerald' | 'rose' | 'amber' | 'sky';

const word = (f: string, re: string) => new RegExp(`(^|[^a-z])(${re})([^a-z]|$)`).test(f);

/**
 * El color de un estado según lo que dice («OK», «Aprobado» → verde;
 * «Rechazado», «Error» → rojo; «Pendiente», «Por revisar» → ámbar; «Enviado a
 * Siigo» → azul). Sin pista, null: el chip queda neutro.
 */
export function statusTone(label: string): StatusTone | null {
  const f = fold(label);
  if (!f) return null;
  if (/rechaz|error|vencid|cancelad|anulad|fallid|bloquead|devuelt/.test(f)) return 'rose';
  if (/enviad|factur|siigo|contabiliz|sincroniz/.test(f)) return 'sky';
  if (word(f, 'ok') || /aprobad|listo|hecho|pagad|complet|entregad|cerrad|resuelt|recibid|confirmad|finaliz/.test(f)) return 'emerald';
  if (/pendient|espera|revisar|borrador|proceso|nuevo|abiert|por /.test(f)) return 'amber';
  return null;
}

/** ¿Es un estado final (para la barra de avance)? Aprobado, enviado, pagado… */
export function isFinalStatus(label: string): boolean {
  const t = statusTone(label);
  return t === 'emerald' || t === 'sky';
}

export interface GroupProgress {
  done: number;
  total: number;
  rejected: number;
}

/** Avance de un grupo: cuántas filas están en estado final, sobre el total; y cuántas rechazadas. */
export function groupProgress(statuses: string[]): GroupProgress {
  let done = 0;
  let rejected = 0;
  for (const s of statuses) {
    if (isFinalStatus(s)) done += 1;
    else if (statusTone(s) === 'rose') rejected += 1;
  }
  return { done, total: statuses.length, rejected };
}

/** ¿Esta columna es de estados (opciones que dicen algo de avance)? Para elegir la barra de avance. */
export function looksLikeStatusColumn(options: string[]): boolean {
  return options.length >= 2 && options.some((o) => isFinalStatus(o));
}

/** «hace 2 s», «hace 3 min», «hace 1 h». */
export function savedAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'ahora mismo';
  if (s < 60) return `hace ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  return `hace ${Math.floor(m / 60)} h`;
}
