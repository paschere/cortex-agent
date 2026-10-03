/**
 * EL VOCABULARIO DE PROYECTOS Y ÓRDENES DE SERVICIO (migración 0196).
 *
 * Estados, tipos, etiquetas y filas. Nada de base de datos ni de reloj: lo
 * importan el motor puro (./math), el almacén (./store), las herramientas y la
 * pantalla /proyectos (sólo tipos y constantes del lado del navegador).
 */

export const PROJECT_STATUSES = [
  'cotizado',
  'abierto',
  'en_curso',
  'en_pausa',
  'terminado',
  'facturado',
  'cerrado',
  'cancelado',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  cotizado: 'Cotizado',
  abierto: 'Abierto',
  en_curso: 'En curso',
  en_pausa: 'En pausa',
  terminado: 'Terminado',
  facturado: 'Facturado',
  cerrado: 'Cerrado',
  cancelado: 'Cancelado',
};

export type ProjectTone = 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';

export const PROJECT_STATUS_TONE: Record<ProjectStatus, ProjectTone> = {
  cotizado: 'neutral',
  abierto: 'primary',
  en_curso: 'primary',
  en_pausa: 'amber',
  terminado: 'emerald',
  facturado: 'emerald',
  cerrado: 'neutral',
  cancelado: 'rose',
};

/** Lo que todavía se trabaja (cuenta para «tarde» y para el tablero activo). */
export const ACTIVE_STATUSES: readonly ProjectStatus[] = ['abierto', 'en_curso', 'en_pausa'];
/** Ya no se trabaja: terminado o después. */
export const FINISHED_STATUSES: readonly ProjectStatus[] = ['terminado', 'facturado', 'cerrado'];

/** Los pasos que se permiten desde cada estado. */
const NEXT: Record<ProjectStatus, readonly ProjectStatus[]> = {
  cotizado: ['abierto', 'en_curso', 'cancelado'],
  abierto: ['en_curso', 'en_pausa', 'terminado', 'cancelado', 'cotizado'],
  en_curso: ['en_pausa', 'terminado', 'cancelado', 'abierto'],
  en_pausa: ['en_curso', 'abierto', 'terminado', 'cancelado'],
  terminado: ['facturado', 'cerrado', 'en_curso'],
  facturado: ['cerrado', 'terminado'],
  cerrado: ['facturado', 'terminado'],
  cancelado: ['abierto'],
};

export function canMoveProject(from: ProjectStatus, to: ProjectStatus): boolean {
  return from === to || NEXT[from].includes(to);
}

export class ProjectStateError extends Error {
  constructor(from: ProjectStatus, to: ProjectStatus) {
    super(
      `Un proyecto ${PROJECT_STATUS_LABEL[from].toLowerCase()} no puede pasar a ${PROJECT_STATUS_LABEL[to].toLowerCase()}.`,
    );
    this.name = 'ProjectStateError';
  }
}

