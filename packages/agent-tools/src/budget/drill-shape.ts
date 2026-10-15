/** El detalle de una categoría del presupuesto en un mes (0228). Sólo tipos y fechas. */

export interface DrillRow {
  id: string;
  date: string;
  counterparty: string | null;
  description: string;
  /** Gasto positivo; una devolución, negativa. */
  amount: number;
}

export interface BudgetDrill {
  category: string;
  label: string;
  year: number;
  month: number;
  total: number;
  count: number;
  rows: DrillRow[];
  truncated: boolean;
  /** La nómina de quien no administra no se detalla. */
  confidential: boolean;
}

export function periodEndOf(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}
