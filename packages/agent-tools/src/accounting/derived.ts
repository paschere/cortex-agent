import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { addDays } from '../commitments/shape';
import { monthEnd } from '../statements/store';
import {
  PAYROLL_GROUP_LABEL,
  type PayrollGroup,
  classifyPayrollAccount,
} from './payroll';
import type { PartyBalanceRow } from './providers/siigo-more';
import type {
  PersonnelAccount,
  ProviderBalance,
  ProviderPnl,
  ProviderReports,
} from './providers/reports';
import type {
  AccountingEntity,
  NormalizedPayrollCost,
  NormalizedProduct,
  NormalizedRecord,
  NormalizedStatementLine,
  NormalizedStockLine,
  ProviderQuery,
} from './types';

/**
 * LO QUE SE ARMA DE OTRAS LECTURAS (0234), no de un listado propio.
 *
 *   existencias        de los productos que ya se leen (existencias por bodega);
 *   estados            estado de resultados y balance general MES A MES, un
 *                      renglón por mes × rubro, del balance de prueba;
 *   costo de nómina    el gasto de personal (5105, 5205, 7205) del mismo
 *                      estado de resultados, por mes, área y concepto.
 *
 * Cada mes leído al programa se guarda en `accounting_report_snapshots` (la
 * misma copia que usa el estado de resultados mensual del chat): un mes
 * cerrado no se vuelve a pedir; el mes en curso, cada seis horas. Una corrida
 * pide pocos meses (sólo el actual y el anterior) y la primera carga sigue de
 * un mes a otro como cualquier otra, reanudable.
 *
 * Todo lo de aquí es puro salvo `readStatementMonth` (lee y escribe la copia).
 */

/** Cuánta historia trae la primera carga de estados. */
export const STATEMENT_HISTORY_MONTHS = 24;
const OPEN_MONTH_TTL_MS = 6 * 60 * 60_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

export const DERIVED_FROM_PRODUCTS: AccountingEntity = 'stock';

/** El balance de prueba por tercero pesa mucho: un año de historia basta para cuadrar. */
export const PARTY_HISTORY_MONTHS = 12;

export function isMonthlyDerived(entity: AccountingEntity): boolean {
  return entity === 'statements' || entity === 'payroll_costs' || entity === 'party_balances';
}

/** AAAA-MM del mes de un día. */
const monthOf = (day: string) => day.slice(0, 7);

