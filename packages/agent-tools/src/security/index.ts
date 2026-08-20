// Side-effect import: registers security.review_action / security.recent_events /
// security.report_refusal / security.get_action_policy / security.set_action_policy.
import './tools';

export {
  securityReviewAction,
  securityRecentEvents,
  securityReportRefusal,
  securityGetActionPolicy,
  securitySetActionPolicy,
} from './tools';

// La política CEL por tenant (portada de OpenBot): reglas deny/allow encima de
// la matriz de riesgo, con dry-run. Ver action-policy.ts.
export { evaluateActionPolicy, parseActionPolicy } from './action-policy';
export type {
  ActionPolicy,
  ActionPolicyContext,
  ActionPolicyDecision,
  ActionPolicyMode,
} from './action-policy';

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
  blockExplanation,
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

export {
  loadPolicy,
  loadActionPolicy,
  policyFromRows,
  actionPolicyFromRows,
  resetPolicyCache,
  POLICY_CACHE_TTL_MS,
} from './store';

// El mandato (migración 0099): la excepción de un cliente sobre la doctrina de
// la casa. `applyMandate` es puro y corre DESPUÉS de `decide()`; la lectura y la
// anotación de uso viven en './mandate-store' y fallan CERRADO.
export {
  applyMandate,
  explainDelegation,
  isDelegatable,
  mandateMiss,
  mandatePatternMatches,
  surfaceCovered,
  typedAmount,
  MANDATE_RISK_CEILINGS,
  NEVER_DELEGATED_FAMILIES,
  NEVER_DELEGATED_SIGNALS,
} from './mandate';
export type {
  ApplyMandateArgs,
  DeclaredAmount,
  MandateGrant,
  MandateMiss,
  MandateOutcome,
  MandateRiskCeiling,
  MandateTool,
} from './mandate';
export {
  bogotaDayStart,
  loadMandates,
  recordMandateUse,
  MANDATES_TABLE,
  MANDATE_USES_TABLE,
} from './mandate-store';
export type { MandateUse } from './mandate-store';
