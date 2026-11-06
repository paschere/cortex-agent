/**
 * Aplicaciones (migración 0208): varias pantallas con menú, roles con scope
 * de filas y miembros de Cortex asignados a cada rol. Una pantalla es una
 * vista con `app_id`; los permisos se deciden en el servidor con
 * permissions.ts (puro) y store.ts (lecturas y escrituras con rol).
 */

import './tools';
import './design';
import './brand-tool';
import './draft';
import './inspect';
import './automations/tools';
import './automations/report-tools';
import './automations/invoice-draft-tools';
import './notices/tools';
import './code/tools';
import './backups/tools';

export {
  appsAssignMembers,
  appsCreate,
  appsDelete,
  appsGeofences,
  appsGet,
  appsInviteUsers,
  appsList,
  appsPublish,
  appsUsage,
  appsRestoreVersion,
  appsVersions,
  appsUpdate,
} from './tools';
export * from './permissions';
export * from './location-shape';
export * from './geofence';
export * from './geofence-run';
export * from './location';
export * from './store';
export * from './templates';
export * from './install';
export * from './external';
export * from './automations';
export * from './notices';
export * from './kiosk';
export * from './portal';
export * from './tablero';
export * from './client-portal';
export * from './versions-shape';
export * from './versions';
export * from './versions-compare';
export { describeWouldSave, readScreenSample } from './sample-screen';
export type { SampleScreen } from './sample-screen';
export * from './inspect-shape';
export { appsInspect, inspectAppRole, loadInspectInput } from './inspect';
export type { InspectVersion, LoadedInspect } from './inspect';
export * from './usage';
export * from './app-extras';
export * from './appearance';
export * from './screen-extras';
export { appsDesign, reviewAppDraft, appDraftSchema } from './design';
export type { AppDraft, DraftReview, AutomationIdea } from './design';
export {
  appsApplyDraft,
  applyAppDraft,
  buildAppPreview,
  describePlan,
  planCreations,
  runWithRollback,
  StepFailed,
} from './draft';
export type { AppPreview, PlanStep, PreviewMeta, PreviewScreen, Undoable } from './draft';
export { sampleRows, PREVIEW_USER_ID } from './sample-data';
export type { SampleRow } from './sample-data';
export { tableDraftSchema } from './design';
export type { TableDraft } from './design';
export {
  SCREEN_PATTERNS,
  PATTERN_IDS,
  buildScreenFromPattern,
  describePatterns,
  inferFieldRoles,
} from './screen-patterns';
export type { ScreenPattern, PatternId, BuildResult, FieldRoles } from './screen-patterns';
export { reviewAppDesign, humanizeTitle } from './design-review';
export type { DesignNote, DesignReview } from './design-review';
export { appsSuggestBrand, buildBrandProposal, inferAppKind } from './brand-tool';
export type { BrandProposal } from './brand-tool';
export { accessibleVariants, paletteFromPixels, suggestFont } from './brand-palette';
export * from './code/files';
export * from './code/store';
export * from './code/build';
export * from './code/github';
export { runSdkOp, SDK_OPS, SDK_CALLS_PER_MINUTE } from './code/sdk';
export type { SdkCallContext, SdkOp, SdkRowOut, StoredUpload } from './code/sdk';
export {
  appsCodeAddScreen,
  appsCodeBuild,
  appsCodeDbMigrate,
  appsCodeDbQuery,
  appsCodePublish,
  appsCodeRead,
  appsCodeRun,
  appsCodeRuns,
  appsCodeWrite,
} from './code/tools';
export * from './backups';
export * from './code/app-db';
export * from './code/app-db-store';
export * from './code/app-db-publish';
export * from './code/functions';
export * from './code/function-store';
export {
  accessFromClaims,
  runAppFunction,
  systemAppAccess,
  testAppAccess,
} from './code/run-function';
export type { FunctionOutcome, RunFunctionOptions } from './code/run-function';
export { runFunctionAction, summarizeResult } from './code/rule-action';