function shiftMonth(ym: string, delta: number): string {
  const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** Los meses a leer: la primera vez, dos años; después, el anterior y el actual. */
export function derivedMonthQueries(
  mode: 'initial' | 'sweep' | 'incremental',
  today: string,
  months = STATEMENT_HISTORY_MONTHS,
): ProviderQuery[] {
  const current = monthOf(today);
  if (mode === 'incremental') return [{ month: shiftMonth(current, -1) }, { month: current }];
  const out: ProviderQuery[] = [];
  for (let i = months - 1; i >= 0; i--) out.push({ month: shiftMonth(current, -i) });
  return out;
}

// ---------------------------------------------------------------------------
// Existencias por bodega, de los productos
// ---------------------------------------------------------------------------

/** Una fila por producto y bodega. Sin bodegas, una por producto con la cantidad total. */
export function stockLinesFromProduct(p: NormalizedProduct): NormalizedStockLine[] {
  if (p.kind === 'Servicio') return [];
  const base = {
    productExternalId: p.externalId,
    productName: p.name,
    productCode: p.code,
    minStock: p.minStock,
    unit: p.unit,
  };
  if (p.warehouses?.length)
    return p.warehouses.map((w) => ({
      ...base,
      externalId: `${p.externalId}:${w.externalId}`,
      warehouseExternalId: w.externalId,
      warehouseName: w.name,
      quantity: w.quantity,
    }));
  if (p.stock === undefined) return [];
  return [
    {
      ...base,
      externalId: `${p.externalId}:total`,
      warehouseExternalId: 'total',
      warehouseName: 'Todas',
      quantity: p.stock,
    },
  ];
}

// ---------------------------------------------------------------------------
// Estados financieros: de un mes a renglones
// ---------------------------------------------------------------------------

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const SECTION_LABEL: Record<string, string> = {
  ingreso: 'Ingresos',
  costo: 'Costos',
  gasto: 'Gastos operacionales',
  otro_ingreso: 'Otros ingresos',
  otro_gasto: 'Otros gastos',
  impuesto: 'Impuesto de renta',
  activo_corriente: 'Activo corriente',
  activo_no_corriente: 'Activo no corriente',
  activo: 'Activo',
  pasivo_corriente: 'Pasivo corriente',
  pasivo_no_corriente: 'Pasivo no corriente',
  pasivo: 'Pasivo',
  patrimonio: 'Patrimonio',
};
const sectionLabel = (s: string) => SECTION_LABEL[s] ?? s;

function uniqueKeys(
  rows: Array<Omit<NormalizedStatementLine, 'externalId'> & { key: string }>,
): NormalizedStatementLine[] {
  const seen = new Map<string, number>();
  return rows.map(({ key, ...rest }) => {
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return { ...rest, externalId: n === 1 ? key : `${key}#${n}` };
  });
}

/** Un estado de resultados de un mes → renglones (rubros del PUC y totales). */
export function pnlStatementLines(
  period: string,
  pnl: ProviderPnl,
  inProgress: boolean,
): NormalizedStatementLine[] {
  const rows: Array<Omit<NormalizedStatementLine, 'externalId'> & { key: string }> = [];
  const push = (section: string, name: string, amount: number, code?: string) =>
    rows.push({
      key: `pnl|${period}|${slug(section)}|${code ?? slug(name)}`,
      period,
      statement: 'Estado de resultados',
      section,
      code,
      name,
      amount: round2(amount),
      inProgress,
    });
  for (const l of pnl.lines) push(sectionLabel(l.section), l.name, l.amount, l.code ?? undefined);
  push('Resumen', 'Ventas', pnl.revenue);
  push('Resumen', 'Costo de ventas', pnl.costOfSales);
  push('Resumen', 'Utilidad bruta', pnl.revenue - pnl.costOfSales);
  push('Resumen', 'Gastos operacionales', pnl.operatingExpenses);
  push('Resumen', 'Otros ingresos', pnl.otherIncome);
  push('Resumen', 'Otros gastos', pnl.otherExpenses);
  if (pnl.incomeTax) push('Resumen', 'Impuesto de renta', pnl.incomeTax);
  push('Resumen', 'Utilidad neta', pnl.netIncome);
  return uniqueKeys(rows);
}

/** Un balance general al cierre de un mes → renglones. */
export function balanceStatementLines(
  period: string,
  balance: ProviderBalance,
  inProgress: boolean,
): NormalizedStatementLine[] {
  const rows: Array<Omit<NormalizedStatementLine, 'externalId'> & { key: string }> = [];
  const push = (section: string, name: string, amount: number, code?: string) =>
    rows.push({
      key: `bal|${period}|${slug(section)}|${code ?? slug(name)}`,
      period,
      statement: 'Balance general',
      section,
      code,
      name,
      amount: round2(amount),
      inProgress,
    });
  for (const l of balance.lines) push(sectionLabel(l.section), l.name, l.amount, l.code ?? undefined);
  push('Resumen', 'Total activo', balance.totalAssets);
  push('Resumen', 'Total pasivo', balance.totalLiabilities);
  push('Resumen', 'Patrimonio', balance.equity);
  return uniqueKeys(rows);
}

// ---------------------------------------------------------------------------
// Costo de nómina: del gasto de personal de un mes
// ---------------------------------------------------------------------------

const AREA_BY_PREFIX: Record<string, string> = {
  '5105': 'Administración',
  '5205': 'Ventas',
  '7205': 'Producción',
};

const titleCase = (s: string) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : t;
};

