/**
 * Automatizaciones de las aplicaciones (migración 0210): disparadores de fila,
 * formulario, aprobación, horario y botón; condiciones como las de las vistas;
 * acciones de avisos, filas, webhook y Cortex. Ver docs/features/apps.md.
 */

export * from './spec';
export * from './match';
export * from './ask';
export * from './limits';
export * from './poll';
export * from './poll-run';
export * from './waits';
export {
  type AutomationLimits,
  DEFAULT_AUTOMATION_LIMITS,
  MAX_AUTOMATION_LIMITS,
  resolveLimits,
  APP_DAILY_ASK_CORTEX_CAP,
  APP_DAILY_EMAIL_CAP,
  APP_DAILY_RUN_CAP,
  MAX_ATTEMPTS,
  type ActionPreview,
  type ConditionResult,
  type Simulation,
  type TemplateContext,
  TransientActionError,
  backoffMs,
  evaluateConditions,
  isTransient,
  previewActions,
  renderTemplate,
  renderValues,
  scheduleDue,
  scheduleSlotStart,
  simulateRule,
  variablesIn,
} from './engine';
export {
  type AutomationOrigin,
  type EmitInput,
  currentAutomationOrigin,
  emitAutomationEvent,
  emitSyncEvents,
  forgetAutomationWatch,
  queueRuns,
  setAutomationWaker,
  setRowChangeListener,
  type RowChangeListener,
  watchesTracker,
  withAutomationOrigin,
} from './emit';
export * from './store';
export * from './run';
export * from './templates';
export { simulateAutomation } from './simulate';
export {
  describeRelatedPlan,
  describeRollupPlan,
  parentIdsToRecompute,
  planRollup,
  planUpdateRelated,
  planUpdateRows,
  rollupValue,
} from './related';
export {
  appsAutomationsCreate,
  appsAutomationsList,
  appsAutomationsPause,
  appsAutomationsTest,
  appsAutomationsUpdate,
  describeAutomation,
} from './tools';
export {
  type ReportColumn as AutomationReportColumn,
  type ReportResult as AutomationReportResult,
  type ReportTable as AutomationReportTable,
  describeReportSource,
  formatCell as formatReportCell,
  reportQueryProblems,
  runReportQuery,
} from './report';
export {
  RANGE_PRESETS,
  RANGE_PRESET_LABEL,
  type DayRange,
  type RangePreset,
  resolveRange,
} from './report-range';
export {
  REPORT_FORMATS,
  REPORT_MAX_RECIPIENTS,
  reportSourceSchema,
} from './report-spec';
export { renderReportEmail } from './report-email';
export { buildReportXlsx, renderReportPdf, reportFilename } from './report-files';
export { buildReport as buildAutomationReport, runReportAction } from './report-run';
export {
  type DraftBuild,
  type DraftLine as InvoiceDraftLine,
  type InvoiceDraftData,
  buildInvoiceDraft,
  evalAmount,
  evalArithmetic,
  invoiceDraftKey,
  parseLooseNumber,
} from './invoice-draft';
export {
  INVOICE_DRAFT_STATUS_LABEL,
  type InvoiceDraftEdit,
  type InvoiceDraftRow,
  type InvoiceDraftStatus,
  approveInvoiceDraft,
  discardInvoiceDraft,
  draftProblems,
  draftsForRow,
  getInvoiceDraft,
  invoiceDraftEditSchema,
  listInvoiceDrafts,
  updateInvoiceDraft,
} from './invoice-drafts';
export {
  accountingInvoiceDraftApprove,
  accountingInvoiceDraftDiscard,
  accountingInvoiceDraftsList,
  accountingOutboxPrepare,
} from './invoice-draft-tools';
export { approveOutboxItem, updateOutboxPayload, outboxPayloadEditSchema } from './outbox-approve';
export { outboxDraftProblems, draftKindLabel } from './invoice-drafts';
export { appsReportPreview } from './report-tools';
