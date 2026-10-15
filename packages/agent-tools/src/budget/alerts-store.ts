import { ForbiddenError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isCompanyManager } from '../directory/store';
import { canSeePayrollDetail, isPayrollCategory } from '../ledger/privacy';
import { listMovements } from '../ledger/store';
import {
  type AlertThresholds,
  type BudgetAlert,
  DEFAULT_THRESHOLDS,
  parseThresholds,
} from './alerts';
import { periodEndOf } from './drill-shape';
import type { BudgetDrill, DrillRow } from './drill-shape';

/**
 * LAS ALERTAS DE PRESUPUESTO EN LA BASE (0228): el umbral de cada empresa, el
 * registro de qué aviso ya se mandó (uno por categoría, mes y nivel) y el
 * detalle de movimientos de una categoría en un mes.
 */

export async function loadAlertSettings(db: SupabaseClient): Promise<AlertThresholds> {
  const { data, error } = await db
    .from('budget_alert_settings')
    .select('enabled, warn_pct, over_pct')
    .maybeSingle();
  if (error) throw error;
  if (!data) return DEFAULT_THRESHOLDS;
  const r = data as { enabled: boolean; warn_pct: number; over_pct: number };
  return { enabled: r.enabled, warnPct: Number(r.warn_pct), overPct: Number(r.over_pct) };
}

export async function saveAlertSettings(
  db: SupabaseClient,
  input: { enabled: boolean; warnPct: number; overPct: number; userId: string },
): Promise<AlertThresholds> {
  if (!(await isCompanyManager(db, input.userId)))
    throw new ForbiddenError('Sólo quien administra la empresa cambia los umbrales de alerta.');
  let t: AlertThresholds;
  try {
    t = parseThresholds(input);
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : 'Umbrales inválidos.');
  }
  const { error } = await db.from('budget_alert_settings').upsert(
    {
      enabled: t.enabled,
      warn_pct: t.warnPct,
      over_pct: t.overPct,
      updated_by: input.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id' },
  );
  if (error) throw error;
  return t;
}

/**
 * Reclama el aviso de (presupuesto, categoría, mes, nivel). `true` = es la
 * primera vez y hay que avisar; `false` = ya se avisó. El índice único decide.
 */
export async function claimBudgetAlert(
  db: SupabaseClient,
  budgetId: string,
  alert: BudgetAlert,
): Promise<boolean> {
  const { error } = await db.from('budget_alert_events').insert({
    budget_id: budgetId,
    category: alert.category,
    month: alert.month,
    level: alert.level,
    ratio: Math.round(alert.ratio * 10000) / 10000,
    actual: alert.actual,
    budgeted: alert.budget,
  });
  if (!error) return true;
  if ((error as { code?: string }).code === '23505') return false;
  throw error;
}

/** Suelta el reclamo (si el aviso no salió, mañana se vuelve a intentar). */
export async function releaseBudgetAlert(
  db: SupabaseClient,
  budgetId: string,
  alert: BudgetAlert,
): Promise<void> {
  await db
    .from('budget_alert_events')
    .delete()
    .eq('budget_id', budgetId)
    .eq('category', alert.category)
    .eq('month', alert.month)
    .eq('level', alert.level);
}

/** Los movimientos que suman el real de una categoría en un mes (hasta 200, los mayores primero). */
export async function loadBudgetDrill(
  db: SupabaseClient,
  opts: { category: string; label: string; year: number; month: number; viewerId: string | null },
): Promise<BudgetDrill> {
  const month = String(opts.month).padStart(2, '0');
  const from = `${opts.year}-${month}-01`;
  const to = periodEndOf(opts.year, opts.month);
  const seesPayroll = await canSeePayrollDetail(db, opts.viewerId);
  const hidden = isPayrollCategory(opts.category) && !seesPayroll;
  const { rows, truncated } = await listMovements(db, {
    from,
    to,
    status: ['settled'],
    kinds: ['expense', 'income'],
    category: opts.category === 'sin_categoria' ? undefined : opts.category,
    limit: 2000,
  });
  const chosen = rows.filter((r) =>
    opts.category === 'sin_categoria' ? !r.category : r.category === opts.category,
  );
  const mapped: DrillRow[] = hidden
    ? []
    : chosen
        .map((r) => ({
          id: r.id,
          date: r.date,
          counterparty: r.counterparty_name,
          description: r.description,
          amount: (r.direction === 'out' ? 1 : -1) * (Number(r.amount) || 0),
        }))
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  return {
    category: opts.category,
    label: opts.label,
    year: opts.year,
    month: opts.month,
    total: chosen.reduce(
      (s, r) => s + (r.direction === 'out' ? 1 : -1) * (Number(r.amount) || 0),
      0,
    ),
    count: chosen.length,
    rows: mapped.slice(0, 200),
    truncated,
    confidential: hidden,
  };
}
