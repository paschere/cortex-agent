/**
 * Encargos: work you hand over and walk away from.
 *
 * The execution engine lives in `apps/web/lib/errands` (it needs Inngest, the
 * orchestrator and a model). What lives HERE is everything more than one
 * surface has to agree on — the vocabulary, the spend ceilings, the
 * compare-and-set writes, and the line the whole feature is sold on — plus the
 * three tools that let somebody start and steer an errand by talking.
 *
 * The split is not arbitrary: anything two callers share belongs here, because
 * a rule that lives in one caller is a rule the other one skips. That is
 * exactly what happened to the admission checks when the chat became a second
 * way in — see ./store.ts.
 */

export {
  ERRAND_TOOLS,
  ERRAND_BOUNDARY_NOTICE,
  OUTBOUND_VERBS,
  OutboundToolRefused,
  assertProposalOnly,
  errandToolAllowlist,
  isErrandTool,
  readsAsOutbound,
} from './boundary';

export {
  LEG_RESERVE_TOKENS,
  MIN_TOKEN_CEILING,
  MAX_TOKEN_CEILING,
  MAX_LEG_CEILING,
  MAX_LIVE_ERRANDS,
  MAX_MONITOR_CHECKS,
  type Spend,
  type StopReason,
  type BudgetVerdict,
  canStartLeg,
  spentFraction,
  exhaustedNote,
  ceilingsFor,
} from './budget';

export {
  type ErrandKindSpec,
  ERRAND_KIND_SPECS,
  ERRAND_KIND_LIST,
  MONITOR_CADENCES,
  DEFAULT_MONITOR_CADENCE_MINUTES,
  isMonitorCadence,
  toolsFor,
} from './kinds';

export {
  type ErrandResponse,
  type ErrandBuilder,
  type ErrandDb,
  type ClaimResult,
  type AskInput,
  type AnswerResult,
  type CloseInput,
  LEASE_MS,
  ERRAND_STALE_MS,
  claimErrand,
  releaseErrand,
  heartbeatErrand,
  askAndBlock,
  answerQuestion,
  withdrawOpenQuestions,
  openLeg,
  attachRun,
  closeLeg,
  markLegAssessed,
  closeErrand,
  parkForNextCheck,
  acceptBrief,
} from './lifecycle';

export * from './shape';

export {
  type CommissionInput,
  type CommissionOutcome,
  type CommissionRefusal,
  type OpenErrandSummary,
  type AnswerFromChat,
  commissionErrand,
  countLiveErrands,
  listErrandsForChat,
  findAnswerableQuestion,
  answerFromChat,
} from './store';

// Side-effect import: registers errands.start / errands.status / errands.answer.
export { errandsStart, errandsStatus, errandsAnswer } from './tools';
