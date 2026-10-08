/**
 * Textos del presupuesto que también usa la pantalla (en el navegador). Aquí
 * no puede haber nada de servidor: budget/shape.ts arrastra ledger/shape.ts,
 * que usa node:crypto, y eso tumbó el build de Vercel (2026-10-08).
 */

const MONTH_NAMES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** «faltan los gastos de agosto y septiembre»; vacío si no falta ninguno. */
export function missingExpensesNote(months: readonly number[]): string {
  const names = months.map((m) => MONTH_NAMES[m - 1]).filter((n): n is string => Boolean(n));
  if (names.length === 0) return '';
  const list =
    names.length === 1
      ? (names[0] as string)
      : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
  return `faltan los gastos de ${list}`;
}
