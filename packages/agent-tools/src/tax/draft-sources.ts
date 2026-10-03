import type { SupabaseClient } from '@supabase/supabase-js';
import { documentNumber } from '../sales/shape';
import type { SalesKind } from '../sales/shape';
import { classOf } from '../statements/classify';
import { loadStatements } from '../statements/store';
import {
  type AccountingSaleInput,
  type DraftFigures,
  type DraftPeriod,
  type DraftTarget,
  type ForeignDocInput,
  type IvaRateKey,
  type LedgerIncomeInput,
  type PurchaseDocInput,
  type SalaryWithholdingInput,
  type SaleDocInput,
  round2,
} from './draft-shape';
import {
  type RentaMonthInput,
  type RentaProviderPnl,
  buildIcaDraft,
  buildIvaDraft,
  buildRentaDraft,
  buildRetencionDraft,
  buildSimpleAnticipoDraft,
} from './drafts';
import type { ExogenaPurchase, ExogenaReceivable } from './exogena';
import { WITHHOLDING_CONCEPTS, type WithholdingConcept, uvtFor } from './rates-co';
import { ICA_CITY_LABEL, type TaxProfile } from './shape';

/**
 * DE LA BASE A LOS CONSTRUCTORES: LEER Y NORMALIZAR. (migración 0197)
 *
 * `db` es siempre el handle de la empresa. Cada lectura revisa su `error`;
 * una tabla que todavía no existe en este despliegue (la nómina de 0194, por
 * ejemplo) se trata como «no hay datos de eso» y el borrador lo dice en
 * «datos que faltan», nunca como cero silencioso.
 *
 * LA NÓMINA ES CONFIDENCIAL: de ella sólo sale el TOTAL de la retención por
 * salarios del mes y cuántas personas; ningún nombre ni valor por persona
 * llega al borrador.
 */

function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42P01' || code === 'PGRST205' || code === '42703';
}

const n = (v: number | string | null | undefined): number => {
  const x = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

// ---------------------------------------------------------------------------
// Ventas (0182)
// ---------------------------------------------------------------------------

interface SalesDocRow {
  id: string;
  kind: SalesKind;
  number: number;
  provider_number: string | null;
  status: string;
  issue_date: string;
  currency: string;
  client_name: string;
  client_tax_id: string | null;
  withholdings: { retefuente_pct?: number; reteiva_pct?: number; reteica_per_mil?: number } | null;
  total: number | string;
  emission_uncertain: boolean;
}

interface SalesLineRow {
  document_id: string;
  tax_rate: IvaRateKey;
  base: number | string;
  iva: number | string;
}

export interface SalesRead {
  sales: SaleDocInput[];
  foreign: ForeignDocInput[];
  uncertain: Array<{ id: string; label: string; date: string; amount: number }>;
  numbers: Set<string>;
}

export async function readSales(db: SupabaseClient, from: string, to: string): Promise<SalesRead> {
  const { data, error } = await db
    .from('sales_documents')
    .select(
      'id, kind, number, provider_number, status, issue_date, currency, client_name, client_tax_id, withholdings, total, emission_uncertain',
    )
    .eq('kind', 'invoice')
    .in('status', ['emitida', 'emitiendo', 'error'])
    .gte('issue_date', from)
    .lte('issue_date', to)
    .order('issue_date', { ascending: true })
    .limit(5000);
  if (error) {
    if (isMissingTable(error)) return { sales: [], foreign: [], uncertain: [], numbers: new Set() };
    throw error;
  }
  const docs = (data ?? []) as SalesDocRow[];
  const ok = docs.filter(
    (d) => d.status === 'emitida' && !d.emission_uncertain && d.currency === 'COP',
  );
  const lines = new Map<string, SalesLineRow[]>();
  for (let i = 0; i < ok.length; i += 200) {
    const ids = ok.slice(i, i + 200).map((d) => d.id);
    const { data: rows, error: lerr } = await db
      .from('sales_document_lines')
      .select('document_id, tax_rate, base, iva')
      .in('document_id', ids)
      .limit(20000);
    if (lerr) throw lerr;
    for (const r of (rows ?? []) as SalesLineRow[])
      lines.set(r.document_id, [...(lines.get(r.document_id) ?? []), r]);
  }
  const label = (d: SalesDocRow) => documentNumber(d);
  return {
    sales: ok.map((d) => ({
      id: d.id,
      number: label(d),
      date: d.issue_date,
      clientName: d.client_name,
      clientNit: d.client_tax_id,
      kind: 'invoice',
      lines: (lines.get(d.id) ?? []).map((l) => ({
        rate: l.tax_rate,
        base: n(l.base),
        iva: n(l.iva),
      })),
      withholdings: {
        retefuentePct: n(d.withholdings?.retefuente_pct) || undefined,
        reteivaPct: n(d.withholdings?.reteiva_pct) || undefined,
        reteicaPerMil: n(d.withholdings?.reteica_per_mil) || undefined,
      },
      path: `/ventas/${d.id}`,
    })),
    foreign: docs
      .filter((d) => d.status === 'emitida' && d.currency !== 'COP')
      .map((d) => ({
        id: d.id,
        label: label(d),
        date: d.issue_date,
        amount: n(d.total),
        currency: d.currency,
      })),
    uncertain: docs
      .filter((d) => d.status !== 'emitida' || d.emission_uncertain)
      .map((d) => ({
        id: d.id,
        label: `${label(d)} · ${d.client_name}`,
        date: d.issue_date,
        amount: n(d.total),
      })),
    numbers: new Set(docs.map(label)),
  };
}

// ---------------------------------------------------------------------------
// Compras: cuentas por pagar (0181)
// ---------------------------------------------------------------------------

interface PayableRow {
  id: string;
  supplier_id: string | null;
  supplier_name: string;
  supplier_nit: string | null;
  supplier_dv: string | null;
  doc_number: string;
  issue_date: string;
  currency: string;
  subtotal: number | string | null;
  iva: number | string;
  total: number | string;
  retefuente: number | string;
  reteiva: number | string;
  reteica: number | string;
  status: string;
  paid_at: string | null;
}

export interface PurchasesRead {
  purchases: ExogenaPurchase[];
  foreign: ForeignDocInput[];
}

/** El concepto de retención de cada proveedor (columna de 0197). */
async function supplierConcepts(
  db: SupabaseClient,
  ids: string[],
): Promise<Map<string, WithholdingConcept>> {
  const out = new Map<string, WithholdingConcept>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await db
      .from('suppliers')
      .select('id, withholding_concept')
      .in('id', ids.slice(i, i + 300));
    if (error) {
      if (isMissingTable(error)) return out;
      throw error;
    }
    for (const r of (data ?? []) as Array<{ id: string; withholding_concept: string | null }>)
      if (
        r.withholding_concept &&
        (WITHHOLDING_CONCEPTS as readonly string[]).includes(r.withholding_concept)
      )
        out.set(r.id, r.withholding_concept as WithholdingConcept);
  }
  return out;
}

