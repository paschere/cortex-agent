/**
 * Embudo comercial (migración 0193): oportunidades por etapa, actividades,
 * pronóstico ponderado, reglas que siguen a Ventas, riesgo de perder clientes,
 * análisis comercial y encuestas de satisfacción. Registra seis herramientas
 * `crm.*` al importarse (./tools). Los nombres que salen a la raíz del paquete
 * llevan «Crm» o «Nps» para no chocar con los de HubSpot, Ventas o Clientes.
 * Los componentes del navegador importan el vocabulario por ruta profunda
 * (`@cortex/agent-tools/src/crm/shape`), nunca de aquí.
 */

import './tools';

export {
  crmAtRisk,
  crmCreateOpportunity,
  crmLogActivity,
  crmPipeline,
  crmSendNps,
  crmUpdateOpportunity,
  surveyEmail as npsSurveyEmail,
  surveyPublicUrl as npsSurveyPublicUrl,
} from './tools';
export {
  createOpportunity as createCrmOpportunity,
  createSurvey as createNpsSurvey,
  getOpportunity as getCrmOpportunity,
  getSurvey as getNpsSurvey,
  listActivities as listCrmActivities,
  listOpportunities as listCrmOpportunities,
  listResponses as listNpsResponses,
  listStoredRisk as listCrmStoredRisk,
  listSurveys as listNpsSurveys,
  loadStages as loadCrmStages,
  logActivity as logCrmActivity,
  markSurveyOpened as markNpsSurveyOpened,
  markSurveySent as markNpsSurveySent,
  recordSurveyResponse as recordNpsResponse,
  resolveOpportunity as resolveCrmOpportunity,
  saveRisk as saveCrmRisk,
  setActivityDone as setCrmActivityDone,
  updateOpportunity as updateCrmOpportunity,
} from './store';
export type {
  OpportunityInput as CrmOpportunityInput,
  OpportunityPatch as CrmOpportunityPatch,
  RecordedResponse as NpsRecordedResponse,
  StoredRisk as CrmStoredRisk,
} from './store';
export { crmWeightedForecast, weightedForecast as crmForecastFrom } from './forecast';
export type { CrmForecast, ForecastMonth as CrmForecastMonth } from './forecast';
export { reconcileQuoteStages as reconcileCrmQuoteStages } from './sync';
export {
  assessClientRisk as assessCrmClientRisk,
  loadCrmAnalytics,
  loadCrmBoard,
  loadOpportunityTimeline as loadCrmOpportunityTimeline,
  loadPeople as loadCrmPeople,
} from './read';
export type {
  CrmAnalytics,
  CrmBoard,
  OppTimelineItem as CrmTimelineItem,
  RiskRead as CrmRiskRead,
} from './read';
export { assessChurn as assessCrmChurn, atRiskList as crmAtRiskList } from './churn';
export type { ChurnAssessment as CrmChurnAssessment, ChurnSignal as CrmChurnSignal } from './churn';
export { STALE_DAYS as CRM_STALE_DAYS, staleDeals as crmStaleDeals } from './rules';
export type { StaleDeal as CrmStaleDeal } from './rules';
export type {
  ConversionReport as CrmConversionReport,
  ConversionRow as CrmConversionRow,
  MarginReport as CrmMarginReport,
  MarginRow as CrmMarginRow,
  WinLossReport as CrmWinLossReport,
} from './analytics';
export {
  ACTIVITY_LABEL as CRM_ACTIVITY_LABEL,
  DEFAULT_STAGES as CRM_DEFAULT_STAGES,
  LOST_REASONS as CRM_LOST_REASONS,
  LOST_REASON_LABEL as CRM_LOST_REASON_LABEL,
  NPS_BUCKET_LABEL,
  RISK_LABEL as CRM_RISK_LABEL,
  SOURCES as CRM_SOURCES,
  SOURCE_LABEL as CRM_SOURCE_LABEL,
  SURVEY_TOKEN_RE as NPS_SURVEY_TOKEN_RE,
  effectiveProbability as crmEffectiveProbability,
  isClosedStage as crmIsClosedStage,
  npsBucket,
  npsScore,
  stageByRole as crmStageByRole,
  stageOf as crmStageOf,
} from './shape';
export type {
  ActivityKind as CrmActivityKind,
  ActivityRow as CrmActivityRow,
  LostReasonKind as CrmLostReasonKind,
  NpsBucket,
  OpportunityRow as CrmOpportunityRow,
  OpportunitySource as CrmOpportunitySource,
  ResponseRow as NpsResponseRow,
  RiskLevel as CrmRiskLevel,
  StageDef as CrmStageDef,
  SurveyRow as NpsSurveyRow,
} from './shape';
