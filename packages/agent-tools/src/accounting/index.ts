/**
 * Programas contables conectados directo (migración 0165): Siigo, Alegra y
 * QuickBooks Online con la misma forma. Ver docs/features/accounting-connectors.md.
 */

import './tools';

export { accountingPayrollSummary, accountingStatus, accountingSyncNow } from './tools';
export {
  ACCOUNTING_PROVIDERS,
  getAccountingProvider,
  listAccountingProviders,
  providerName,
} from './providers';
export { SiigoClient, SiigoError, siigoPartnerId } from './providers/siigo-client';
export { AlegraClient, AlegraError } from './providers/alegra-client';
export {
  QuickBooksClient,
  QuickBooksError,
  exchangeQuickbooksCode,
  quickbooksAppConfig,
  quickbooksAuthorizeUrl,
  quickbooksSetupMissing,
} from './providers/quickbooks-client';
export type { QuickBooksAppConfig } from './providers/quickbooks-client';
export { completeQuickbooksConnection } from './providers/quickbooks';
export {
  CONNECTION_COLUMNS as ACCOUNTING_CONNECTION_COLUMNS,
  claimAccountingConnection,
  disconnectAccounting,
  getAccountingConnection,
  getAccountingConnectionById,
  listAccountingConnections,
  markAccountingRun,
  openAccountingSession,
  requestAccountingSync,
  saveAccountingConnection,
  updateAccountingSettings,
} from './store';
export type {
  AccountingConnectionRow,
  EntityCounts as AccountingEntityCounts,
  RunCounts as AccountingRunCounts,
} from './store';
export { accountingTableSpec } from './tables';
export { nextPurchaseCursor, planPurchaseSync } from './purchase-plan';
export { planPayrollSync } from './payroll-plan';
export {
  readPayrollView,
  replacePayrollJournals,
  runPayrollSync,
} from './payroll-store';
export type { PayrollSyncResult, PayrollView } from './payroll-store';
export {
  PAYROLL_GROUP_LABEL,
  classifyPayrollAccount,
  normalizeSiigoPayrollJournal,
  summarizePayrollPeople,
  summarizePayrollPeriods,
} from './payroll';
export type { PurchaseCursor } from './purchase-plan';
export { noticeFor as accountingNoticeFor, runAccountingSync } from './sync';
export type { SyncRunOutcome as AccountingSyncOutcome } from './sync';
export { ACCOUNTING_ENTITIES, ACCOUNTING_OPTIONS, ACCOUNTING_PROVIDER_IDS } from './types';
export type {
  AccountingEntity,
  AccountingOption,
  AccountingProviderId,
  AccountingSelection,
  CredentialField as AccountingCredentialField,
  ProviderInfo as AccountingProviderInfo,
} from './types';
