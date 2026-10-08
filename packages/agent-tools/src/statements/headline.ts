import type { ProviderPnl } from '../accounting/providers/reports';
import { round2 } from '../ledger/shape';
import { type IncomeStatement, expensesMissing } from './income';

/**
 * LAS CIFRAS GRANDES DE /estados (0191). Puro.
 *
 * Una sola regla de precedencia para las tarjetas de arriba, el informe para
 * socios y el chat: el estado de resultados CONTABLE del programa (si se trajo
 * y trae algo) manda sobre el de CAJA del libro de plata. Y una sola regla de
 * honestidad: si hay ventas y ningún gasto en la fuente, no se afirma utilidad
 * ni margen; se dice que faltan los gastos.
 */

export interface HeadlineFigure {
  /** `null` = no se puede afirmar con lo que hay. */
  now: number | null;
  prev: number | null;
}

export interface Headline {
  basis: 'contable' | 'caja';
  /** «Siigo (contable)» o «Libro de plata (de caja)». */
  sourceLabel: string;
  sales: HeadlineFigure;
  operating: HeadlineFigure;
  net: HeadlineFigure;
  /** Utilidad neta ÷ ventas; `null` si no hay ventas o faltan los gastos. */
  netMargin: number | null;
  missingExpenses: boolean;
  /** El comparativo no cubre todo el tramo (o no existe). */
  prevNote: string | null;
}

/** El estado de resultados contable sirve para las tarjetas si trae algo. */
export function providerPnlUsable(p: ProviderPnl | null | undefined): p is ProviderPnl {
  return Boolean(
    p &&
      Number.isFinite(p.revenue) &&
      Number.isFinite(p.netIncome) &&
      (Math.abs(p.revenue) > 0.5 || Math.abs(p.netIncome) > 0.5),
  );
}

function providerMissingExpenses(p: ProviderPnl): boolean {
  const out = p.costOfSales + p.operatingExpenses + p.otherExpenses + (p.incomeTax ?? 0);
  return p.revenue + p.otherIncome > 0.5 && Math.abs(out) < 0.5;
}

export function providerOperating(p: ProviderPnl): number {
  return round2(p.revenue - p.costOfSales - p.operatingExpenses);
}

export function headline(
  income: IncomeStatement,
  accounting: { pnl: ProviderPnl | null; pnlPrev: ProviderPnl | null },
  providerLabel: string | null,
): Headline {
  const p = accounting.pnl;
  if (providerPnlUsable(p)) {
    const prev = providerPnlUsable(accounting.pnlPrev) ? accounting.pnlPrev : null;
    const missing = providerMissingExpenses(p);
    const margin = !missing && p.revenue > 0.5 ? p.netIncome / p.revenue : null;
    return {
      basis: 'contable',
      sourceLabel: `${providerLabel ?? 'Programa contable'} (contable)`,
      sales: { now: p.revenue, prev: prev ? prev.revenue : null },
      operating: {
        now: missing ? null : providerOperating(p),
        prev: prev && !providerMissingExpenses(prev) ? providerOperating(prev) : null,
      },
      net: {
        now: missing ? null : p.netIncome,
        prev: prev && !providerMissingExpenses(prev) ? prev.netIncome : null,
      },
      netMargin: margin !== null && Number.isFinite(margin) ? margin : null,
      missingExpenses: missing,
      prevNote: prev ? null : `Sin datos de ${income.year - 1} para comparar`,
    };
  }
  const missing = income.expensesMissingYtd;
  const prev = income.ytdPrev;
  const prevMissing = prev ? expensesMissing(prev) : false;
  const margin =
    !missing && income.ytd.ingresos > 0.5 ? income.ytd.utilidad_neta / income.ytd.ingresos : null;
  let prevNote: string | null = null;
  if (!prev) prevNote = `Sin datos de ${income.year - 1} para comparar`;
  else if (income.prevMonthsWithData < income.throughMonth)
    prevNote = `${income.year - 1} sólo tiene datos de ${income.prevMonthsWithData} de ${income.throughMonth} meses: el cambio no es comparable`;
  return {
    basis: 'caja',
    sourceLabel: 'Libro de plata (de caja)',
    sales: { now: income.ytd.ingresos, prev: prev ? prev.ingresos : null },
    operating: {
      now: missing ? null : income.ytd.utilidad_operacional,
      prev: prev && !prevMissing ? prev.utilidad_operacional : null,
    },
    net: {
      now: missing ? null : income.ytd.utilidad_neta,
      prev: prev && !prevMissing ? prev.utilidad_neta : null,
    },
    netMargin: margin !== null && Number.isFinite(margin) ? margin : null,
    missingExpenses: missing,
    prevNote,
  };
}

/** Qué decirle al dueño cuando faltan los gastos (y de dónde traerlos). */
export const MISSING_EXPENSES_HELP =
  'Hay ventas pero ningún gasto registrado, así que la utilidad y los márgenes no se pueden afirmar. Trae los gastos: sube los extractos del banco en Finanzas, conecta o actualiza Siigo, o carga las facturas de compra.';
