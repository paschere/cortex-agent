/**
 * El SG-SST (migración 0194): estándares mínimos de la Resolución 0312 de 2019
 * con su calificación, plan anual, actividades con evidencia y accidentes con
 * sus plazos; tres herramientas (`sst.status`, `sst.log_activity`,
 * `sst.report_incident`) y lo que el piloto avisa.
 */
export {
  SST_CODES_7,
  SST_CODES_21,
  SST_RATING_LABEL,
  SST_STANDARDS_60,
  SST_STATUSES,
  SST_STATUS_LABEL,
  applicableStandards,
  sstCompliance,
  standardsGroup,
} from './standards';
export type { SstCompliance, SstGroupSize, SstRating, SstStandard, SstStatus } from './standards';
export {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_LABEL,
  ACTIVITY_STANDARD,
  INCIDENT_KINDS,
  INCIDENT_KIND_LABEL,
  INCIDENT_SEVERITIES,
  addBusinessDays as sstAddBusinessDays,
  incidentAlerts,
  incidentDeadlines,
} from './deadlines';
export type { ActivityKind, IncidentKind, IncidentSeverity } from './deadlines';
export {
  SST_COMMITMENT_SYSTEM,
  canManageSst,
  ensureSstPlan,
  listSstActivities,
  listSstIncidents,
  listSstPlan,
  logSstActivity,
  readSstSettings,
  reportSstIncident,
  saveSstSettings,
  sstComplianceFor,
  updateSstIncident,
  updateSstStandard,
} from './store';
export type {
  LogActivityInput,
  ReportIncidentInput,
  SstActivity,
  SstIncident,
  SstPlanItem,
  SstSettings,
} from './store';
export { collectSst, loadSstSnapshot } from './autopilot';
export type { SnapshotSst } from './autopilot';
export { sstLogActivity, sstReportIncident, sstStatus } from './tools';
