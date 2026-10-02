/**
 * El libro de plata (migración 0172): un solo libro de movimientos para toda la
 * plata de la empresa, se llene desde donde se llene. El contrato con la
 * proyección de caja está en `types.ts`.
 *
 * Barril estrecho: los tools (que se registran al importarse), lo que los
 * trabajos de fondo y la proyección necesitan, y el vocabulario. Los clientes
 * del navegador sólo importan TIPOS de aquí.
 */

export {
  ledgerPreviewBatch,
  ledgerQuery,
  ledgerRecategorize,
  ledgerRecord,
  ledgerRecordBatch,
  ledgerSetBalance,
} from './tools';

export * from './types';
export {
  ledgerDecideRecurring,
  ledgerSetMinimumCash,
  ledgerDeclareRecurring,
  ledgerExplainWeek,
  ledgerForecast,
  ledgerSaveScenario,
} from './forecast-tools';

// La proyección de caja a 13 semanas: motor puro (sin base ni reloj).
export * from './behavior';
export * from './recurring';
export * from './scenario';
export * from './forecast';
export * from './forecast-explain';
export * from './forecast-shared';

// Los planes sobre la caja (0173): escenarios guardados, recurrentes
// declarados o decididos, la proyección lista para usar y el PyG por mes.
export * from './plans';
export * from './privacy';
export { matchPayables, settlePayablesFromBank } from './payables';
export type { PayableMatch, SettlePayablesResult } from './payables';

export {
  CATEGORY_LABEL as LEDGER_CATEGORY_LABEL,
  KIND_LABEL as LEDGER_KIND_LABEL,
  SOURCE_KIND_LABEL as LEDGER_SOURCE_KIND_LABEL,
  STATUS_LABEL as LEDGER_STATUS_LABEL,
  categoryLabel as ledgerCategoryLabel,
} from './shape';
export type { MovementDraft as LedgerMovementDraft } from './shape';

export { ingestBankStatement } from './bank';
export type { BankStatementLedgerInput, BankStatementLedgerResult } from './bank';
export { syncLedger } from './sync';
export type { SyncLedgerOptions, SyncLedgerResult } from './sync';
export {
  ensureAccount as ensureLedgerAccount,
  listAccounts as listLedgerAccounts,
  listMovements as listLedgerMovements,
  loadLedger,
  upsertMovements as upsertLedgerMovements,
} from './store';
export type { LedgerClassifier } from './categorize';
