/**
 * LO QUE LAS PANTALLAS DE PROYECTOS RECIBEN (migración 0196).
 *
 * Módulo puro y sin dependencias: lo importan los componentes `'use client'`
 * (components/projects), «Mi semana» y el escaparate de desarrollo. Todo llega
 * ya armado del servidor (lib/projects/views.ts): cifras como texto listo para
 * leer, tonos como palabras. Ningún componente calcula márgenes ni horas.
 */

export type Tone = 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';

export type ActionResult =
  | { ok: true; note?: string; href?: string }
  | { ok: false; error: string };

export type ProjectsTab = 'proyectos' | 'horas' | 'tarifas';

export const PROJECTS_TABS: Array<{ id: ProjectsTab; label: string }> = [
  { id: 'proyectos', label: 'Proyectos' },
  { id: 'horas', label: 'Horas de la semana' },
  { id: 'tarifas', label: 'Costo por hora' },
];

export function parseProjectsTab(raw: unknown): ProjectsTab {
  return PROJECTS_TABS.some((t) => t.id === raw) ? (raw as ProjectsTab) : 'proyectos';
}

export interface Tile {
  label: string;
  value: string;
  note: string;
  tone: Tone;
}

export interface Option {
  value: string;
  label: string;
}

/** Un proyecto elegible en «Registrar horas». */
export interface ProjectChoice {
  id: string;
  label: string;
}

export interface TimesheetView {
  start: string;
  /** «lun 28», «mar 29»… */
  dayLabels: string[];
  days: string[];
  today: string;
  rows: Array<{ key: string; label: string; href?: string | null; days: string[]; total: string }>;
  dayTotals: string[];
  total: string;
  prevHref: string;
  nextHref: string | null;
  weekLabel: string;
}

export interface RateView {
  userId: string | null;
  name: string;
  costRate: number | null;
  billRate: number | null;
  source: 'manual' | 'nomina' | null;
  hoursThisMonth: string;
}

export interface WonOpportunityView {
  id: string;
  title: string;
  client: string | null;
  value: string | null;
  wonAt: string;
}

export interface Bar {
  /** 0–100 (puede pasar de 100: se dibuja lleno y en rosa). */
  pct: number | null;
  tone: Tone;
  label: string;
  note: string;
}

export interface ProjectHeaderView {
  id: string;
  code: string;
  title: string;
  kindLabel: string;
  status: string;
  statusLabel: string;
  statusTone: Tone;
  client: string | null;
  clientHref: string | null;
  owner: string | null;
  start: string | null;
  due: string | null;
  finished: string | null;
  location: string | null;
  description: string | null;
  nextStatuses: Option[];
}

export interface ProjectDetailView {
  header: ProjectHeaderView;
  bars: { progress: Bar; hours: Bar; cost: Bar };
  margin: { value: string; pct: string | null; basis: string; tone: Tone };
  revenue: { amount: string; invoiced: string; unbilled: string; unbilledRaw: number };
  breakdown: Array<{ key: string; label: string; amount: string; raw: number; pct: number }>;
  alerts: Array<{ label: string; message: string; tone: Tone }>;
  tasks: Array<{
    id: string;
    title: string;
    done: boolean;
    cancelled: boolean;
    assignee: string | null;
    due: string | null;
    late: boolean;
  }>;
  time: Array<{
    id: string;
    person: string;
    date: string;
    hours: string;
    billable: boolean;
    cost: string;
    note: string | null;
    canDelete: boolean;
  }>;
  costs: Array<{
    id: string;
    kind: string;
    description: string;
    amount: string;
    date: string;
    from: string;
  }>;
  materials: Array<{ id: string; product: string; qty: string; cost: string; date: string }>;
  milestones: Array<{
    id: string;
    title: string;
    amount: string;
    due: string | null;
    status: string;
    statusTone: Tone;
    invoiceHref: string | null;
    canInvoice: boolean;
  }>;
  documents: Array<{
    id: string;
    label: string;
    kind: string;
    status: string;
    amount: string;
    href: string;
  }>;
  team: Array<{ name: string; hours: string; cost: string }>;
  timeline: Array<{ date: string; label: string; tone: Tone }>;
  people: Option[];
  ledgerExpenses: Array<{ id: string; label: string }>;
  products: Option[];
  canManage: boolean;
  salesEnabled: boolean;
  inventoryEnabled: boolean;
}

export const COST_KIND_OPTIONS: Option[] = [
  { value: 'gasto', label: 'Gasto' },
  { value: 'material', label: 'Material comprado' },
  { value: 'subcontrato', label: 'Subcontrato' },
  { value: 'otro', label: 'Otro' },
];
