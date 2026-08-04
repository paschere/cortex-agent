// Side-effect import: registers security.review_action / security.recent_events.
import './tools';

export { securityReviewAction, securityRecentEvents } from './tools';

export {
  classify,
  decide,
  explainBlock,
  explainConfirm,
  explainFlag,
  bumpLevel,
  maxLevel,
  maxSensitivity,
  familyOf,
  sensitivityOf,
  isSensitiveFamily,
  bogotaHour,
  DEFAULT_POLICY,
  internalEmailDomains,
  BULK_THRESHOLD,
  WORK_HOURS,
  SENSITIVE_FAMILIES,
} from './policy';
export type {
  Sensitivity,
  BlastRadius,
  RiskLevel,
  RiskSignal,
  Decision,
  Surface,
  Classification,
  SecurityPolicy,
  ClassifyArgs,
  ClassifyCtx,
} from './policy';

export {
  evaluate,
  riskAuditFields,
  isIncident,
  writeSecurityEvent,
} from './enforce';
export type { SecurityEvaluation, RiskAuditFields, AuditDecision } from './enforce';

export {
  checkFrequency,
  sensitiveCallCount,
  isHighFrequency,
  resetFrequencyCache,
  noteSensitiveCall,
  FREQUENCY_CACHE_TTL_MS,
} from './frequency';

export { loadPolicy, policyFromRows, resetPolicyCache, POLICY_CACHE_TTL_MS } from './store';
