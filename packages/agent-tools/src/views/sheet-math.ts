import { formatMoney, formatNumber } from '../format/display';

/**
 * Las cuentas de la hoja que corren igual en el servidor (exportar) y en el
 * navegador (totales y subtotales de lo que el filtro deja ver). Puro, sin
 * dependencias de servidor.
 */

export type SheetOp = 'sum' | 'count' | 'avg';

/** Cómo se pinta una cifra de una columna: dinero (con su moneda), número o razón. */
export type SheetFormat =
  | { kind: 'money'; currency: string }
  | { kind: 'number' }
  | { kind: 'ratio' }
  | { kind: 'text' };

export function formatSheetNumber(n: number | null, fmt: SheetFormat): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (fmt.kind === 'money') return formatMoney(n, fmt.currency);
  if (fmt.kind === 'ratio') return `${formatNumber(Math.round(n * 1e8) / 1e6)} %`;
  return formatNumber(n);
}

/** Suma / conteo / promedio de los valores crudos de una columna; null si no hay nada que contar. */
export function sheetAggregate(
  values: ReadonlyArray<string | number | null | undefined>,
  op: SheetOp,
): number | null {
  if (op === 'count') return values.filter((v) => v !== null && v !== undefined && v !== '').length;
  const nums = values
    .map((v) => (v === null || v === undefined || v === '' ? Number.NaN : Number(v)))
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return op === 'avg' ? sum / nums.length : sum;
}

/**
 * Una suma de dinero no arrastra el error de los decimales: se redondea a los
 * decimales de la moneda (0 en pesos, 2 en dólares) para que lo que se ve cuadre.
 */
export function roundForFormat(n: number, fmt: SheetFormat): number {
  if (fmt.kind !== 'money') return n;
  const f = fmt.currency === 'COP' ? 1 : 100;
  return Math.round(n * f) / f;
}

export function sheetTotalDisplay(
  values: ReadonlyArray<string | number | null | undefined>,
  op: SheetOp,
  fmt: SheetFormat,
): string {
  const v = sheetAggregate(values, op);
  if (v === null) return op === 'count' ? '0' : '—';
  if (op === 'count') return formatNumber(v);
  return formatSheetNumber(roundForFormat(v, fmt), fmt);
}
