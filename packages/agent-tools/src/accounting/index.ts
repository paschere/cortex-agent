/**
 * Programas contables conectados directo (migración 0165): Siigo hoy, Alegra y
 * QuickBooks con la misma forma. Ver docs/features/accounting-connectors.md.
 */

import './tools';

export { accountingStatus, accountingSyncNow } from './tools';
export {
  ACCOUNTING_PROVIDERS,
  getAccountingProvider,
  listAccountingProviders,
  providerName,
} from './providers';
export { SiigoClient, SiigoError, siigoPartnerId } from './providers/siigo-client';
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
export { noticeFor as accountingNoticeFor, runAccountingSync } from './sync';
export type { SyncRunOutcome as AccountingSyncOutcome } from './sync';
export { ACCOUNTING_ENTITIES, ACCOUNTING_PROVIDER_IDS } from './types';
export type {
  AccountingEntity,
  AccountingProviderId,
  CredentialField as AccountingCredentialField,
  ProviderInfo as AccountingProviderInfo,
} from './types';
