/**
 * Órdenes de servicio y proyectos (migración 0196): trabajo por cliente con
 * tareas (el registro de trabajo con `project_id`), horas, costos, hitos de
 * facturación y rentabilidad. Registra cinco herramientas al importarse
 * (./tools). Los clientes del navegador sólo importan TIPOS y constantes.
 *
 * Barril con nombres propios («project…», «PROJECT_…»): todo cae en la raíz
 * de `@cortex/agent-tools` junto a otros cuarenta módulos.
 */

export {
  projectsCreate,
  projectsInvoice,
  projectsLogTime,
  projectsProfitability,
  projectsStatus,
} from './tools';

export {
  ACTIVE_STATUSES as PROJECT_ACTIVE_STATUSES,
  COST_KINDS as PROJECT_COST_KINDS,
  COST_KIND_LABEL as PROJECT_COST_KIND_LABEL,
  FINISHED_STATUSES as PROJECT_FINISHED_STATUSES,
  MILESTONE_STATUS_LABEL as PROJECT_MILESTONE_STATUS_LABEL,
  PROJECT_KINDS,
  PROJECT_KIND_LABEL,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_TONE,
  ProjectStateError,
  canMoveProject,
  formatHours as formatProjectHours,
  formatMoney as formatProjectMoney,
  parseProjectNumber,
  projectCode,
} from './shape';
export type {
  CostKind as ProjectCostKind,
  MilestoneStatus as ProjectMilestoneStatus,
  ProjectKind,
  ProjectRow,
  ProjectStatus,
  ProjectTone,
} from './shape';

export {
  ALERT_LABEL as PROJECT_ALERT_LABEL,
  projectMetrics,
  resolveRate as resolveProjectRate,
  weekStartOf as projectWeekStartOf,
  weekTimesheet as projectWeekTimesheet,
} from './math';
export type {
  AlertKind as ProjectAlertKind,
  ProjectAlert,
  ProjectFacts,
  ProjectMetrics,
  Timesheet as ProjectTimesheet,
} from './math';

export {
  PROJECT_WORK_TYPE,
  ProjectInputError,
  addMilestone as addProjectMilestone,
  addProjectCost,
  addProjectTask,
  consumeMaterial as consumeProjectMaterial,
  createProject,
  createProjectFromOpportunity,
  createProjectFromSalesDocument,
  deleteTimeEntry as deleteProjectTimeEntry,
  findProject,
  getProjectRow,
  invoiceProject,
  linkLedgerExpense as linkProjectLedgerExpense,
  listProjects as listServiceProjects,
  listRates as listProjectRates,
  loadProjectDetail,
  loadProjectsOverview,
  logTime as logProjectTime,
  personTimesheet as projectPersonTimesheet,
  setLaborRate,
  setProjectTaskStatus,
  unassignedLedgerExpenses,
  updateProject,
  wonOpportunitiesWithoutProject,
} from './store';
export type {
  InvoiceOutcome as ProjectInvoiceOutcome,
  LaborRate,
  Milestone as ProjectMilestone,
  ProjectCost,
  ProjectDetail,
  ProjectInput,
  ProjectPatch,
  ProjectSalesDoc,
  ProjectSummary,
  ProjectTask,
  TimeEntry as ProjectTimeEntry,
  WonOpportunity,
} from './store';
export { loadProjectsSnapshot } from './autopilot';
export { collectProyectos } from './autopilot-collect';
export type { SnapshotProjects } from './autopilot-collect';
