/**
 * Presupuesto (migración 0191): el presupuesto anual por versión, sus celdas,
 * presupuesto contra lo real con semáforo, lo que se salió (piloto) y
 * `budget.get` / `budget.set_line`. Los clientes del navegador sólo importan
 * TIPOS de aquí.
 */
export { budgetGet, budgetMarkdown, budgetSetLine } from './tools';
export {
  BUDGET_STATUSES,
  BUDGET_STATUS_LABEL,
  INCOME_CATEGORIES as BUDGET_INCOME_CATEGORIES,
  LIGHT_LABEL as BUDGET_LIGHT_LABEL,
  actualByCategory,
  budgetCategoryLabel,
  budgetFromActuals,
  budgetKindOf,
  budgetOverruns,
  budgetVsActual,
  lightFor as budgetLightFor,
  missingExpensesNote as budgetMissingExpensesNote,
  roundBudget,
} from './shape';
export type {
  Budget,
  BudgetCell,
  BudgetKind,
  BudgetStatus,
  BudgetVsActual,
  Light as BudgetLight,
  Overrun as BudgetOverrun,
  VsCell as BudgetVsCell,
  VsRow as BudgetVsRow,
} from './shape';
export {
  activeBudget,
  budgetCells,
  canEditBudget,
  createBudget,
  getBudget,
  listBudgets,
  loadBudgetReport,
  removeBudgetCategory,
  setBudgetLines,
  setBudgetStatus,
  toBudgetCategory,
} from './store';
export type { BudgetReport, CreateBudgetInput, LineInput as BudgetLineInput } from './store';
export { collectPresupuesto } from './autopilot-collect';
export type { SnapshotBudget } from './autopilot-collect';
export { budgetSnapshot } from './autopilot';

export {
  ALERT_LEVEL_LABEL as BUDGET_ALERT_LEVEL_LABEL,
  DEFAULT_OVER_PCT as BUDGET_DEFAULT_OVER_PCT,
  DEFAULT_THRESHOLDS as BUDGET_DEFAULT_THRESHOLDS,
  DEFAULT_WARN_PCT as BUDGET_DEFAULT_WARN_PCT,
  alertHref as budgetAlertHref,
  alertPct as budgetAlertPct,
  alertTitle as budgetAlertTitle,
  budgetAlerts,
  levelFor as budgetAlertLevelFor,
  parseThresholds as parseBudgetThresholds,
} from './alerts';
export type {
  AlertLevel as BudgetAlertLevel,
  AlertThresholds as BudgetAlertThresholds,
  BudgetAlert,
} from './alerts';
export {
  claimBudgetAlert,
  loadAlertSettings as loadBudgetAlertSettings,
  loadBudgetDrill,
  releaseBudgetAlert,
  saveAlertSettings as saveBudgetAlertSettings,
} from './alerts-store';
export type { BudgetDrill, DrillRow as BudgetDrillRow } from './drill-shape';