/**
 * El gasto de personal de un mes por área y concepto (una fila por subcuenta de
 * cada área). Sólo totales de la empresa: la cuenta es de gasto, nunca un
 * tercero. Las cuentas mayores (5105 sin subcuenta) no dicen el concepto y se
 * dejan, igual que en la lectura en vivo.
 */
export function payrollCostLines(
  period: string,
  accounts: PersonnelAccount[],
  inProgress: boolean,
): NormalizedPayrollCost[] {
  const byKey = new Map<string, NormalizedPayrollCost>();
  for (const a of accounts) {
    const code = a.code.replace(/\D/g, '');
    const area = AREA_BY_PREFIX[code.slice(0, 4)];
    if (!area || code.length <= 4) continue;
    const cls = classifyPayrollAccount(code);
    const group: PayrollGroup = cls?.group ?? 'otros_personal';
    const key = `payroll|${period}|${code}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.amount = round2(prev.amount + a.amount);
      continue;
    }
    byKey.set(key, {
      externalId: key,
      period,
      area,
      group: PAYROLL_GROUP_LABEL[group] ?? group,
      concept: titleCase(a.name) || cls?.concept || `Cuenta ${code}`,
      amount: round2(a.amount),
      inProgress,
    });
  }
  return [...byKey.values()].filter((r) => r.amount !== 0);
}

// ---------------------------------------------------------------------------
// Leer un mes (con la copia guardada)
// ---------------------------------------------------------------------------

export interface MonthReading {
  pnl: ProviderPnl | null;
  balance: ProviderBalance | null;
  /** Peticiones al programa que costó (0 si salió de la copia). */
  fetched: number;
  inProgress: boolean;
}

interface SnapshotRow {
  payload: { report?: unknown };
  fetched_at: string;
}

/** ¿Sirve la copia? Un mes cerrado, si se sacó después de cerrar; el actual, si es reciente. */
export function snapshotUsable(
  fetchedAt: string,
  closedOn: string,
  today: string,
  nowMs: number,
): boolean {
  if (closedOn < today) return fetchedAt.slice(0, 10) > closedOn;
  return nowMs - Date.parse(fetchedAt) < OPEN_MONTH_TTL_MS;
}

export async function readStatementMonth(
  db: SupabaseClient,
  input: {
    provider: string;
    reports: ProviderReports;
    month: string;
    today: string;
    userId: string | null;
    want: { pnl: boolean; balance: boolean; personnel: boolean };
    nowMs?: () => number;
  },
): Promise<MonthReading> {
  const nowMs = input.nowMs ?? Date.now;
  const year = Number(input.month.slice(0, 4));
  const m = Number(input.month.slice(5, 7));
  const end = monthEnd(year, m);
  const inProgress = end >= input.today;
  const asOf = inProgress ? input.today : end;
  const pnlKey = `${input.month}-01..${end}`;
  const out: MonthReading = { pnl: null, balance: null, fetched: 0, inProgress };

  const { data } = await db
    .from('accounting_report_snapshots')
    .select('kind, period_key, payload, fetched_at')
    .eq('provider', input.provider)
    .in('kind', ['pnl', 'balance'])
    .in('period_key', [pnlKey, asOf]);
  const saved = (data ?? []) as Array<SnapshotRow & { kind: string; period_key: string }>;
  const find = (kind: 'pnl' | 'balance', key: string) =>
    saved.find((r) => r.kind === kind && r.period_key === key && r.payload?.report);

  const save = async (kind: 'pnl' | 'balance', key: string, report: unknown) => {
    const { error } = await db.from('accounting_report_snapshots').upsert(
      {
        provider: input.provider,
        kind,
        period_key: key,
        payload: { report },
        fetched_at: new Date(nowMs()).toISOString(),
        fetched_by: input.userId,
      },
      { onConflict: 'organization_id,provider,kind,period_key' },
    );
    if (error) logger.warn({ error, kind, key }, 'derived: no pude guardar la copia del mes');
  };

  if (input.want.pnl) {
    const s = find('pnl', pnlKey);
    const ok =
      s &&
      snapshotUsable(s.fetched_at, end, input.today, nowMs()) &&
      (!input.want.personnel || (s.payload.report as ProviderPnl).personnel);
    if (ok) out.pnl = (s as SnapshotRow).payload.report as ProviderPnl;
    else {
      out.pnl = await input.reports.profitAndLoss(`${input.month}-01`, asOf);
      out.fetched += 1;
      await save('pnl', pnlKey, out.pnl);
    }
  }
  if (input.want.balance) {
    const s = find('balance', asOf);
    if (s && snapshotUsable(s.fetched_at, end, input.today, nowMs()))
      out.balance = s.payload.report as ProviderBalance;
    else {
      out.balance = await input.reports.balanceSheet(asOf);
      out.fetched += 1;
      await save('balance', asOf, out.balance);
    }
  }
  return out;
}

/** Los renglones que un mes deja para una cosa derivada. */
export function recordsForMonth(
  entity: AccountingEntity,
  month: string,
  reading: MonthReading,
): NormalizedRecord[] {
  if (entity === 'statements') {
    return [
      ...(reading.pnl ? pnlStatementLines(month, reading.pnl, reading.inProgress) : []),
      ...(reading.balance ? balanceStatementLines(month, reading.balance, reading.inProgress) : []),
    ];
  }
  if (entity === 'payroll_costs' && reading.pnl)
    return payrollCostLines(month, reading.pnl.personnel ?? [], reading.inProgress);
  return [];
}

// ---------------------------------------------------------------------------
// Balance de prueba por tercero, mes a mes (0235)
// ---------------------------------------------------------------------------

/**
 * Los saldos por tercero de un mes, de la copia guardada o del programa. Un mes
 * cerrado se pide una sola vez (después de cerrar); el mes en curso, cada seis
 * horas como mucho —y la sincronización sólo lo revisa una vez al día—.
 */
export async function readPartyBalanceMonth(
  db: SupabaseClient,
  input: {
    provider: string;
    reports: ProviderReports;
    month: string;
    today: string;
    userId: string | null;
    nowMs?: () => number;
  },
): Promise<{ rows: PartyBalanceRow[]; fetched: number; inProgress: boolean }> {
  const nowMs = input.nowMs ?? Date.now;
  if (!input.reports.trialBalanceByParty)
    throw new Error('Este programa no entrega el balance de prueba por tercero.');
  const year = Number(input.month.slice(0, 4));
  const m = Number(input.month.slice(5, 7));
  const end = monthEnd(year, m);
  const inProgress = end >= input.today;
  const { data } = await db
    .from('accounting_report_snapshots')
    .select('payload, fetched_at')
    .eq('provider', input.provider)
    .eq('kind', 'party')
    .eq('period_key', input.month)
    .maybeSingle();
  const saved = data as { payload?: { rows?: PartyBalanceRow[] }; fetched_at: string } | null;
  if (saved?.payload?.rows && snapshotUsable(saved.fetched_at, end, input.today, nowMs()))
    return { rows: saved.payload.rows, fetched: 0, inProgress };
  const rows = await input.reports.trialBalanceByParty(year, m);
  const { error } = await db.from('accounting_report_snapshots').upsert(
    {
      provider: input.provider,
      kind: 'party',
      period_key: input.month,
      payload: { rows },
      fetched_at: new Date(nowMs()).toISOString(),
      fetched_by: input.userId,
    },
    { onConflict: 'organization_id,provider,kind,period_key' },
  );
  if (error) logger.warn({ error, month: input.month }, 'derived: no pude guardar la copia por tercero');
  return { rows, fetched: 1, inProgress };
}

/** Hoy en Bogotá (para el mes en curso). */
export { addDays };
