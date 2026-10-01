/**
 * Una carpeta de Google Drive que llena una tabla de la empresa (migración 0162).
 */

import './tools';

export { trackersDriveSyncs, trackersSyncFromDriveFolder } from './tools';
export {
  DRIVE_SYNC_COLUMNS,
  UnreadableFileError,
  claimDriveFolderSync,
  driveFileText,
  getDriveFolderSync,
  listDriveFolderSyncs,
  listFolderFiles,
  markDriveFolderRun,
  modelExtractor,
  prepareDriveFolderRun,
  processDriveFile,
  totalsOf,
} from './engine';
export type {
  DriveAccess,
  DriveFolderSyncRow,
  DriveRowExtractor,
  FileResult,
  PreparedRun,
} from './engine';
export { DRIVE_TABLE_PRESETS, noticeFor, planFileRows } from './plan';
export type { ExtractField, FolderFile, LedgerEntry, RunTotals } from './plan';
