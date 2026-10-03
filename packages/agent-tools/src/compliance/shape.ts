/**
 * EL VOCABULARIO DE CUMPLIMIENTO (migración 0195).
 *
 * Perfil, lista de cumplimiento, PQRS y procesos judiciales: tipos, etiquetas
 * y filas. Puro.
 *
 * NADA DE ESTO ES ASESORÍA LEGAL. La lista dice qué suele aplicarle a una
 * empresa con este perfil y por qué, con su fundamento; lo que depende de un
 * umbral o de una fecha que no está verificada sale «por confirmar».
 */

export const ENTITY_TYPES = [
  'sas',
  'ltda',
  'sa',
  'comandita',
  'colectiva',
  'esal',
  'persona_natural',
  'sucursal_extranjera',
  'otra',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_TYPE_LABEL: Record<EntityType, string> = {
  sas: 'Sociedad por acciones simplificada (S.A.S.)',
  ltda: 'Sociedad limitada (Ltda.)',
  sa: 'Sociedad anónima (S.A.)',
  comandita: 'Sociedad en comandita',
  colectiva: 'Sociedad colectiva',
  esal: 'Entidad sin ánimo de lucro',
  persona_natural: 'Persona natural comerciante',
  sucursal_extranjera: 'Sucursal de sociedad extranjera',
  otra: 'Otra',
};

/** Las formas de sociedad comercial (las que tienen asamblea o junta de socios). */
export const COMMERCIAL_COMPANIES: readonly EntityType[] = [
  'sas',
  'ltda',
  'sa',
  'comandita',
  'colectiva',
];

export const COMPANY_SIZES = ['micro', 'pequena', 'mediana', 'grande'] as const;
export type CompanySize = (typeof COMPANY_SIZES)[number];
export const COMPANY_SIZE_LABEL: Record<CompanySize, string> = {
  micro: 'Micro',
  pequena: 'Pequeña',
  mediana: 'Mediana',
  grande: 'Grande',
};

export const SUPERVISORS = [
  'ninguna',
  'supersociedades',
  'superfinanciera',
  'supersalud',
  'supertransporte',
  'superservicios',
  'supersolidaria',
  'otra',
] as const;
export type Supervisor = (typeof SUPERVISORS)[number];
export const SUPERVISOR_LABEL: Record<Supervisor, string> = {
  ninguna: 'Ninguna en particular',
  supersociedades: 'Superintendencia de Sociedades',
  superfinanciera: 'Superintendencia Financiera',
  supersalud: 'Superintendencia de Salud',
  supertransporte: 'Superintendencia de Transporte',
  superservicios: 'Superintendencia de Servicios Públicos',
  supersolidaria: 'Superintendencia de la Economía Solidaria',
  otra: 'Otra',
};

export const SUPERVISION_LEVELS = ['ninguna', 'inspeccion', 'vigilancia', 'control'] as const;
export type SupervisionLevel = (typeof SUPERVISION_LEVELS)[number];

export const SECTORS = [
  'inmobiliario',
  'metales_preciosos',
  'servicios_juridicos',
  'servicios_contables',
  'construccion',
  'farmaceutico',
  'infraestructura',
  'manufactura',
  'minero_energetico',
  'tic',
  'activos_virtuales',
  'vehiculos',
  'otro',
] as const;
export type Sector = (typeof SECTORS)[number];
export const SECTOR_LABEL: Record<Sector, string> = {
  inmobiliario: 'Inmobiliario',
  metales_preciosos: 'Metales y piedras preciosas',
  servicios_juridicos: 'Servicios jurídicos',
  servicios_contables: 'Servicios contables',
  construccion: 'Construcción',
  farmaceutico: 'Farmacéutico',
  infraestructura: 'Infraestructura',
  manufactura: 'Manufactura',
  minero_energetico: 'Minero-energético',
  tic: 'Tecnologías de la información (TIC)',
  activos_virtuales: 'Activos virtuales',
  vehiculos: 'Comercio de vehículos',
  otro: 'Otro',
};

export interface ComplianceProfile {
  id: string;
  entityType: EntityType;
  size: CompanySize | null;
  revenueCop: number | null;
  assetsCop: number | null;
  figuresYear: number | null;
  internationalCop: number | null;
  stateContractsCop: number | null;
  supervisor: Supervisor;
  supervisionLevel: SupervisionLevel;
  sectors: Sector[];
  handlesPersonalData: boolean;
  consumerFacing: boolean;
  employees: number | null;
  hasBoard: boolean;
  complianceOfficer: string | null;
  ownerUserId: string | null;
  privacyPolicyUrl: string | null;
  pqrsEnabled: boolean;
  pqrsToken: string | null;
  pqrsOwnerUserId: string | null;
  pqrsDeadlines: Record<string, number>;
  updatedAt: string | null;
}

export const PROFILE_COLUMNS =
  'id, entity_type, size, revenue_cop, assets_cop, figures_year, international_cop, state_contracts_cop, supervisor, supervision_level, sectors, handles_personal_data, consumer_facing, employees, has_board, compliance_officer, owner_user_id, privacy_policy_url, pqrs_enabled, pqrs_token, pqrs_owner_user_id, pqrs_deadlines, updated_at';

export interface ProfileRow {
  id: string;
  entity_type: EntityType;
  size: CompanySize | null;
  revenue_cop: number | string | null;
  assets_cop: number | string | null;
  figures_year: number | null;
  international_cop: number | string | null;
  state_contracts_cop: number | string | null;
  supervisor: Supervisor;
  supervision_level: SupervisionLevel;
  sectors: Sector[] | null;
  handles_personal_data: boolean;
  consumer_facing: boolean;
  employees: number | null;
  has_board: boolean;
  compliance_officer: string | null;
  owner_user_id: string | null;
  privacy_policy_url: string | null;
  pqrs_enabled: boolean;
  pqrs_token: string | null;
  pqrs_owner_user_id: string | null;
  pqrs_deadlines: Record<string, number> | null;
  updated_at: string | null;
}

const n = (v: number | string | null): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v);