export const PROJECT_KINDS = ['orden_servicio', 'proyecto'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PROJECT_KIND_LABEL: Record<ProjectKind, string> = {
  orden_servicio: 'Orden de servicio',
  proyecto: 'Proyecto',
};

const KIND_PREFIX: Record<ProjectKind, string> = { orden_servicio: 'OS', proyecto: 'PRY' };

/** OS-0007 / PRY-0007. Un solo consecutivo para los dos tipos. */
export function projectCode(kind: ProjectKind, number: number): string {
  return `${KIND_PREFIX[kind]}-${String(number).padStart(4, '0')}`;
}

/** «OS-7», «os 0007», «PRY-12» → 7 / 12. */
export function parseProjectNumber(raw: string): number | null {
  const m = /^\s*(?:os|pry|p)?[\s\-#]*0*(\d{1,7})\s*$/i.exec(raw);
  return m ? Number(m[1]) : null;
}

export const COST_KINDS = ['material', 'gasto', 'subcontrato', 'otro'] as const;
export type CostKind = (typeof COST_KINDS)[number];

export const COST_KIND_LABEL: Record<CostKind, string> = {
  material: 'Materiales',
  gasto: 'Gastos',
  subcontrato: 'Subcontratos',
  otro: 'Otros',
};

export const MILESTONE_STATUSES = ['pendiente', 'listo', 'facturado', 'cancelado'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const MILESTONE_STATUS_LABEL: Record<MilestoneStatus, string> = {
  pendiente: 'Pendiente',
  listo: 'Listo para facturar',
  facturado: 'Facturado',
  cancelado: 'Cancelado',
};

// ---------------------------------------------------------------------------
// Filas
// ---------------------------------------------------------------------------

export const PROJECT_COLUMNS =
  'id, number, code, kind, title, description, status, client_id, client_name, owner_id, currency, budget_amount, budget_hours, contract_amount, start_on, due_on, finished_on, quote_id, sales_order_id, contract_id, opportunity_id, origin, team_ids, location, notes, created_by, created_at, updated_at';

export interface ProjectRow {
  id: string;
  number: number;
  code: string;
  kind: ProjectKind;
  title: string;
  description: string | null;
  status: ProjectStatus;
  client_id: string | null;
  client_name: string | null;
  owner_id: string | null;
  currency: string;
  budget_amount: number | string | null;
  budget_hours: number | string | null;
  contract_amount: number | string | null;
  start_on: string | null;
  due_on: string | null;
  finished_on: string | null;
  quote_id: string | null;
  sales_order_id: string | null;
  contract_id: string | null;
  opportunity_id: string | null;
  origin: string;
  team_ids: string[] | null;
  location: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const TIME_COLUMNS =
  'id, project_id, work_item_id, user_id, person_label, worked_on, hours, billable, cost_rate, bill_rate, note, recorded_by, created_at';

export interface TimeEntryRow {
  id: string;
  project_id: string;
  work_item_id: string | null;
  user_id: string | null;
  person_label: string | null;
  worked_on: string;
  hours: number | string;
  billable: boolean;
  cost_rate: number | string;
  bill_rate: number | string | null;
  note: string | null;
  recorded_by: string | null;
  created_at: string;
}

export const COST_COLUMNS =
  'id, project_id, kind, description, amount, currency, incurred_on, counterparty, ledger_movement_id, source, created_by, created_at';

export interface ProjectCostRow {
  id: string;
  project_id: string;
  kind: CostKind;
  description: string;
  amount: number | string;
  currency: string;
  incurred_on: string;
  counterparty: string | null;
  ledger_movement_id: string | null;
  source: string;
  created_by: string | null;
  created_at: string;
}

export const MILESTONE_COLUMNS =
  'id, project_id, position, title, amount, due_on, status, sales_document_id, invoiced_at';

export interface MilestoneRow {
  id: string;
  project_id: string;
  position: number;
  title: string;
  amount: number | string;
  due_on: string | null;
  status: MilestoneStatus;
  sales_document_id: string | null;
  invoiced_at: string | null;
}

export const RATE_COLUMNS = 'id, user_id, cost_rate, bill_rate, currency, source';

export interface RateRow {
  id: string;
  user_id: string | null;
  cost_rate: number | string;
  bill_rate: number | string | null;
  currency: string;
  source: 'manual' | 'nomina';
}

// ---------------------------------------------------------------------------
// Números
// ---------------------------------------------------------------------------

export function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** $ 12.400.000 — pesos sin decimales; otras monedas con su código. */
export function formatMoney(amount: number, currency = 'COP'): string {
  const rounded = Math.round(amount);
  const body = Math.abs(rounded).toLocaleString('es-CO');
  const sign = rounded < 0 ? '−' : '';
  return currency === 'COP' ? `${sign}$ ${body}` : `${sign}${currency} ${body}`;
}

/** 12,5 h */
export function formatHours(h: number): string {
  return `${round(h, 1).toLocaleString('es-CO')} h`;
}
