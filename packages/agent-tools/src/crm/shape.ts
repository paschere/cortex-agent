/**
 * EL VOCABULARIO DEL EMBUDO COMERCIAL (migración 0193): etapas, orígenes,
 * razones de pérdida, clases de actividad, las filas como salen de la base y
 * las cuentas pequeñas que todos usan (probabilidad efectiva, ¿está abierta?).
 *
 * Módulo puro (no importa nada con estado): lo usan las herramientas, la
 * pantalla /comercial (componentes `'use client'` lo importan por ruta
 * profunda), la encuesta pública y las pruebas.
 */

export type StageRole = 'quote_sent' | 'at_risk' | 'won' | 'lost';

export interface StageDef {
  key: string;
  label: string;
  /** Probabilidad por defecto (0–100) de un negocio en esta etapa. */
  probability: number;
  /** El papel que las reglas automáticas buscan; null = etapa de trabajo. */
  role: StageRole | null;
}

/**
 * El embudo de la casa. Una empresa sin fila en `crm_pipelines` trabaja con
 * éste; el orden es el del tablero.
 */
export const DEFAULT_STAGES: readonly StageDef[] = [
  { key: 'nuevo', label: 'Nuevo', probability: 10, role: null },
  { key: 'contactado', label: 'Contactado', probability: 20, role: null },
  { key: 'cotizacion_enviada', label: 'Cotización enviada', probability: 50, role: 'quote_sent' },
  { key: 'negociacion', label: 'Negociación', probability: 70, role: null },
  { key: 'en_riesgo', label: 'En riesgo', probability: 25, role: 'at_risk' },
  { key: 'ganada', label: 'Ganada', probability: 100, role: 'won' },
  { key: 'perdida', label: 'Perdida', probability: 0, role: 'lost' },
] as const;

export const STAGE_KEY_RE = /^[a-z0-9_]{1,40}$/;

/** Las etapas válidas de una fila de `crm_pipelines.stages`; si no sirven, las de la casa. */
export function parseStages(raw: unknown): StageDef[] {
  if (!Array.isArray(raw)) return [...DEFAULT_STAGES];
  const out: StageDef[] = [];
  const seen = new Set<string>();
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    const key = typeof r.key === 'string' ? r.key : '';
    if (!STAGE_KEY_RE.test(key) || seen.has(key)) continue;
    seen.add(key);
    const p = Number(r.probability);
    const role =
      r.role === 'quote_sent' || r.role === 'at_risk' || r.role === 'won' || r.role === 'lost'
        ? r.role
        : null;
    out.push({
      key,
      label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 60) : key,
      probability: Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : 0,
      role,
    });
  }
  // Sin una etapa ganada y una perdida el embudo no puede cerrar nada.
  if (out.length < 2 || !out.some((s) => s.role === 'won') || !out.some((s) => s.role === 'lost'))
    return [...DEFAULT_STAGES];
  return out;
}

export function stageByRole(stages: readonly StageDef[], role: StageRole): StageDef | null {
  return stages.find((s) => s.role === role) ?? null;
}

export function stageOf(stages: readonly StageDef[], key: string): StageDef | null {
  return stages.find((s) => s.key === key) ?? null;
}

/** Ganada o perdida: ya no está en juego. */
export function isClosedStage(stages: readonly StageDef[], key: string): boolean {
  const role = stageOf(stages, key)?.role;
  return role === 'won' || role === 'lost';
}

export const SOURCES = ['prospect', 'inbound', 'referral', 'whatsapp', 'email', 'otro'] as const;
export type OpportunitySource = (typeof SOURCES)[number];

export const SOURCE_LABEL: Record<OpportunitySource, string> = {
  prospect: 'Prospección',
  inbound: 'Llegó solo',
  referral: 'Referido',
  whatsapp: 'WhatsApp',
  email: 'Correo',
  otro: 'Otro',
};

export const LOST_REASONS = [
  'precio',
  'competencia',
  'sin_presupuesto',
  'sin_respuesta',
  'tiempo',
  'producto',
  'otro',
] as const;
export type LostReasonKind = (typeof LOST_REASONS)[number];

export const LOST_REASON_LABEL: Record<LostReasonKind, string> = {
  precio: 'Precio',
  competencia: 'Se fue con la competencia',
  sin_presupuesto: 'Sin presupuesto',
  sin_respuesta: 'Dejó de responder',
  tiempo: 'No era el momento',
  producto: 'No era lo que necesitaba',
  otro: 'Otra razón',
};

