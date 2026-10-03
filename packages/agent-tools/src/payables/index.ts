/**
 * Cuentas por pagar (migración 0181): la factura del proveedor desde que llega
 * (correo, Bandeja, programa contable, chat) hasta que el banco la paga, con
 * revisión automática, aprobación, programación contra la caja y el libro.
 *
 * Barril estrecho: las herramientas (se registran al importarse), lo que los
 * trabajos de fondo y las pantallas necesitan, y el vocabulario. Los clientes
 * del navegador sólo importan TIPOS de aquí.
 */
export {
  payablesApprove,
  payablesInbox,
  payablesPayPlan,
  payablesRecord,
  payablesReject,
  payablesSchedule,
} from './tools';

export {
  AWAITING_APPROVAL,
  CHECK_SEVERITY_LABEL,
  OPEN_STATUSES as PAYABLE_OPEN_STATUSES,
  PAYABLE_COLUMNS,
  PAYABLE_SOURCES,
  PAYABLE_SOURCE_LABEL,
  PAYABLE_STATUSES,
  PAYABLE_STATUS_LABEL,
  PAYABLE_STATUS_TONE,
  PayableTransitionError,
  adaptPayable,
  canMove as canMovePayable,
  effectiveDueDate as payableDueDate,
  payableDedupeKey,
} from './shape';
export type {
  CheckCode,
  CheckSeverity,
  PaidEvidence,
  PayableCheck,
  PayableEvidence,
  PayableInvoice,
  PayableInvoiceRow,
  PayableLine,
  PayableSource,
  PayableStatus,
  SupplierRow,
} from './shape';
export { checkPayable, checksHeadline, isBlocked as isPayableBlocked } from './checks';
export type { CheckContext, CheckInvoice, HistoryInvoice, PurchaseOrderView } from './checks';
export { businessDay, payPlanByWeek, suggestPayDates } from './schedule';
export type {
  PlanInvoice,
  PlanWeek,
  ScheduleCandidate,
  ScheduleSuggestion,
} from './schedule';
export { parseUblInvoice, looksLikeUbl, withholdingTotals, UblError } from './ubl';
export type { UblInvoice, UblLine, UblParty, UblTax, UblKind } from './ubl';
export {
  draftFromAccountingPurchase,
  draftFromExtraction,
  draftFromManual,
  draftFromUbl,
  invoicesFromAttachment,
  isInvoiceAttachmentName,
} from './intake';
export type { AccountingPurchase, ManualPayable, PayableDraft } from './intake';
export { purchaseOrderLookup, referencesOrder } from './purchase-orders';
export type { PurchaseOrderLookup } from './purchase-orders';
export { applyPayablesOverlay, loadPayablesOverlay, withPayablesOverlay } from './overlay';
export {
  PayableAccessError,
  approvePayables,
  companyNit,
  findOrCreateSupplier,
  getPayable,
  getSupplier,
  intakePayable,
  listPayables,
  listSuppliers,
  loadPayPlan,
  markPaid,
  proposeSchedule,
  recheckPayable,
  rejectPayables,
  reopenPayables,
  schedulePayables,
  syncPaidFromLedger,
  updateSupplier,
} from './store';
export type { DecisionResult, PayPlan, ScheduleProposal, SupplierPatch } from './store';
export { importAccountingPurchases, importConfirmedDocuments } from './sources';
export type { SourceImportResult } from './sources';
export {
  pollGmailSupplierInvoices,
  pollOutlookSupplierInvoices,
  pollSupplierInvoiceMail,
} from './mail';
export type { MailPollResult } from './mail';
