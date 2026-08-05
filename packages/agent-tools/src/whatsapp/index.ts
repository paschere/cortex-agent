/**
 * WhatsApp: company groups become memory, and a person can talk to Cortex by
 * direct message.
 *
 * The connection itself does NOT live here and cannot: WhatsApp has no API for
 * this, so it is a WebSocket held open by Baileys in `services/whatsapp`, which
 * runs on Railway because a serverless platform cuts a long-lived socket. This
 * package holds everything that is decidable without a socket — how messages
 * become documents, who a number belongs to, what happens to a voice note — so
 * all of it is testable without a WhatsApp account, and so the bridge stays a
 * transport rather than a second place where product decisions are made.
 *
 * Read `windows.ts` first: the grouping rule is the design.
 */

export {
  DEFAULT_IDLE_GAP_MINUTES,
  DEFAULT_MAX_WINDOW_HOURS,
  DEFAULT_TIME_ZONE,
  displayName,
  localDay,
  planWindows,
  renderMessageText,
  windowKeyOf,
} from './windows';
export type {
  ConversationWindow,
  PlanWindowsOptions,
  PlannedWindows,
  StagedMessage,
  WhatsappMessageKind,
} from './windows';

export { buildTurns, buildWindowChunks, buildWindowHeader, ingestWindow } from './ingest-window';
export type {
  IngestWindowOptions,
  WhatsappGroupRef,
  WhatsappIngestContext,
  WindowIngestOutcome,
  WindowIngestResult,
} from './ingest-window';

export {
  GROUP_CONTEXT_MESSAGES,
  GROUP_CONTEXT_MINUTES,
  GROUP_REPLY_SCOPES,
  GROUP_SCOPE_LABEL,
  GROUP_SURFACE_NOTE,
  UNKNOWN_GROUP_SENDER_REPLY,
  detectMention,
  groupToolFilter,
  isGroupReplyScope,
  renderGroupContext,
  stripMention,
} from './mentions';
export type {
  GroupContextMessage,
  GroupReplyScope,
  MentionKind,
  MentionSignals,
} from './mentions';

export { handleGroupMention, shouldStageMessage } from './group-reply';
export type {
  GroupMentionInput,
  GroupReplyDeps,
  GroupReplyOutcome,
  GroupReplyResult,
  GroupReplyRow,
  GroupTurnRequest,
  GroupTurnResult,
  ResolvedSender,
} from './group-reply';

export { flushGroup, flushWorkspace } from './flush';
export type { FlushOptions, GroupFlushResult } from './flush';

export {
  UNKNOWN_SENDER_REPLY,
  isGroupJid,
  normalizePhone,
  recordUnknownSender,
  resolveWhatsappSender,
} from './identity';
export type { WhatsappSender } from './identity';

export {
  INGESTIBLE_DOCUMENT_MIMES,
  MAX_DOCUMENT_BYTES,
  MAX_VOICE_BYTES,
  ingestGroupAttachment,
  isIngestibleDocument,
  transcribeVoiceNote,
} from './media';
export type { AttachmentIngestResult, VoiceTranscriptionResult } from './media';
