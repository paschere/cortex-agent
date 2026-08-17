// Proposed actions: an answer that ends in something ready to approve, rather
// than in a description of what could be done. Migration 0077.
//
// Side-effect registration of the two tools.
export { actionsPropose, actionsList } from './tools';

// The pure core: the vocabulary, the fingerprint, and the two checks that stand
// between an approval and an execution. Exported because the web surfaces, the
// unattended sweep and the tests all need them, and none of them should
// reimplement any of it.
export {
  ACTION_COLUMNS,
  ACTION_KINDS,
  ACTION_OUTCOMES,
  ACTION_STATES,
  ActionIntegrityError,
  FOLLOW_UP_WINDOW_MS,
  KIND_AUDIENCE,
  KIND_LABEL as ACTION_KIND_LABEL,
  ORIGIN_KINDS,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  PROPOSAL_TTL_MS,
  STATE_LABEL as ACTION_STATE_LABEL,
  actionHeadline,
  actionSchema,
  adaptAction,
  assertExecutable,
  canonicalJson,
  fingerprint,
  isApprovable,
  messagePayloadSchema,
} from './shape';
export type {
  Action,
  ActionKind,
  ActionOutcome,
  ActionRow,
  ActionState,
  MessagePayload,
  OriginKind,
} from './shape';

export { draftCollectionNotice, draftOwnerReminder, longDate, shortDate } from './draft';
export type { Draft } from './draft';

export {
  claimAction,
  editContent,
  findOpenForOrigin,
  getAction,
  hydrateOwners,
  listActions,
  listRevisions,
  markEscalated,
  peekAction,
  proposeAction,
  recordExecution,
  recordOutcome,
} from './store';
export type {
  ClaimActionInput,
  EditContentInput,
  EditOutcome,
  ListActionsOptions,
  MarkEscalatedInput,
  ProposeActionInput,
  ProposeOutcome,
  RevisionRow,
} from './store';

// Escalación por línea de mando (migración 0113): qué aprobación lleva tanto
// tiempo parada que ya hay que avisarle al jefe del dueño, y a quién. Puro, sin
// base ni reloj, porque un escalado que va a la persona equivocada no se ve roto
// en ninguna pantalla. Lee `escalationTarget` de ./directory; no lo reimplementa.
export {
  APPROVAL_ESCALATION_DEFAULT_HOURS,
  MAX_ESCALATIONS_PER_RUN,
  MAX_ESCALATION_HOURS,
  MIN_ESCALATION_HOURS,
  escalationHoursFrom,
  escalationsDue,
} from './escalation';
export type {
  ActionEscalationVia,
  EscalatableAction,
  EscalationDue,
  EscalationsDueInput,
} from './escalation';

export { addressOf, findReply, outcomeNoteForResolution, silenceIsFinal } from './follow-up';
export type { ReplyVerdict, ThreadMessage } from './follow-up';

export { REMINDER_COOLDOWN_MS, planOwnerReminders, recentlyActedOrigins } from './sweep';
export type { ReminderCandidate } from './sweep';
