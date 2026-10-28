/**
 * TRM OFICIAL (Superintendencia Financiera de Colombia, datos abiertos).
 *
 * Cada dato es una VIGENCIA: un valor (COP por 1 USD) que rige desde una fecha
 * hasta otra, ambas inclusive. Un viernes trae vigencia viernes→lunes, así que
 * sábados, domingos y festivos tienen valor sin que nadie lo invente. Puro y sin
 * dependencias de servidor: lo usan las fórmulas (`trm(fecha)`), el «buscar en
 * lista» por fecha, las prefacturas y las fuentes contables.
 *
 * Fuente: https://www.datos.gov.co/resource/32sa-8pi3.json
 *   { valor: "3148.02", unidad: "COP", vigenciadesde: "2026-10-28T00:00:00.000",
 *     vigenciahasta: "2026-10-28T00:00:00.000" }
 */

export interface TrmRate {
  /** «YYYY-MM-DD», inclusive. */
  from: string;
  /** «YYYY-MM-DD», inclusive. */
  to: string;
  /** Pesos por dólar. */
  value: number;
}

/** Vigencias ordenadas por `from`, sin traslapes que importen. */
export type TrmTable = readonly TrmRate[];

export const TRM_SOURCE_URL = 'https://www.datos.gov.co/resource/32sa-8pi3.json';
export const TRM_LIST_ID = 'cortex.trm';

const DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/** «2026-10-28T00:00:00.000» o «2026-10-28» → «2026-10-28»; lo demás, null. */
export function trmDay(raw: unknown): string | null {
  const m = DAY.exec(String(raw ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const chk = new Date(Date.UTC(y, mo - 1, d));
  return chk.getUTCFullYear() === y && chk.getUTCMonth() === mo - 1 && chk.getUTCDate() === d
    ? `${m[1]}-${m[2]}-${m[3]}`
    : null;
}

/** Filas crudas de Socrata → vigencias válidas ordenadas (descarta lo ilegible). */
export function parseSocrataTrm(rows: unknown): TrmRate[] {
  if (!Array.isArray(rows)) return [];
  const out: TrmRate[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const from = trmDay(r?.vigenciadesde);
    const to = trmDay(r?.vigenciahasta) ?? from;
    const value = Number(r?.valor);
    if (!from || !to || !Number.isFinite(value) || value <= 0 || to < from) continue;
    out.push({ from, to, value });
  }
  return normalizeTrm(out);
}

export function normalizeTrm(rates: readonly TrmRate[]): TrmRate[] {
  const byFrom = new Map<string, TrmRate>();
  for (const r of rates) byFrom.set(r.from, r);
  return [...byFrom.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

export type TrmLookup =
  | { ok: true; value: number; from: string; to: string }
  | { ok: false; reason: 'empty' | 'invalid_date' | 'not_published' | 'before_history' | 'gap' };

/** La TRM que rige el día `date` (vigencia que lo cubre, fines de semana y festivos incluidos). */
export function trmOn(table: TrmTable, date: unknown): TrmLookup {
  const day = trmDay(date);
  if (!day) return { ok: false, reason: 'invalid_date' };
  if (!table.length) return { ok: false, reason: 'empty' };
  let lo = 0;
  let hi = table.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((table[mid] as TrmRate).from <= day) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (idx < 0) return { ok: false, reason: 'before_history' };
  const r = table[idx] as TrmRate;
  if (day <= r.to) return { ok: true, value: r.value, from: r.from, to: r.to };
  return { ok: false, reason: idx === table.length - 1 ? 'not_published' : 'gap' };
}

/** El aviso en español de una fecha sin dato (para fórmulas, vista previa y prefacturas). */
export function trmWarning(lookup: TrmLookup, date?: unknown): string | null {
  if (lookup.ok) return null;
  const d = trmDay(date) ?? '';
  switch (lookup.reason) {
    case 'invalid_date':
      return 'La fecha para la TRM no es válida.';
    case 'empty':
      return 'Todavía no hay TRM oficial cargada.';
    case 'not_published':
      return `La TRM oficial del ${d} aún no se publica.`;
    case 'before_history':
      return `No hay TRM oficial anterior a ${d}.`;
    default:
      return `No hay TRM oficial para el ${d}.`;
  }
}

// ---------------------------------------------------------------------------
// Tabla «ambiente»: el servidor la carga de la base antes de calcular fórmulas
// que usan `trm()`; en el navegador queda vacía (el servidor recalcula al guardar).
// ---------------------------------------------------------------------------

let ambient: TrmTable = [];
let ambientAt = 0;

export function setAmbientTrm(table: TrmTable): void {
  ambient = table;
  ambientAt = Date.now();
}
export function ambientTrm(): TrmTable {
  return ambient;
}
export function ambientTrmAge(): number {
  return ambientAt ? Date.now() - ambientAt : Number.POSITIVE_INFINITY;
}

/** ¿Alguna fórmula usa trm()? Para no leer la base si no hace falta. */
export function usesTrm(fields: ReadonlyArray<{ formula?: string | null }>): boolean {
  return fields.some((f) => typeof f.formula === 'string' && /\btrm\s*\(/i.test(f.formula));
}

// ---------------------------------------------------------------------------
// Como lista de referencia («cortex.trm») para el «buscar en lista» por fecha
// ---------------------------------------------------------------------------

/** Las vigencias que viajan con un formulario: ~dos años atrás hasta lo ya publicado. */
export const TRM_MATCH_DAYS_BACK = 800;

export function trmListRows(
  table: TrmTable,
  today: string,
  daysBack = TRM_MATCH_DAYS_BACK,
): Array<Record<string, string>> {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysBack);
  const floor = d.toISOString().slice(0, 10);
  return table
    .filter((r) => r.to >= floor)
    .map((r) => ({
      vigencia_desde: r.from,
      vigencia_hasta: r.to,
      valor: String(r.value),
    }));
}
