import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isCompanyManager } from '../directory/store';
import { monthlyPnl } from '../ledger/plans';
import { canSeePayrollDetail } from '../ledger/privacy';
import {
  BUDGET_STATUSES,
  type Budget,
  type BudgetCell,
  type BudgetStatus,
  type BudgetVsActual,
  budgetFromActuals,
  budgetKindOf,
  budgetVsActual,
} from './shape';

/**
 * EL PRESUPUESTO EN LA BASE (0191): `budgets` y sus celdas `budget_lines`.
 *
 * Quién escribe: quien administra o es dueño (`isCompanyManager`), lo revisa
 * aquí y no la pantalla. Leer lo puede cualquiera del equipo; la nómina real
 * se compara doblada para quien no administra (ledger/privacy.ts).
 */

const BUDGET_COLUMNS =
  'id, year, version, name, status, basis, growth_pct, currency, notes, created_by, approved_at, created_at, updated_at';

interface BudgetRow {
  id: string;
  year: number;
  version: number;
  name: string;
  status: BudgetStatus;
  basis: Budget['basis'];
  growth_pct: number | string | null;
  currency: string;
  notes: string | null;
  created_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

function adapt(r: BudgetRow): Budget {
  return {
    id: r.id,
    year: r.year,
    version: r.version,
    name: r.name,
    status: r.status,
    basis: r.basis,
    growthPct: r.growth_pct === null ? null : Number(r.growth_pct),
    currency: r.currency,
    notes: r.notes,
    createdBy: r.created_by,
    approvedAt: r.approved_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function requireManager(db: SupabaseClient, userId: string) {
  if (!(await isCompanyManager(db, userId)))
    throw new ForbiddenError('Sólo quien administra la empresa crea o cambia el presupuesto.');
}

export async function canEditBudget(db: SupabaseClient, userId: string | null): Promise<boolean> {
  return isCompanyManager(db, userId);
}

export async function listBudgets(
  db: SupabaseClient,
  opts: { year?: number } = {},
): Promise<Budget[]> {
  let q = db.from('budgets').select(BUDGET_COLUMNS);
  if (opts.year) q = q.eq('year', opts.year);
  const { data, error } = await q
    .order('year', { ascending: false })
    .order('version', { ascending: false })
    .limit(50);
  if (error) throw error;
  return ((data ?? []) as BudgetRow[]).map(adapt);
}

export async function getBudget(db: SupabaseClient, id: string): Promise<Budget | null> {
  const { data, error } = await db
    .from('budgets')
    .select(BUDGET_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? adapt(data as BudgetRow) : null;
}

/** El que cuenta para un año: el aprobado; si no hay, el borrador más reciente. */
export async function activeBudget(db: SupabaseClient, year: number): Promise<Budget | null> {
  const all = (await listBudgets(db, { year })).filter((b) => b.status !== 'archivado');
  return all.find((b) => b.status === 'aprobado') ?? all[0] ?? null;
}

export async function budgetCells(db: SupabaseClient, budgetId: string): Promise<BudgetCell[]> {
  const { data, error } = await db
    .from('budget_lines')
    .select('category, kind, month, amount')
    .eq('budget_id', budgetId)
    .limit(5000);
  if (error) throw error;
  return (
    (data ?? []) as Array<{
      category: string;
      kind: 'ingreso' | 'gasto';
      month: number;
      amount: number | string;
    }>
  ).map((r) => ({ category: r.category, kind: r.kind, month: r.month, amount: Number(r.amount) }));
}

export const CATEGORY_RE = /^[a-z0-9_]{2,60}$/;

/** «Arriendo bodega» → «arriendo_bodega». */
export function toBudgetCategory(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

export interface CreateBudgetInput {
  year: number;
  name?: string | null;
  basis: 'ultimo_anio' | 'desde_cero';
  growthPct?: number | null;
  incomeGrowthPct?: number | null;
  notes?: string | null;
}

export async function createBudget(
  db: SupabaseClient,
  input: CreateBudgetInput,
  opts: { userId: string; today: string },
): Promise<{ budget: Budget; cells: number }> {
  await requireManager(db, opts.userId);
  if (input.year < 2020 || input.year > 2100)
    throw new ValidationError('Ese año no se puede presupuestar.');
  const growth = input.growthPct ?? 0;
  if (growth < -95 || growth > 500)
    throw new ValidationError('El porcentaje tiene que estar entre −95 % y 500 %.');
  const existing = await listBudgets(db, { year: input.year });
  const version = (existing[0]?.version ?? 0) + 1;
  if (version > 99)
    throw new ValidationError('Ya hay demasiadas versiones de ese año: archiva alguna.');
  let cells: BudgetCell[] = [];
  if (input.basis === 'ultimo_anio') {
    const thisYear = Number(opts.today.slice(0, 4));
    const thisMonth = Number(opts.today.slice(5, 7));
    // Desde enero del año anterior hasta hoy, para tener ese año completo.
    const months = thisYear * 12 + thisMonth - ((input.year - 1) * 12 + 1) + 1;
    if (months > 36)
      throw new ValidationError(
        'Para basarlo en lo real necesito el año anterior en el libro (máximo tres años atrás).',
      );
    const history = await monthlyPnl(db, {
      months: Math.max(months, 1),
      today: opts.today,
      includePayroll: true,
    });
    cells = budgetFromActuals(history, {
      year: input.year,
      growthPct: growth,
      incomeGrowthPct: input.incomeGrowthPct ?? null,
    });
  }
  const { data, error } = await db
    .from('budgets')
    .insert({
      year: input.year,
      version,
      name: (
        input.name?.trim() ||
        `Presupuesto ${input.year}${version > 1 ? ` (versión ${version})` : ''}`
      ).slice(0, 120),
      status: 'borrador',
      basis: input.basis,
      growth_pct: input.basis === 'ultimo_anio' ? growth : null,
      notes: input.notes?.trim() || null,
      created_by: opts.userId,
    })
    .select(BUDGET_COLUMNS)
    .single();
  if (error) throw error;
  const budget = adapt(data as BudgetRow);
  if (cells.length) {
    const rows = cells.map((c) => ({
      budget_id: budget.id,
      category: c.category,
      kind: c.kind,
      month: c.month,
      amount: c.amount,
      updated_by: opts.userId,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error: lineError } = await db.from('budget_lines').insert(rows.slice(i, i + 500));
      if (lineError) throw lineError;
    }
  }
  return { budget, cells: cells.length };
}

export interface LineInput {
  category: string;
  month: number;
  amount: number;
}

/** Escribe celdas (crea o reemplaza). Un monto en cero borra la celda. */
export async function setBudgetLines(
  db: SupabaseClient,
  budgetId: string,
  lines: LineInput[],
  opts: { userId: string },
): Promise<{ written: number; removed: number }> {
  await requireManager(db, opts.userId);
  const budget = await getBudget(db, budgetId);
  if (!budget) throw new NotFoundError('Ese presupuesto ya no existe.');
  if (budget.status === 'archivado')
    throw new ValidationError(
      'Ese presupuesto está archivado: crea una versión nueva para cambiarlo.',
    );
  const clean = lines.map((l) => {
    const category = CATEGORY_RE.test(l.category) ? l.category : toBudgetCategory(l.category);
    if (!CATEGORY_RE.test(category))
      throw new ValidationError(`«${l.category}» no sirve como categoría.`);
    if (!Number.isInteger(l.month) || l.month < 1 || l.month > 12)
      throw new ValidationError('El mes va de 1 a 12.');
    if (!Number.isFinite(l.amount) || l.amount < 0 || l.amount >= 1e15)
      throw new ValidationError('El monto tiene que ser un número positivo.');
    return { category, month: l.month, amount: Math.round(l.amount * 100) / 100 };
  });
  const upserts = clean.filter((l) => l.amount > 0);
  const removes = clean.filter((l) => l.amount === 0);
  if (upserts.length) {
    const { error } = await db.from('budget_lines').upsert(
      upserts.map((l) => ({
        budget_id: budgetId,
        category: l.category,
        kind: budgetKindOf(l.category),
        month: l.month,
        amount: l.amount,
        updated_by: opts.userId,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: 'budget_id,category,month' },
    );
    if (error) throw error;
  }
  for (const r of removes) {
    const { error } = await db
      .from('budget_lines')
      .delete()
      .eq('budget_id', budgetId)
      .eq('category', r.category)
      .eq('month', r.month);
    if (error) throw error;
  }
  await db.from('budgets').update({ updated_at: new Date().toISOString() }).eq('id', budgetId);
  return { written: upserts.length, removed: removes.length };
}

/** Quita una categoría entera del presupuesto. */
export async function removeBudgetCategory(
  db: SupabaseClient,
  budgetId: string,
  category: string,
  opts: { userId: string },
): Promise<void> {
  await requireManager(db, opts.userId);
  const { error } = await db
    .from('budget_lines')
    .delete()
    .eq('budget_id', budgetId)
    .eq('category', category);
  if (error) throw error;
}

/** Aprobar archiva el aprobado anterior del mismo año (sólo uno cuenta). */
export async function setBudgetStatus(
  db: SupabaseClient,
  budgetId: string,
  status: BudgetStatus,
  opts: { userId: string },
): Promise<Budget> {
  await requireManager(db, opts.userId);
  if (!(BUDGET_STATUSES as readonly string[]).includes(status))
    throw new ValidationError('Estado desconocido.');
  const budget = await getBudget(db, budgetId);
  if (!budget) throw new NotFoundError('Ese presupuesto ya no existe.');
  const now = new Date().toISOString();
  if (status === 'aprobado') {
    const { error } = await db
      .from('budgets')
      .update({ status: 'archivado', updated_at: now })
      .eq('year', budget.year)
      .eq('status', 'aprobado')
      .neq('id', budgetId);
    if (error) throw error;
  }
  const { data, error } = await db
    .from('budgets')
    .update({
      status,
      approved_at: status === 'aprobado' ? now : budget.approvedAt,
      approved_by: status === 'aprobado' ? opts.userId : undefined,
      updated_at: now,
    })
    .eq('id', budgetId)
    .select(BUDGET_COLUMNS)
    .single();
  if (error) throw error;
  return adapt(data as BudgetRow);
}

export interface BudgetReport {
  budget: Budget | null;
  cells: BudgetCell[];
  vs: BudgetVsActual | null;
  canEdit: boolean;
  payrollConfidential: boolean;
}

/** El presupuesto de un año (o el pedido) contra lo real. */
export async function loadBudgetReport(
  db: SupabaseClient,
  opts: { year: number; today: string; viewerId: string | null; budgetId?: string | null },
): Promise<BudgetReport> {
  const [budget, canEdit, admin] = await Promise.all([
    opts.budgetId ? getBudget(db, opts.budgetId) : activeBudget(db, opts.year),
    canEditBudget(db, opts.viewerId),
    canSeePayrollDetail(db, opts.viewerId),
  ]);
  if (!budget) return { budget: null, cells: [], vs: null, canEdit, payrollConfidential: !admin };
  const thisYear = Number(opts.today.slice(0, 4));
  const thisMonth = Number(opts.today.slice(5, 7));
  const months = thisYear * 12 + thisMonth - (budget.year * 12 + 1) + 1;
  const [cells, history] = await Promise.all([
    budgetCells(db, budget.id),
    months >= 1 && months <= 36
      ? monthlyPnl(db, { months, today: opts.today, includePayroll: admin })
      : Promise.resolve([]),
  ]);
  return {
    budget,
    cells,
    vs: budgetVsActual(cells, history, { year: budget.year, today: opts.today }),
    canEdit,
    payrollConfidential: !admin,
  };
}
