/**
 * Pagos: lo que de verdad entró, dicho por varias fuentes que no siempre están
 * de acuerdo (migración 0098).
 *
 * Barril deliberadamente estrecho, como el de `documents/`. Todo lo que hay
 * aquí es o un tool —que se registra por el mero hecho de importarse— o algo
 * que `apps/web` necesita de verdad. Los internos (el emparejador, las filas)
 * se importan de su propio archivo desde los tests que los ejercitan.
 */

// Registro de los tools por efecto de importación.
export {
  paymentsRecord,
  paymentsList,
  paymentsReceivables,
  paymentsDisputes,
  paymentsResolveDispute,
} from './tools';

// El vocabulario, para la pantalla y para cualquiera que tenga que nombrar un
// estado o poner un signo. Nadie debería tener una segunda copia de esto.
//
// Los tres mapas de etiquetas salen con prefijo a propósito: `commitments` ya
// exporta `KIND_LABEL`, `STATE_LABEL` y `STATE_TONE` por este mismo barril, y
// dos nombres iguales en `@cortex/agent-tools` son un error de compilación en
// un archivo que nadie tocó. Dentro del módulo se siguen llamando corto.
export {
  COUNTED_STATES,
  KIND_LABEL as PAYMENT_KIND_LABEL,
  PAYMENT_KINDS,
  PAYMENT_STATES,
  STATE_LABEL as PAYMENT_STATE_LABEL,
  STATE_TONE as PAYMENT_STATE_TONE,
  currencyBucket,
  describeDisagreement,
  movementsAgree,
  paymentSourceColumns,
  requireCurrency,
  signedAmount,
  sourceIdentity,
  sourceLabel,
  sourceRank,
  weightedAgeDays,
  MissingPaymentSourceError,
} from './shape';
export type {
  AgeItem,
  ClientMatchState as PaymentClientMatchState,
  Movement,
  PaymentKind,
  PaymentSourceInput,
  PaymentState,
} from './shape';

// Lecturas y escrituras, para la pantalla y sus acciones de servidor.
export {
  describeReceivables,
  getPayment,
  hydratePayments,
  listPayments,
  listWaitingReports,
  receivables,
  recordPaymentReport,
  reportsFor,
  resolvePaymentDispute,
} from './store';
export type {
  PaymentFilters,
  PaymentReportRow,
  PaymentRow,
  ReceivablesCurrency,
  ReceivablesResult,
  RecordOutcome,
  RecordPaymentReportInput,
  RecordPaymentReportResult,
  ResolveDisputeInput,
} from './store';

// El importador de sistema contable: listo, y sin ningún conector concreto
// dentro. Conectar Siigo es escribir la función que devuelve SystemPaymentRow[].
export { importSystemPayments } from './import';
export type {
  ImportSystemPaymentsInput,
  ImportSystemPaymentsResult,
  SystemPaymentRow,
} from './import';

// El puente desde un comprobante confirmado, llamado por documents/store.ts.
export { recordReceiptPayment, RECEIPT_DOC_TYPE } from './receipt';
export type { ReceiptExtraction, ReceiptField, ReceiptOutcome } from './receipt';
