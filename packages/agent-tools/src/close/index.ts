/**
 * Cierre contable (migración 0192): registrar en el programa contable (causar
 * compras, recibos de caja, pagos a proveedores — siempre con vista previa y
 * aprobación de una persona) y cerrar el mes con una lista guiada que se
 * revisa sola contra los datos. Módulo `accounting_close` (0186).
 *
 * Barril estrecho: las herramientas (se registran al importarse), lo que la
 * pantalla /cierre y el piloto necesitan, y el vocabulario. Los clientes del
 * navegador sólo importan TIPOS de aquí.
 */
export {
  accountingWritePurchase,
  accountingWriteReceipt,
  accountingWriteSupplierPayment,
  closeClosePeriod,
  closeMarkTask,
  closeStatus,
} from './tools';

export {
  CLOSE_STATUSES,
  CLOSE_STATUS_LABEL,
  CLOSE_TASKS,
  CLOSE_TASK_KEYS,
  OVERRIDE_MINUTES,
  PeriodLockedError,
  TASK_STATUSES,
  TASK_STATUS_LABEL,
  closeHeadline,
  defaultClosePeriod,
  evaluateCheck as evaluateCloseCheck,
  isLocked as isClosePeriodLocked,
  isPeriod as isClosePeriod,
  periodEnd as closePeriodEnd,
  periodLabel as closePeriodLabel,
  periodOf as closePeriodOf,
  periodStart as closePeriodStart,
  progressOf as closeProgressOf,
  shiftPeriod as shiftClosePeriod,
  taskReady as closeTaskReady,
  tasksFor as closeTasksFor,
} from './shape';
export type {
  AutoCheck as CloseAutoCheck,
  AutoState as CloseAutoState,
  CloseCheckData,
  CloseStatus,
  CloseTaskDef,
  CloseTaskKey,
  TaskStatus as CloseTaskStatus,
} from './shape';

export {
  assertPeriodOpen,
  getClosePeriod,
  isDayLocked,
  openOverrideWindow,
} from './lock';
export type { ClosePeriodRow } from './lock';

export {
  assignCloseTask,
  closePeriod,
  computeClose,
  currentClosePeriod,
  ensureClosePeriod,
  listCloseEvents,
  listClosePeriods,
  loadCloseCheckData,
  markCloseTask,
  refreshClose,
  reopenPeriod,
} from './store';
export type {
  CloseEventView,
  ClosePeriodSummary,
  CloseResult,
  CloseTaskView,
  CloseView,
} from './store';

export { renderClosePdf } from './pdf';
export type { ClosePdfBrand, ClosePdfInput } from './pdf';
export { loadCloseReport } from './report';
export { closeSnapshot } from './autopilot';
export { CLOSE_REMINDER_DAYS, collectCierre } from './autopilot-collect';
export type { SnapshotClose } from './autopilot-collect';

export {
  AccountMap,
  CATEGORY_DEFAULTS as ACCOUNT_CATEGORY_DEFAULTS,
  ROLE_DEFAULTS as ACCOUNT_ROLE_DEFAULTS,
  ROLE_KEYS as ACCOUNT_ROLE_KEYS,
  ROLE_LABEL as ACCOUNT_ROLE_LABEL,
  bankRoleKey,
  validateMapRow as validateAccountMapRow,
} from './writeback/mapping';
export type {
  AccountMapRow,
  MapScope as AccountMapScope,
  ResolvedAccount,
  RoleKey as AccountRoleKey,
} from './writeback/mapping';

export {
  PROVIDER_LABEL as WRITEBACK_PROVIDER_LABEL,
  WRITEBACK_KINDS,
  WRITEBACK_KIND_LABEL,
  WRITEBACK_STATUSES,
  WRITEBACK_STATUS_LABEL,
  writebackIdempotencyKey,
} from './writeback/shape';
export type {
  EntryLine as WritebackEntryLine,
  WritebackKind,
  WritebackPreview,
  WritebackProvider,
  WritebackStatus,
} from './writeback/shape';

export {
  NO_PROGRAM_GUIDANCE as WRITEBACK_NO_PROGRAM_GUIDANCE,
  discardWriteback,
  executeWriteback,
  loadAccountMap,
  loadWritebackQueue,
  prepareWriteback,
  reconcileWritebacks,
  resetAccountMapRow,
  restoreWriteback,
  saveAccountMapRow,
  writeConnection as writebackConnection,
} from './writeback/store';
export type {
  QueueItem as WritebackQueueItem,
  WritebackOutcome,
  WritebackQueue,
} from './writeback/store';
