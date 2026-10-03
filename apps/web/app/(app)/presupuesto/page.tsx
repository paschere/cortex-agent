import { BudgetScreen } from '@/components/budget/BudgetScreen';
import type { BudgetScenario } from '@/components/budget/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import {
  BUDGET_LIGHT_LABEL,
  BUDGET_STATUS_LABEL,
  LEDGER_CATEGORIES,
  type ScenarioAdjustment,
  bogotaToday,
  budgetCategoryLabel,
  listBudgets,
  loadBudgetReport,
  loadForecast,
  monthlyPnl,
  toolErrorMessage,
} from '@cortex/agent-tools';
import {
  createBudgetAction,
  removeBudgetCategoryAction,
  setBudgetCellsAction,
  setBudgetStatusAction,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * PRESUPUESTO Y PRONÓSTICO (0191). Cualquiera de la empresa lo ve; crearlo y
 * editarlo lo hace quien administra (lo revisa el módulo).
 *
 * Parámetros: `?anio=2026`, `?v=<id de versión>`, `?vista=real|editar|pronostico`
 * y el escenario del pronóstico: `esc_ventas` (%), `esc_cat` + `esc_cat_pct`,
 * `esc_sin` (un cliente).
 */
export default async function BudgetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string).trim() : '');
  const today = bogotaToday();
  const thisYear = Number(today.slice(0, 4));
  const askedYear = Number(one('anio'));
  const year =
    Number.isInteger(askedYear) && askedYear >= thisYear - 1 && askedYear <= thisYear + 1
      ? askedYear
      : thisYear;
  const vista = one('vista');
  const tab = vista === 'editar' || vista === 'pronostico' ? vista : 'real';
  const numOrNull = (k: string) => {
    const v = Number(one(k).replace(',', '.').replace('+', ''));
    return one(k) && Number.isFinite(v) ? Math.min(Math.max(v, -95), 500) : null;
  };
  const scenario: BudgetScenario = {
    ventasPct: numOrNull('esc_ventas'),
    category: /^[a-z0-9_]{2,60}$/.test(one('esc_cat')) ? one('esc_cat') : null,
    categoryPct: numOrNull('esc_cat_pct'),
    withoutClient: one('esc_sin').slice(0, 120) || null,
  };
  const adjustments: ScenarioAdjustment[] = [];
  if (scenario.ventasPct !== null)
    adjustments.push({
      kind: 'scale_category',
      category: 'ventas',
      factor: 1 + scenario.ventasPct / 100,
    });
  if (scenario.category && scenario.categoryPct !== null)
    adjustments.push({
      kind: 'scale_category',
      category: scenario.category,
      factor: 1 + scenario.categoryPct / 100,
    });
  if (scenario.withoutClient)
    adjustments.push({ kind: 'drop_counterparty', counterpartyName: scenario.withoutClient });

  const [budgets, report, forecast, lastYear] = await Promise.all([
    listBudgets(db, { year }),
    loadBudgetReport(db, { year, today, viewerId: user.id, budgetId: one('v') || null }),
    loadForecast(db, { today, viewerId: user.id, adjustments })
      .then((f) => ({ f, error: null as string | null }))
      .catch((err) => ({ f: null, error: toolErrorMessage(err) })),
    monthlyPnl(db, {
      months: Math.max(thisYear * 12 + Number(today.slice(5, 7)) - ((year - 1) * 12 + 1) + 1, 1),
      today,
      includePayroll: false,
    })
      .then((months) =>
        months.some(
          (m) => m.month.startsWith(`${year - 1}-`) && (m.sales !== 0 || m.expenses !== 0),
        ),
      )
      .catch(() => false),
  ]);
  const known = new Set<string>([...LEDGER_CATEGORIES, ...report.cells.map((c) => c.category)]);
  const href = (path: string) => workspaceHref(user.organization.id, path);
  return (
    <BudgetScreen
      year={year}
      today={today}
      tab={tab}
      budgets={budgets}
      report={report}
      forecast={forecast.f}
      forecastError={forecast.error}
      categories={[...known].map((key) => ({ key, label: budgetCategoryLabel(key) }))}
      lightLabels={{ ...BUDGET_LIGHT_LABEL }}
      statusLabels={{ ...BUDGET_STATUS_LABEL }}
      scenario={scenario}
      hasLastYear={lastYear}
      links={{
        self: href('/presupuesto'),
        statements: href('/estados'),
        board: href('/informe-socios'),
        finance: href('/finance'),
      }}
      actions={{
        create: createBudgetAction,
        setCells: setBudgetCellsAction,
        removeCategory: removeBudgetCategoryAction,
        setStatus: setBudgetStatusAction,
      }}
    />
  );
}
