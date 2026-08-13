/**
 * Cómo se leen las fechas y el dinero en la pantalla de Pagos.
 *
 * Una fecha `AAAA-MM-DD` se formatea DESDE SU CADENA y jamás a través de un
 * `Date`: convertir "2026-07-03" en Date y volver a formatearlo es cómo un
 * abono del 3 aparece como el 2 para cualquiera cuyo navegador esté al oeste de
 * Bogotá. Es el mismo criterio de `clients/_components/format.ts`.
 *
 * Y EL DINERO SIEMPRE LLEVA SU MONEDA PEGADA. No hay ninguna función aquí que
 * formatee un importe sin ella: en un producto que maneja facturas de
 * importación, un "$4.200.000" a secas es una cifra que se puede leer de dos
 * formas que difieren por un factor de cuatro mil.
 */

const MONTHS_SHORT = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

/** "3 jul 2026" — desde una fecha de calendario, sin construir nunca un Date. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${Number(d)} ${MONTHS_SHORT[Number(m) - 1] ?? m} ${y}`;
}

/** "$4.200.000 COP". La moneda no es opcional. */
export function money(amount: number, currency: string): string {
  const figure = amount.toLocaleString('es-CO', {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `$${figure} ${currency}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
