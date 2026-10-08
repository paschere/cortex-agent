/**
 * Tablas que se llenan solas desde una fuente conectada (migración 0161).
 */

import './tools';
import './enrich-tools';
import './lookups';

export { feedConnectGoogleSheet, trackersSyncFromSource, trackersSyncs } from './tools';
export {
  FeedCaptureError,
  captureGoogleSheetFeed,
  feedFingerprint,
  googleSpreadsheetId,
  listGoogleSheetTabs,
  parseGoogleSheetRef,
  persistFeedCapture,
  readGoogleSheetFeed,
  readGoogleSheetTab,
  registerFeedSourceCapture,
  resolveSheetTab,
  sheetSourceConfig,
} from './feed-capture';
export { trackersUpdateFromSource } from './enrich-tools';
export { applyUpdateOnly, createUpdateOnlySync, matchPart } from './enrich';
export {
  SYNC_COLUMNS,
  applyTrackerSync,
  bogotaDateTime,
  createTrackerSync,
  fieldsFromSheet,
  latestSourceSheet,
  listTrackerSyncs,
  markSyncRun,
  planSync,
} from './sync';
export type { PlannedRow, SyncOutcome, TrackerSyncRow } from './sync';
export * from './lookups';
export {
  SYNC_INSTRUCTIONS_MAX,
  SYNC_KEY_FIELDS_MAX,
  SYNC_MAX_INTERVAL,
  SYNC_MIN_INTERVAL,
  pruneSyncFields,
  readSyncSettings,
  syncPatchSchema,
  updateDriveFolderSync,
  updateTrackerSync,
} from './settings';
export type { SyncPatch, SyncSettings } from './settings';
