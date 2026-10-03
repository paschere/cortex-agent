/**
 * Cumplimiento (migración 0195): la lista societaria y legal de la empresa
 * sacada de su perfil (asamblea, libros, matrícula, RNBD, política de datos,
 * PQRS, SAGRILAFT/PTEE, procesos judiciales), las PQRS con su plazo en días
 * hábiles y los procesos judiciales.
 *
 * Barril ESTRECHO y con nombres propios (ver contracts/index.ts).
 */

export {
  complianceCaseUpdate,
  complianceMark,
  compliancePqrsCreate,
  compliancePqrsRespond,
  complianceStatus,
} from './tools';

export {
  CASE_ROLES as LEGAL_CASE_ROLES,
  CASE_ROLE_LABEL as LEGAL_CASE_ROLE_LABEL,
  CASE_STATUSES as LEGAL_CASE_STATUSES,
  CASE_STATUS_LABEL as LEGAL_CASE_STATUS_LABEL,
  COMPANY_SIZES as COMPLIANCE_COMPANY_SIZES,
  COMPANY_SIZE_LABEL as COMPLIANCE_COMPANY_SIZE_LABEL,
  COMPLIANCE_AREAS,
  COMPLIANCE_AREA_LABEL,
  ENTITY_TYPES as COMPLIANCE_ENTITY_TYPES,
  ENTITY_TYPE_LABEL as COMPLIANCE_ENTITY_TYPE_LABEL,
  ITEM_FREQUENCY_LABEL as COMPLIANCE_FREQUENCY_LABEL,
  ITEM_STATUSES as COMPLIANCE_ITEM_STATUSES,
  ITEM_STATUS_LABEL as COMPLIANCE_ITEM_STATUS_LABEL,
  PQRS_CHANNELS,
  PQRS_CHANNEL_LABEL,
  PQRS_KINDS,
  PQRS_KIND_LABEL,
  PQRS_MATTERS,
  PQRS_MATTER_LABEL,
  PQRS_OPEN,
  PQRS_STATUSES,
  PQRS_STATUS_LABEL,
  RAMA_JUDICIAL_URL,
  SECTORS as COMPLIANCE_SECTORS,
  SECTOR_LABEL as COMPLIANCE_SECTOR_LABEL,
  SUPERVISORS as COMPLIANCE_SUPERVISORS,
  SUPERVISOR_LABEL as COMPLIANCE_SUPERVISOR_LABEL,
} from './shape';
export type {
  CaseActionRow as LegalCaseActionRow,
  CaseRow as LegalCaseRow,
  ComplianceArea,
  ComplianceProfile,
  ItemRow as ComplianceItemRow,
  ItemStatus as ComplianceItemStatus,
  PqrsChannel,
  PqrsKind,
  PqrsMatter,
  PqrsRow,
  PqrsStatus,
} from './shape';

export {
  CONFIRM_OFFICER as COMPLIANCE_CONFIRM_OFFICER,
  pteeApplicability,
  rnbdApplicability,
  sagrilaftApplicability,
} from './applicability';
export type { Applicability as ComplianceApplicability } from './applicability';

export {
  CHECKLIST_RULE_VERSION as COMPLIANCE_RULE_VERSION,
  buildChecklist as buildComplianceChecklist,
} from './catalog';

export {
  RESPONSE_TEMPLATES as PQRS_RESPONSE_TEMPLATES,
  addBusinessDays as addColombianBusinessDays,
  businessDaysLeft as colombianBusinessDaysLeft,
  deadlinePhrase as pqrsDeadlinePhrase,
  fillResponse as fillPqrsResponse,
  legalDeadline as pqrsLegalDeadline,
  maxExtensionDate as pqrsMaxExtensionDate,
} from './pqrs';
export type { ResponseTemplate as PqrsResponseTemplate } from './pqrs';

export { parseRadicado as parseJudicialRadicado, ramaJudicialPrompt } from './cases';

export {
  readComplianceProfile,
  listCaseActions as listLegalCaseActions,
  listComplianceItems,
  listLegalCases,
  listPqrs,
  getPqrs,
} from './store';

export {
  addLegalCaseAction,
  createPqrs,
  effectiveDue as pqrsEffectiveDue,
  isItemOverdue as isComplianceItemOverdue,
  loadCompliance,
  markComplianceItem,
  pqrsDeadline,
  progressByArea as complianceProgressByArea,
  respondPqrs,
  saveComplianceProfile,
  setPublicPqrsForm,
  syncChecklist as syncComplianceChecklist,
  updatePqrsState,
  upsertLegalCase,
} from './ops';
export type {
  AreaProgress as ComplianceAreaProgress,
  CaseInput as LegalCaseInput,
  PqrsInput,
  ProfileInput as ComplianceProfileInput,
} from './ops';

export {
  collectComplianceDue,
  collectPqrsDeadlines,
  loadComplianceSnapshot,
} from './autopilot';
export type { ComplianceAutopilotSnapshot } from './autopilot';