export async function readPurchases(
  db: SupabaseClient,
  from: string,
  to: string,
): Promise<PurchasesRead> {
  const { data, error } = await db
    .from('payable_invoices')
    .select(
      'id, supplier_id, supplier_name, supplier_nit, supplier_dv, doc_number, issue_date, currency, subtotal, iva, total, retefuente, reteiva, reteica, status, paid_at',
    )
    .neq('status', 'rechazada')
    .gte('issue_date', from)
    .lte('issue_date', to)
    .order('issue_date', { ascending: true })
    .limit(10000);
  if (error) {
    if (isMissingTable(error)) return { purchases: [], foreign: [] };
    throw error;
  }
  const rows = (data ?? []) as PayableRow[];
  const concepts = await supplierConcepts(db, [
    ...new Set(rows.map((r) => r.supplier_id).filter(Boolean)),
  ] as string[]);
  const cop = rows.filter((r) => r.currency === 'COP');
  return {
    purchases: cop.map((r) => ({
      id: r.id,
      number: r.doc_number,
      date: r.issue_date,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      supplierNit: r.supplier_nit,
      supplierDv: r.supplier_dv,
      kind: 'invoice',
      subtotal: r.subtotal === null ? null : n(r.subtotal),
      iva: n(r.iva),
      total: n(r.total),
      retefuente: n(r.retefuente),
      reteiva: n(r.reteiva),
      reteica: n(r.reteica),
      concept: r.supplier_id ? (concepts.get(r.supplier_id) ?? null) : null,
      pendingApproval: r.status === 'recibida' || r.status === 'por_aprobar',
      paidAt: r.paid_at,
      path: '/pagar',
    })),
    foreign: rows
      .filter((r) => r.currency !== 'COP')
      .map((r) => ({
        id: r.id,
        label: `${r.doc_number} · ${r.supplier_name}`,
        date: r.issue_date,
        amount: n(r.total),
        currency: r.currency,
      })),
  };
}

