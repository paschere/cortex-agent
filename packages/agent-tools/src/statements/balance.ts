import type { ProviderBalance } from '../accounting/providers/reports';
import { round2 } from '../ledger/shape';

/**
 * EL BALANCE GENERAL (0191). Puro.
 *
 * Dos orígenes, y la pantalla siempre dice cuál:
 *
 *   contable     el del programa contable (Siigo, Alegra, QuickBooks), leído
 *                y traducido en accounting/providers/reports*.ts.
 *   aproximado   sin programa contable (o si no contestó): lo que Cortex SÍ
 *                sabe — la caja de las cuentas, la cartera por cobrar, el
 *                valor del inventario y las facturas por pagar — y la lista
 *                explícita de lo que NO sabe. El patrimonio que sale es una
 *                diferencia, no un dato, y se dice así.
 */

export type BalanceLineSection =
  | 'activo_corriente'
  | 'activo_no_corriente'
  | 'pasivo_corriente'
  | 'pasivo_no_corriente'
  | 'patrimonio'
  | 'activo'
  | 'pasivo';

export interface BalanceLine {
  key: string;
  label: string;
  section: BalanceLineSection;
  amount: number;
  source: string;
}

export interface BalanceSheet {
  basis: 'contable' | 'aproximado';
  provider: string | null;
  asOf: string;
  currency: string;
  totalAssets: number;
  currentAssets: number | null;
  totalLiabilities: number;
  currentLiabilities: number | null;
  equity: number;
  lines: BalanceLine[];
  /** Lo que el balance no incluye (aproximado) o lo que avisa el programa. */
  missing: string[];
  notes: string[];
  /** Cuándo se leyó del programa (contable). */
  fetchedAt?: string | null;
}

export interface ApproxBalanceInput {
  asOf: string;
  currency: string;
  cash: { total: number; accounts: number; oldestDays: number | null } | null;
  receivables: { total: number; count: number } | null;
  inventory: { value: number; products: number } | null;
  payables: { total: number; count: number } | null;
}

export const APPROX_MISSING = [
  'Activos fijos (maquinaria, vehículos, equipos, inmuebles) y su depreciación.',
  'Préstamos y obligaciones financieras (sólo entran si están en el libro como facturas por pagar).',
  'Impuestos por pagar (IVA, retenciones, renta) que todavía no han salido del banco.',
  'Nómina, cesantías y prestaciones por pagar.',
  'Anticipos recibidos y entregados, inversiones y otras cuentas por cobrar o por pagar.',
];

export function approximateBalance(input: ApproxBalanceInput): BalanceSheet {
  const lines: BalanceLine[] = [];
  const missing: string[] = [];
  const notes: string[] = [];
  if (input.cash) {
    lines.push({
      key: 'caja',
      label: 'Caja y bancos',
      section: 'activo_corriente',
      amount: round2(input.cash.total),
      source: `Último saldo conocido de ${input.cash.accounts === 1 ? 'la cuenta' : `las ${input.cash.accounts} cuentas`} de caja y bancos del libro de plata.`,
    });
    if (input.cash.oldestDays !== null && input.cash.oldestDays > 7)
      notes.push(
        `Hay un saldo de banco de hace ${input.cash.oldestDays} días: actualízalo en Finanzas para que el balance quede al día.`,
      );
  } else missing.push('Caja y bancos: no hay cuentas con saldo en el libro de plata.');
  if (input.receivables)
    lines.push({
      key: 'cartera',
      label: 'Cartera (cuentas por cobrar)',
      section: 'activo_corriente',
      amount: round2(input.receivables.total),
      source: `Saldo pendiente de ${input.receivables.count} ${input.receivables.count === 1 ? 'factura' : 'facturas'} de venta por cobrar en el libro.`,
    });
  else missing.push('Cartera: no se pudo leer lo que está por cobrar.');
  if (input.inventory && input.inventory.products > 0)
    lines.push({
      key: 'inventario',
      label: 'Inventario',
      section: 'activo_corriente',
      amount: round2(input.inventory.value),
      source: `Existencias × costo promedio de ${input.inventory.products} ${input.inventory.products === 1 ? 'producto' : 'productos'} en Inventario.`,
    });
  else missing.push('Inventario: no hay productos con existencias y costo en Inventario.');
  if (input.payables)
    lines.push({
      key: 'proveedores',
      label: 'Cuentas por pagar (proveedores)',
      section: 'pasivo_corriente',
      amount: round2(input.payables.total),
      source: `Saldo pendiente de ${input.payables.count} ${input.payables.count === 1 ? 'factura' : 'facturas'} por pagar en el libro (las ya pagadas o rechazadas en Por pagar no cuentan).`,
    });
  else missing.push('Cuentas por pagar: no se pudo leer lo que está por pagar.');

  const sum = (s: BalanceLineSection) =>
    round2(lines.filter((l) => l.section === s).reduce((a, l) => a + l.amount, 0));
  const assets = sum('activo_corriente');
  const liabilities = sum('pasivo_corriente');
  const equity = round2(assets - liabilities);
  lines.push({
    key: 'patrimonio',
    label: 'Patrimonio aproximado (diferencia)',
    section: 'patrimonio',
    amount: equity,
    source: 'Activos que Cortex conoce − pasivos que Cortex conoce. No es el patrimonio contable.',
  });
  return {
    basis: 'aproximado',
    provider: null,
    asOf: input.asOf,
    currency: input.currency,
    totalAssets: assets,
    currentAssets: assets,
    totalLiabilities: liabilities,
    currentLiabilities: liabilities,
    equity,
    lines,
    missing: [...missing, ...APPROX_MISSING],
    notes,
  };
}

const SECTION_FROM_PROVIDER: Record<string, BalanceLineSection> = {
  activo_corriente: 'activo_corriente',
  activo_no_corriente: 'activo_no_corriente',
  activo: 'activo',
  pasivo_corriente: 'pasivo_corriente',
  pasivo_no_corriente: 'pasivo_no_corriente',
  pasivo: 'pasivo',
  patrimonio: 'patrimonio',
};

const PROVIDER_NAME: Record<string, string> = {
  siigo: 'Siigo',
  alegra: 'Alegra',
  quickbooks: 'QuickBooks',
};

export function providerName(id: string | null | undefined): string {
  return (id && PROVIDER_NAME[id]) || 'el programa contable';
}

/** El balance del programa contable, en la forma de la pantalla. */
export function balanceFromProvider(b: ProviderBalance, fetchedAt: string | null): BalanceSheet {
  const name = providerName(b.provider);
  return {
    basis: 'contable',
    provider: b.provider,
    asOf: b.asOf,
    currency: b.currency,
    totalAssets: b.totalAssets,
    currentAssets: b.currentAssets,
    totalLiabilities: b.totalLiabilities,
    currentLiabilities: b.currentLiabilities,
    equity: b.equity,
    lines: b.lines.map((l, i) => ({
      key: `${l.section}:${l.code ?? i}`,
      label: l.code ? `${l.code} · ${l.name}` : l.name,
      section: SECTION_FROM_PROVIDER[l.section] ?? 'activo',
      amount: l.amount,
      source: `${name}, balance general al ${b.asOf}.`,
    })),
    missing: [],
    notes: b.notes,
    fetchedAt,
  };
}
