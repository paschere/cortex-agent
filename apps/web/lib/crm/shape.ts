/**
 * LO QUE LA PANTALLA /comercial RECIBE (migración 0193).
 *
 * Módulo puro y sin dependencias: lo importan los componentes `'use client'`
 * (components/crm) y el escaparate de desarrollo. Todo llega ya armado del
 * servidor (lib/crm/views.ts): cifras como texto listo para leer, tonos como
 * palabras. Ningún componente calcula riesgo, pronóstico ni márgenes.
 */

import type { GridView } from '@/components/datagrid/types';

export type Tone = 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';

export type ActionResult =
  | { ok: true; note?: string; href?: string; link?: string }
  | { ok: false; error: string };

export type CrmTab =
  | 'embudo'
  | 'oportunidades'
  | 'actividades'
  | 'riesgo'
  | 'analisis'
  | 'encuestas';

export const CRM_TABS: Array<{ id: CrmTab; label: string }> = [
  { id: 'embudo', label: 'Embudo' },
  { id: 'oportunidades', label: 'Oportunidades' },
  { id: 'actividades', label: 'Actividades' },
  { id: 'riesgo', label: 'En riesgo' },
  { id: 'analisis', label: 'Análisis' },
  { id: 'encuestas', label: 'Encuestas' },
];

export function parseCrmTab(raw: unknown): CrmTab {
  return CRM_TABS.some((t) => t.id === raw) ? (raw as CrmTab) : 'embudo';
}

export interface CrmTile {
  label: string;
  value: string;
  note: string;
  tone: Tone;
}

export interface ForecastBarView {
  month: string;
  label: string;
  weighted: number;
  weightedLabel: string;
  totalLabel: string;
  count: number;
  /** 0–1 contra el mes más alto, para la barra. */
  share: number;
}

export interface ForecastView {
  bars: ForecastBarView[];
  pipelineWeightedLabel: string;
  pipelineTotalLabel: string;
  notes: string[];
}

export interface StaleView {
  id: string;
  title: string;
  clientName: string;
  valueLabel: string;
  why: string;
  suggestion: string;
  ownerName: string | null;
  stageLabel: string;
}

export interface TaskView {
  id: string;
  title: string;
  body: string | null;
  kindLabel: string;
  due: string | null;
  dueLabel: string;
  bucket: 'vencida' | 'hoy' | 'proxima' | 'sin_fecha';
  oppId: string | null;
  oppTitle: string | null;
  clientName: string | null;
  clientId: string | null;
  ownerId: string | null;
  ownerName: string | null;
  originLabel: string | null;
}

export interface RiskView {
  clientId: string;
  clientName: string;
  level: 'alto' | 'medio';
  levelLabel: string;
  tone: Tone;
  score: number;
  evidence: string[];
  action: string | null;
  ownerName: string | null;
  revenueLabel: string;
  href: string;
}

export interface RateRowView {
  key: string;
  label: string;
  rateLabel: string;
  /** 0–1 para la barra; null sin nada decidido. */
  rate: number | null;
  detail: string;
}

export interface MarginRowView {
  key: string;
  label: string;
  revenueLabel: string;
  marginLabel: string;
  marginTone: Tone;
  coverageLabel: string;
  discountLabel: string;
  priceLabel: string | null;
}

export interface AnalyticsView {
  tiles: CrmTile[];
  byMonth: RateRowView[];
  byOwner: RateRowView[];
  byProduct: RateRowView[];
  reasons: Array<{ label: string; count: number; valueLabel: string; share: number }>;
  bySource: Array<{ label: string; detail: string }>;
  marginTotals: { revenueLabel: string; marginLabel: string; coverageLabel: string };
  marginNote: string | null;
  marginsByClient: MarginRowView[];
  marginsByProduct: MarginRowView[];
  missing: string[];
}

export interface SurveyView {
  id: string;
  clientName: string;
  clientId: string | null;
  contact: string | null;
  statusLabel: string;
  tone: Tone;
  sentLabel: string;
  score: number | null;
  bucketLabel: string | null;
  comment: string | null;
  respondent: string | null;
  link: string;
  followUp: boolean;
}

export interface NpsSummaryView {
  scoreLabel: string;
  tone: Tone;
  responses: number;
  promoters: number;
  passives: number;
  detractors: number;
  pending: number;
  note: string;
}

export interface TimelineEntryView {
  id: string;
  whenLabel: string;
  kindLabel: string;
  title: string;
  detail: string | null;
  by: string | null;
  href: string | null;
  from: 'crm' | 'hub';
  done: boolean;
}

export interface ClientOption {
  id: string;
  name: string;
}

export interface OppOption {
  id: string;
  label: string;
}

export interface ClientOpportunityView {
  id: string;
  title: string;
  stageLabel: string;
  tone: Tone;
  valueLabel: string;
  closeLabel: string | null;
  nextStep: string | null;
  href: string;
}

/** El tablero del embudo: la grilla agrupada por etapa (arrastrar = cambiar de etapa). */
export const BOARD_VIEW: Partial<GridView> = {
  layout: 'board',
  layoutKey: 'etapa',
  filters: [],
  sort: [{ key: 'valor', dir: 'desc' }],
  hidden: ['razon', 'cotizacion', 'origen', 'siguiente_fecha', 'probabilidad', 'quieto'],
};
