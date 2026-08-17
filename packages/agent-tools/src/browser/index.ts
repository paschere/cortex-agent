/**
 * Trámites web -- doing paperwork on other people's websites.
 *
 * Taught once from a screen recording, replayed from then on with no model in
 * the loop, and repaired by one when a portal changes underneath it. The
 * reasoning for each half lives at the top of the file that owns it:
 *
 *   extract.ts    reading an errand off a recording, and what is kept from it
 *   execute.ts    the run: replay, classify, repair, and what a repair costs
 *   classify.ts   "the site changed" versus "the errand failed"
 *   redact.ts     why a credential cannot reach a log, a row or a model
 *   access.ts     who may spend a company login they cannot see
 *   store.ts      why steps and version history can only move together
 *   reasoned.ts   the expensive baseline the comparison is measured against
 *
 * Deployment and the measured comparison: docs/operations/browser.md
 */

export { canRunFlow, grantAccess, isAdmin, listGrants, revokeAccess, type Actor } from './access';
export {
  browserServiceConfigured,
  createHttpTransport,
  NOT_CONFIGURED_REASON as BROWSER_NOT_CONFIGURED_REASON,
  type BrowserTransport,
  type ReplayCall,
} from './client';
// Renamed on the way out: `Classification` is already the security layer's
// word for a different thing (security/policy.ts), and the barrel is flat.
export {
  classifyFailure,
  hasLoginSteps,
  type Classification as FailureClassification,
} from './classify';
export { addSpend, costOf, INPUT_USD_PER_MTOK, OUTPUT_USD_PER_MTOK } from './cost';
export {
  createCredential,
  deleteCredential,
  listCredentials,
  originOf,
  rotateCredential,
  type CredentialSummary,
} from './credentials';
export {
  closeCheckpoint,
  defaultAsk as defaultCheckpointAsk,
  expireStaleCheckpoints,
  getCheckpoint,
  isLive as isCheckpointLive,
  linkQuestion as linkCheckpointQuestion,
  listOpenCheckpoints,
  openCheckpoint,
  openCheckpointForErrand,
  secondsLeft as checkpointSecondsLeft,
  type Checkpoint,
} from './checkpoint';
export {
  resumeFlow,
  runFlow,
  type ResumeOptions as BrowserResumeOptions,
  type RunOptions as BrowserRunOptions,
  type RunOutcome as BrowserRunOutcome,
} from './execute';
export {
  auditSlots,
  callerSlots,
  fillSlots,
  holesIn,
  normaliseSlot,
  runnableSlots,
  slotComplaint,
  type SlotFill,
} from './slots';
export {
  ALLOWED_UPLOAD_EXTENSIONS,
  consumesDocument,
  extensionOf,
  MAX_UPLOAD_BYTES,
  parseFileRef,
  planUploads,
  renderRef,
  resolveUpload,
  resolveUploads,
  type FileRef,
  type UploadPayload,
} from './uploads';
export {
  alignFirstGoto,
  extractFlowFromRecording,
  MAX_FRAMES,
  proposalSchema,
  type Frame,
  type Proposal,
} from './extract';
export { mergeTargets, refineFromDom, refinementNote, type Refinement } from './refine';
export {
  currentDocumentSink,
  producesDocument,
  separateDownload,
  setDocumentSink,
  type DocumentSink,
  type DownloadedFile,
  type DownloadSummary,
} from './download';
export { runReasoned, type ReasonedResult } from './reasoned';
export {
  enforceSecrets,
  looksLikeCredentialField,
  looksLikeOneTimeCode,
  pauseForOneTimeCodes,
  redactValue,
  REDACTED as BROWSER_REDACTED,
  safeInputs,
} from './redact';
export { modelRepairer, type Repairer, type RepairRequest } from './repair';
export {
  createFlow,
  getFlow,
  getFlowBySlug,
  latestRunPerFlow,
  listErrandFlows,
  listFlows,
  listRuns,
  listRunSteps,
  markBroken,
  markVerified,
  MAX_REPAIRS_PER_WINDOW,
  repairsExhausted,
  setErrandAllowed,
  writeVersion,
  type NewFlow,
  type RunRow,
} from './store';
export {
  HANDOFF_REASONS,
  SLOT_TYPES,
  STEP_ACTIONS,
  stepSchema,
  TARGET_KINDS,
  variableSchema,
  type BrowserHandoff,
  type Flow,
  type FlowEffect,
  type FlowStatus,
  type HandoffReason,
  type PageSnapshot,
  type PauseRequest,
  type SlotType,
  type Step,
  type StepOutcome,
  type StepValue,
  type Target,
  type Variable,
} from './types';

// Registers browser.list_flows, browser.run_flow, browser.submit_flow and
// browser.resume_flow as a side effect of being imported. Last, so everything
// above is initialised first.
export {
  browserListFlows,
  browserResumeFlow,
  browserRunFlow,
  browserSubmitFlow,
} from './tools';
