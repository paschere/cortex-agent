/**
 * Una carpeta de Google Drive que llena una tabla de la empresa (migración 0164).
 */

import './tools';

export {
  trackersDriveSyncs,
  trackersProposeFromDriveFolder,
  trackersSyncFromDriveFolder,
} from './tools';
export {
  DRIVE_SYNC_COLUMNS,
  UnreadableFileError,
  claimDriveFolderSync,
  driveFolderMeta,
  findDriveFolders,
  driveFileText,
  getDriveFolderSync,
  listDriveFolderSyncs,
  listFolderFiles,
  readDriveFile,
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
export { inventoryFolder, inventoryMarkdown, listFolderTree, classifyFile } from './inventory';
export type { FolderInventory, FolderTree } from './inventory';
export { combineFolderProposal, proposeFromDriveFolder } from './propose-folder';
export type { FolderFieldProposal, FolderProposal } from './propose-folder';
export { readSheetRows } from './sheet-read';
export { resolveFolder } from './tools';