export function rowToProfile(r: ProfileRow): ComplianceProfile {
  return {
    id: r.id,
    entityType: r.entity_type,
    size: r.size,
    revenueCop: n(r.revenue_cop),
    assetsCop: n(r.assets_cop),
    figuresYear: r.figures_year,
    internationalCop: n(r.international_cop),
    stateContractsCop: n(r.state_contracts_cop),
    supervisor: r.supervisor,
    supervisionLevel: r.supervision_level,
    sectors: r.sectors ?? [],
    handlesPersonalData: r.handles_personal_data,
    consumerFacing: r.consumer_facing,
    employees: r.employees,
    hasBoard: r.has_board,
    complianceOfficer: r.compliance_officer,
    ownerUserId: r.owner_user_id,
    privacyPolicyUrl: r.privacy_policy_url,
    pqrsEnabled: r.pqrs_enabled,
    pqrsToken: r.pqrs_token,
    pqrsOwnerUserId: r.pqrs_owner_user_id,
    pqrsDeadlines: r.pqrs_deadlines ?? {},
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// La lista
// ---------------------------------------------------------------------------

export const COMPLIANCE_AREAS = [
  'societario',
  'datos_personales',
  'consumidor',
  'lavado_activos',
  'transparencia',
  'litigios',
  'otro',
] as const;
export type ComplianceArea = (typeof COMPLIANCE_AREAS)[number];
export const COMPLIANCE_AREA_LABEL: Record<ComplianceArea, string> = {
  societario: 'Societario',
  datos_personales: 'Datos personales (SIC)',
  consumidor: 'Consumidor y PQRS',
  lavado_activos: 'Prevención de lavado de activos',
  transparencia: 'Transparencia y ética empresarial',
  litigios: 'Procesos judiciales',
  otro: 'Otros',
};

export const ITEM_FREQUENCIES = [
  'unica',
  'anual',
  'semestral',
  'mensual',
  'continua',
  'por_evento',
] as const;
export type ItemFrequency = (typeof ITEM_FREQUENCIES)[number];
export const ITEM_FREQUENCY_LABEL: Record<ItemFrequency, string> = {
  unica: 'Una vez',
  anual: 'Cada año',
  semestral: 'Cada semestre',
  mensual: 'Cada mes',
  continua: 'Permanente',
  por_evento: 'Cuando ocurre',
};

export const ITEM_STATUSES = ['pendiente', 'en_curso', 'cumplido', 'no_aplica'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  pendiente: 'Pendiente',
  en_curso: 'En curso',
  cumplido: 'Cumplido',
  no_aplica: 'No aplica',
};

export type Applies = 'si' | 'no' | 'revisar';

export const ITEM_COLUMNS =
  'id, item_key, period, area, title, description, frequency, due_on, due_needs_confirmation, legal_basis, applies, applicability_note, status, evidence_document_id, evidence_url, evidence_note, completed_at, completed_by, owner_user_id, commitment_id, linked_href, source, rule_version, created_at, updated_at';

export interface ItemRow {
  id: string;
  item_key: string;
  period: string;
  area: ComplianceArea;
  title: string;
  description: string | null;
  frequency: ItemFrequency;
  due_on: string | null;
  due_needs_confirmation: boolean;
  legal_basis: string | null;
  applies: Applies;
  applicability_note: string | null;
  status: ItemStatus;
  evidence_document_id: string | null;
  evidence_url: string | null;
  evidence_note: string | null;
  completed_at: string | null;
  completed_by: string | null;
  owner_user_id: string | null;
  commitment_id: string | null;
  linked_href: string | null;
  source: 'catalogo' | 'manual';
  rule_version: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// PQRS
// ---------------------------------------------------------------------------

export const PQRS_KINDS = ['peticion', 'queja', 'reclamo', 'sugerencia', 'felicitacion'] as const;
export type PqrsKind = (typeof PQRS_KINDS)[number];
export const PQRS_KIND_LABEL: Record<PqrsKind, string> = {
  peticion: 'Petición',
  queja: 'Queja',
  reclamo: 'Reclamo',
  sugerencia: 'Sugerencia',
  felicitacion: 'Felicitación',
};

export const PQRS_MATTERS = [
  'general',
  'informacion',
  'consulta',
  'consumo',
  'datos_personales',
] as const;
export type PqrsMatter = (typeof PQRS_MATTERS)[number];
export const PQRS_MATTER_LABEL: Record<PqrsMatter, string> = {
  general: 'General',
  informacion: 'Pide documentos o información',
  consulta: 'Consulta (concepto)',
  consumo: 'Producto o servicio (consumidor)',
  datos_personales: 'Datos personales (habeas data)',
};

export const PQRS_CHANNELS = [
  'formulario',
  'correo',
  'whatsapp',
  'telefono',
  'presencial',
  'otro',
] as const;
export type PqrsChannel = (typeof PQRS_CHANNELS)[number];
export const PQRS_CHANNEL_LABEL: Record<PqrsChannel, string> = {
  formulario: 'Formulario web',
  correo: 'Correo',
  whatsapp: 'WhatsApp',
  telefono: 'Teléfono',
  presencial: 'Presencial',
  otro: 'Otro',
};

export const PQRS_STATUSES = [
  'radicada',
  'en_tramite',
  'respondida',
  'cerrada',
  'trasladada',
  'desistida',
] as const;
export type PqrsStatus = (typeof PQRS_STATUSES)[number];
export const PQRS_STATUS_LABEL: Record<PqrsStatus, string> = {
  radicada: 'Radicada',
  en_tramite: 'En trámite',
  respondida: 'Respondida',
  cerrada: 'Cerrada',
  trasladada: 'Trasladada',
  desistida: 'Desistida',
};
export const PQRS_OPEN: readonly PqrsStatus[] = ['radicada', 'en_tramite'];

export const PQRS_COLUMNS =
  'id, year, seq, radicado, channel, kind, matter, subject, body, requester_name, requester_id_number, requester_email, requester_phone, client_id, received_at, received_on, deadline_days, due_on, deadline_basis, extended_due_on, extension_reason, status, assigned_user_id, response_text, responded_at, responded_by, response_channel, source_ref, consent_accepted, created_by, created_at, updated_at';

export interface PqrsRow {
  id: string;
  year: number;
  seq: number;
  radicado: string;
  channel: PqrsChannel;
  kind: PqrsKind;
  matter: PqrsMatter;
  subject: string;
  body: string;
  requester_name: string;
  requester_id_number: string | null;
  requester_email: string | null;
  requester_phone: string | null;
  client_id: string | null;
  received_at: string;
  received_on: string;
  deadline_days: number;
  due_on: string;
  deadline_basis: string;
  extended_due_on: string | null;
  extension_reason: string | null;
  status: PqrsStatus;
  assigned_user_id: string | null;
  response_text: string | null;
  responded_at: string | null;
  responded_by: string | null;
  response_channel: PqrsChannel | null;
  source_ref: string | null;
  consent_accepted: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Procesos judiciales
// ---------------------------------------------------------------------------

export const CASE_ROLES = ['demandante', 'demandado', 'tercero', 'otro'] as const;
export type CaseRole = (typeof CASE_ROLES)[number];
export const CASE_ROLE_LABEL: Record<CaseRole, string> = {
  demandante: 'Demandante',
  demandado: 'Demandado',
  tercero: 'Tercero',
  otro: 'Otro',
};

export const CASE_STATUSES = ['activo', 'suspendido', 'terminado', 'archivado'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  activo: 'Activo',
  suspendido: 'Suspendido',
  terminado: 'Terminado',
  archivado: 'Archivado',
};

export const CASE_COLUMNS =
  'id, radicado, title, court, city, process_type, role, counterparty, parties, claim_amount, status, last_action_on, last_action, next_hearing_on, next_hearing, lawyer, owner_user_id, client_id, contract_id, hearing_commitment_id, last_checked_at, last_checked_via, created_by, created_at, updated_at';

export interface CaseRow {
  id: string;
  radicado: string | null;
  title: string;
  court: string | null;
  city: string | null;
  process_type: string | null;
  role: CaseRole;
  counterparty: string | null;
  parties: string | null;
  claim_amount: number | string | null;
  status: CaseStatus;
  last_action_on: string | null;
  last_action: string | null;
  next_hearing_on: string | null;
  next_hearing: string | null;
  lawyer: string | null;
  owner_user_id: string | null;
  client_id: string | null;
  contract_id: string | null;
  hearing_commitment_id: string | null;
  last_checked_at: string | null;
  last_checked_via: 'manual' | 'rama_judicial' | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const CASE_ACTION_COLUMNS = 'id, case_id, action_on, text, source, created_by, created_at';

export interface CaseActionRow {
  id: string;
  case_id: string;
  action_on: string;
  text: string;
  source: 'manual' | 'rama_judicial';
  created_by: string | null;
  created_at: string;
}

/** La consulta pública de la Rama Judicial (Consulta de Procesos Nacional Unificada). */
export const RAMA_JUDICIAL_URL = 'https://consultaprocesos.ramajudicial.gov.co/';
