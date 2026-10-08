/**
 * Estados financieros (migración 0191): estado de resultados de caja con el
 * año anterior al lado, balance general (contable o aproximado), indicadores
 * trazables y `statements.get`. Lee de ./ledger, ./accounting, ./inventory y
 * ./payables por módulo directo. Los clientes del navegador sólo importan
 * TIPOS de aquí.
 */
export { statementsGet, statementsMarkdown, monthName as statementsMonthName } from './tools';
export {
  DEFAULT_CLASSES as STATEMENT_DEFAULT_CLASSES,
  EXPENSE_CLASSES,
  EXPENSE_CLASS_LABEL,
  classOf as expenseClassOf,
  expenseCategoryLabel,
  isExpenseClass,
  mergeClasses as mergeExpenseClasses,
} from './classify';
export type { CategoryClasses, ExpenseClass } from './classify';
export {
  INCOME_LINES,
  INCOME_LINE_META,
  incomeStatement,
  incomeValues,
  expensesMissing as incomeExpensesMissing,
  pctChange as statementPctChange,
} from './income';
export type { IncomeLineKey, IncomeLineMeta, IncomeStatement, IncomeValues } from './income';
export {
  APPROX_MISSING,
  approximateBalance,
  balanceFromProvider,
  providerName as accountingProviderLabel,
} from './balance';
export type { BalanceLine, BalanceSheet } from './balance';
export { MISSING_EXPENSES_HELP, headline as statementsHeadline } from './headline';
export type { Headline as StatementsHeadline } from './headline';
export { humanReportError } from './report-errors';
export { computeIndicators, daysText, pctText, ratioText } from './indicators';
export type { Indicator, IndicatorInputs, IndicatorStatus } from './indicators';
export {
  loadStatements,
  monthEnd,
  readAccountingReports,
  readCategoryClasses,
  refreshAccountingReports,
  saveCategoryClasses,
} from './store';
export type {
  AccountingReports,
  RefreshOutcome as AccountingRefreshOutcome,
  StatementsResult,
} from './store';
export type {
  ProviderBalance as AccountingBalanceReport,
  ProviderPnl as AccountingPnlReport,
  ProviderReports as AccountingReportsReader,
} from '../accounting/providers/reports';