export const ACTIVITY_KINDS = ['call', 'meeting', 'email', 'note', 'task', 'stage'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
/** Las que una persona registra (la de etapa la deja el sistema). */
export const LOGGABLE_KINDS = ['call', 'meeting', 'email', 'note', 'task'] as const;
export type LoggableKind = (typeof LOGGABLE_KINDS)[number];

export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  call: 'Llamada',
  meeting: 'Reunión',
  email: 'Correo',
  note: 'Nota',
  task: 'Tarea',
  stage: 'Cambio de etapa',
};

export type ActivityOrigin = 'manual' | 'rule' | 'nps' | 'autopilot' | 'agent';

export interface OpportunityRow {
  id: string;
  pipeline_id: string | null;
  client_id: string | null;
  client_name: string;
  title: string;
  value: number;
  currency: string;
  stage: string;
  probability: number | null;
  expected_close: string | null;
  owner_user_id: string | null;
  source: OpportunitySource;
  prospect_ref: string | null;
  next_step: string | null;
  next_step_due: string | null;
  lost_reason_kind: LostReasonKind | null;
  lost_reason: string | null;
  quote_id: string | null;
  order_id: string | null;
  notes: string | null;
  stage_changed_at: string;
  last_activity_at: string;
  won_at: string | null;
  lost_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActivityRow {
  id: string;
  opportunity_id: string | null;
  client_id: string | null;
  kind: ActivityKind;
  title: string;
  body: string | null;
  due_on: string | null;
  done_at: string | null;
  owner_user_id: string | null;
  origin: ActivityOrigin;
  created_by: string | null;
  created_at: string;
}

export type SurveyStatus = 'pendiente' | 'enviada' | 'respondida' | 'anulada';

export interface SurveyRow {
  id: string;
  client_id: string | null;
  client_name: string;
  contact_name: string | null;
  contact_email: string | null;
  token: string;
  channel: 'email' | 'link';
  status: SurveyStatus;
  sent_at: string | null;
  opened_at: string | null;
  responded_at: string | null;
  expires_on: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ResponseRow {
  id: string;
  survey_id: string;
  client_id: string | null;
  score: number;
  comment: string | null;
  respondent_name: string | null;
  follow_up_id: string | null;
  created_at: string;
}

export type RiskLevel = 'alto' | 'medio' | 'bajo';

export const RISK_LABEL: Record<RiskLevel, string> = {
  alto: 'Riesgo alto',
  medio: 'Riesgo medio',
  bajo: 'Sin señales',
};

export const RISK_RANK: Record<RiskLevel, number> = { bajo: 0, medio: 1, alto: 2 };

/** La probabilidad que cuenta: la propia o la de su etapa. */
export function effectiveProbability(
  opp: Pick<OpportunityRow, 'probability' | 'stage'>,
  stages: readonly StageDef[],
): number {
  if (opp.probability != null) return Math.max(0, Math.min(100, opp.probability));
  return stageOf(stages, opp.stage)?.probability ?? 0;
}

export function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** «$12.400.000» para pesos; «1.250,5 USD» para lo demás. */
export function formatAmount(amount: number, currency = 'COP'): string {
  const c = (currency || 'COP').toUpperCase();
  if (c === 'COP') return `$${Math.round(amount).toLocaleString('es-CO')}`;
  return `${amount.toLocaleString('es-CO', { maximumFractionDigits: 2 })} ${c}`;
}

/** NPS: 0–6 detractor, 7–8 pasivo, 9–10 promotor. */
export type NpsBucket = 'detractor' | 'pasivo' | 'promotor';

export function npsBucket(score: number): NpsBucket {
  if (score >= 9) return 'promotor';
  if (score >= 7) return 'pasivo';
  return 'detractor';
}

export const NPS_BUCKET_LABEL: Record<NpsBucket, string> = {
  detractor: 'Detractor',
  pasivo: 'Pasivo',
  promotor: 'Promotor',
};

/** % promotores − % detractores, de −100 a 100. Null sin respuestas. */
export function npsScore(scores: readonly number[]): number | null {
  if (scores.length === 0) return null;
  let pro = 0;
  let det = 0;
  for (const s of scores) {
    const b = npsBucket(s);
    if (b === 'promotor') pro += 1;
    else if (b === 'detractor') det += 1;
  }
  return Math.round(((pro - det) / scores.length) * 100);
}

export const SURVEY_TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
