/**
 * Extractos bancarios: leerlos, importarlos como reportes de pago y conciliar
 * cada abono con la factura que paga. Ver docs/features/bank-statements.md.
 *
 * Barril estrecho, como el de `payments/`: los tools (que se registran al
 * importarse), lo que la pantalla de Pagos necesita, y las funciones puras que
 * conviene poder probar desde fuera. Los clientes del navegador sólo importan
 * TIPOS de aquí.
 */
export {
  paymentsApplyToInvoice,
  paymentsBankUnmatched,
  paymentsImportBankStatement,
  paymentsPreviewBankStatement,
} from './tools';
export {
  BANK_SYSTEM_PREFIX,
  accountLabelOf,
  bankAccounts,
  bankReconciliation,
  bankSystemName,
  importBankStatement,
  loadMatchPool,
  normalizeAccountLabel,
  previewBankStatement,
} from './store';
export type {
  BankImportResult,
  BankPreviewResult,
  BankReconciliation,
  BankStatementInput,
  BankStatementPreview,
  PreviewLine,
  ReconItem,
  SuggestionView,
} from './store';
export { BANK_PROFILES, COLUMN_ROLES, ROLE_LABEL } from './profiles';
export type { BankId, ColumnMap, ColumnRole } from './profiles';
export type { ManualMapping, NeedsMapping } from './parse';
export { STATEMENT_MAX_BYTES } from './read';
