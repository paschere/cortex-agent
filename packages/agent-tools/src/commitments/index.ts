// Side-effect registration of the commitments tools.
export { commitmentsDueSoon } from './due-soon';
export { commitmentsRecord } from './record';
export { commitmentsMarkMet } from './mark-met';
export {
  commitmentsPendingReview,
  commitmentsConfirmExtracted,
  commitmentsRejectExtracted,
} from './review';
export { commitmentsExtractFromDocument } from './extract-tool';

// The pure core: dates in Bogotá time, state derivation, source shaping and the
// rule about which notices are owed today. Exported because the Inngest watcher
// and the web screen both need it, and neither should reimplement it.
export {
  COMMITMENTS_TIMEZONE,
  COMMITMENT_COLUMNS,
  COMMITMENT_KINDS,
  COMMITMENT_STATES,
  DEFAULT_NOTICE_DAYS,
  KIND_LABEL,
  MissingSourceError,
  NOTICE_KINDS,
  RECURRENCES,
  RECURRENCE_LABEL,
  SOURCE_KINDS,
  STATE_LABEL,
  STATE_TONE,
  addDays,
  addMonths,
  adaptCommitment,
  bogotaToday,
  commitmentSchema,
  cop,
  daysBetween,
  daysUntilDue,
  deriveState,
  describeSource,
  isOpen,
  isoDate,
  nextDueOn,
  noticesOwed,
  plural,
  sourceColumns,
  sourceSchema,
  sourceSentence,
  whenPhrase,
} from './shape';
export type {
  Commitment,
  CommitmentKind,
  CommitmentRow,
  CommitmentSource,
  CommitmentState,
  NoticeKind,
  Recurrence,
  SourceInput,
  SourceKind,
} from './shape';

export {
  NOTICE_COLUMNS,
  acknowledgeNotices,
  claimNotice,
  confirmExtracted,
  createCommitment,
  dropCommitment,
  getCommitment,
  hydrate,
  isUniqueViolation,
  listCommitments,
  listNoticesFor,
  listSeries,
  markMet,
  refreshStates,
  rejectExtracted,
  rescheduleCommitment,
  settleNotice,
} from './store';
export type {
  CreateCommitmentInput,
  ListOptions,
  MarkMetResult,
  NoticeClaim,
  NoticeRow,
} from './store';

export { syncFleetCommitments, commitmentsForVehicle } from './fleet';
export type { FleetSyncResult } from './fleet';

export { syncCommitmentToCalendar, recordCalendarError } from './calendar';
export type { CalendarSyncResult } from './calendar';

export {
  isPlausibleDueDate,
  proposeCommitments,
  quoteSupportsDate,
  verifyCandidates,
} from './extract';
export type {
  DocumentChunk,
  ExtractionCandidate,
  RejectedCandidate,
  VerifiedCandidate,
} from './extract';