/** Notas crédito de proveedores que llegaron por correo y se dejaron de lado. */
async function unrecordedSupplierNotes(
  db: SupabaseClient,
  from: string,
  to: string,
): Promise<number> {
  const { count, error } = await db
    .from('payable_intake_log')
    .select('id', { count: 'exact', head: true })
    .eq('outcome', 'nota')
    .gte('created_at', `${from}T00:00:00-05:00`)
    .lte('created_at', `${to}T23:59:59-05:00`);
  if (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Programa contable (0165) y libro (0172)
// ---------------------------------------------------------------------------

async function readAccountingSales(
  db: SupabaseClient,
  from: string,
  to: string,
  known: Set<string>,
): Promise<AccountingSaleInput[]> {
  const { data, error } = await db
    .from('accounting_invoices')
    .select('id, source_system, doc_number, counterparty_name, total, issued_on, currency')
    .eq('annulled', false)
    .gte('issued_on', from)
    .lte('issued_on', to)
    .limit(5000);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return (
    (data ?? []) as Array<{
      id: string;
      source_system: string;
      doc_number: string;
      counterparty_name: string | null;
      total: number | string;
      issued_on: string;
      currency: string;
    }>
  )
    .filter((r) => !known.has(r.doc_number))
    .map((r) => ({
      id: r.id,
      number: r.doc_number,
      date: r.issued_on,
      clientName: r.counterparty_name,
      total: n(r.total),
      provider: r.source_system,
    }));
}

/** Ventas que entraron al banco (o se anotaron a mano) sin número de factura. */
async function readIncomeWithoutInvoice(
  db: SupabaseClient,
  from: string,
  to: string,
): Promise<LedgerIncomeInput[]> {
  const { data, error } = await db
    .from('ledger_movements')
    .select('id, date, amount, description, counterparty_name')
    .eq('kind', 'income')
    .eq('direction', 'in')
    .eq('status', 'settled')
    .eq('category', 'ventas')
    .in('source_kind', ['bank', 'manual', 'chat', 'sheet'])
    .is('duplicate_of', null)
    .is('excluded_reason', null)
    .is('doc_number', null)
    .gte('date', from)
    .lte('date', to)
    .limit(2000);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return (
    (data ?? []) as Array<{
      id: string;
      date: string;
      amount: number | string;
      description: string;
      counterparty_name: string | null;
    }>
  ).map((r) => ({
    id: r.id,
    date: r.date,
    amount: n(r.amount),
    description: r.description,
    counterparty: r.counterparty_name,
  }));
}

/** Cuentas por cobrar del libro, para el formato 1008. */
export async function readReceivables(
  db: SupabaseClient,
  upTo: string,
): Promise<ExogenaReceivable[]> {
  const { data, error } = await db
    .from('ledger_movements')
    .select('id, date, amount, counterparty_name, counterparty_tax_id, settled_at, status')
    .eq('kind', 'receivable')
    .neq('status', 'cancelled')
    .is('duplicate_of', null)
    .lte('date', upTo)
    .gte('date', `${Number(upTo.slice(0, 4)) - 3}-01-01`)
    .limit(10000);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return (
    (data ?? []) as Array<{
      id: string;
      date: string;
      amount: number | string;
      counterparty_name: string | null;
      counterparty_tax_id: string | null;
      settled_at: string | null;
    }>
  ).map((r) => ({
    id: r.id,
    thirdNit: r.counterparty_tax_id,
    thirdName: r.counterparty_name,
    date: r.date,
    amount: n(r.amount),
    settledAt: r.settled_at,
  }));
}

// ---------------------------------------------------------------------------
// Nómina (0194): sólo el total de la retención del periodo
// ---------------------------------------------------------------------------

export async function readSalaryWithholding(
  db: SupabaseClient,
  from: string,
  to: string,
): Promise<SalaryWithholdingInput | null> {
  // La retención se practica al pagar: los periodos cuyo pago cae en el mes.
  const { data: periods, error } = await db
    .from('payroll_periods')
    .select('id, employees_count')
    .in('status', ['liquidado', 'aprobado', 'pagado'])
    .gte('pay_date', from)
    .lte('pay_date', to)
    .limit(10);
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  const ids = ((periods ?? []) as Array<{ id: string; employees_count: number }>).map((p) => p.id);
  if (!ids.length) return null;
  const { data: items, error: ierr } = await db
    .from('payroll_items')
    .select('amount, base')
    .in('period_id', ids)
    .eq('code', 'retencion_fuente')
    .limit(5000);
  if (ierr) {
    if (isMissingTable(ierr)) return null;
    throw ierr;
  }
  const rows = (items ?? []) as Array<{ amount: number | string; base: number | string | null }>;
  const employees = Math.max(
    0,
    ...((periods ?? []) as Array<{ employees_count: number }>).map((p) => p.employees_count ?? 0),
  );
  return {
    total: round2(rows.reduce((s, r) => s + Math.abs(n(r.amount)), 0)),
    base: rows.some((r) => r.base !== null)
      ? round2(rows.reduce((s, r) => s + n(r.base), 0))
      : null,
    employees: employees || null,
    source: 'Nómina de Cortex (retención estimada por el procedimiento 1; la confirma el contador)',
  };
}

// ---------------------------------------------------------------------------
// Renta: el estado de resultados (0191)
// ---------------------------------------------------------------------------

async function readRentaInputs(
  db: SupabaseClient,
  year: number,
  today: string,
  viewerId: string | null,
): Promise<{ months: RentaMonthInput[]; providerPnl: RentaProviderPnl | null }> {
  const st = await loadStatements(db, { today, viewerId, year, throughMonth: 12 });
  const months: RentaMonthInput[] = st.history
    .filter((m) => m.month.startsWith(`${year}-`))
    .map((m) => {
      let costo = 0;
      let gastos = 0;
      for (const [cat, v] of Object.entries(m.byCategory)) {
        const cls = classOf(cat, st.classes);
        if (cls === 'costo') costo += v;
        else if (cls !== 'impuestos') gastos += v;
      }
      return {
        month: m.month,
        ingresos: round2(m.sales),
        otrosIngresos: round2(m.otherIncome),
        costo: round2(costo),
        gastos: round2(gastos),
      };
    });
  const pnl = st.accounting.pnl?.report ?? null;
  const fullYear = pnl && pnl.from <= `${year}-01-01` && pnl.to >= `${year}-12-31`;
  return {
    months,
    providerPnl:
      pnl && fullYear
        ? {
            provider: pnl.provider,
            from: pnl.from,
            to: pnl.to,
            revenue: pnl.revenue,
            otherIncome: pnl.otherIncome,
            costOfSales: pnl.costOfSales,
            operatingExpenses: pnl.operatingExpenses,
            otherExpenses: pnl.otherExpenses,
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Todo junto
// ---------------------------------------------------------------------------

export interface BuildDraftOptions {
  profile: TaxProfile;
  target: DraftTarget;
  today: string;
  viewerId: string | null;
  builtAt?: string;
}

/** Lee lo que hace falta y arma el borrador del periodo. */
export async function buildDraftFromData(
  db: SupabaseClient,
  opts: BuildDraftOptions,
): Promise<DraftFigures> {
  const { profile, target, today } = opts;
  const p: DraftPeriod = target.period;
  const builtAt = opts.builtAt ?? new Date().toISOString();

  if (target.kind === 'renta') {
    const year = Number(p.from.slice(0, 4));
    const [renta, sales] = await Promise.all([
      readRentaInputs(db, year, today, opts.viewerId),
      readSales(db, p.from, p.to),
    ]);
    return buildRentaDraft({
      year,
      period: p,
      personType: profile.personType,
      months: renta.months,
      providerPnl: renta.providerPnl,
      sales: sales.sales,
      builtAt,
    });
  }

  const [sales, purchases] = await Promise.all([
    readSales(db, p.from, p.to),
    target.kind === 'iva' || target.kind === 'retencion'
      ? readPurchases(db, p.from, p.to)
      : Promise.resolve({ purchases: [], foreign: [] } as PurchasesRead),
  ]);
  const gapsFor = async () => ({
    accountingSales: await readAccountingSales(db, p.from, p.to, sales.numbers),
    ledgerIncomeWithoutInvoice: await readIncomeWithoutInvoice(db, p.from, p.to),
    foreign: [...sales.foreign, ...purchases.foreign],
    uncertainSales: sales.uncertain,
  });

  if (target.kind === 'iva') {
    const [gaps, notes] = await Promise.all([gapsFor(), unrecordedSupplierNotes(db, p.from, p.to)]);
    return buildIvaDraft({
      period: p,
      sales: sales.sales,
      purchases: purchases.purchases,
      unrecordedSupplierCreditNotes: notes,
      builtAt,
      ...gaps,
    });
  }
  if (target.kind === 'retencion') {
    const salaries = await readSalaryWithholding(db, p.from, p.to);
    return buildRetencionDraft({
      period: p,
      purchases: purchases.purchases,
      sales: sales.sales,
      salaries,
      hasEmployees: profile.pila || profile.nominaElectronica,
      autorretencionRate: profile.autorretencionRate,
      uvt: uvtFor(Number(p.from.slice(0, 4))),
      builtAt,
    });
  }
  if (target.kind === 'ica') {
    return buildIcaDraft({
      period: p,
      sales: sales.sales,
      activities: profile.icaActivities,
      cityLabel:
        profile.icaCity && profile.icaCity !== 'otra' ? ICA_CITY_LABEL[profile.icaCity] : null,
      builtAt,
      ...(await gapsFor()),
    });
  }
  return buildSimpleAnticipoDraft({
    period: p,
    sales: sales.sales,
    simpleRate: profile.simpleRate,
    builtAt,
    ...(await gapsFor()),
  });
}
