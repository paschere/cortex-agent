/**
 * EL VOCABULARIO DE LO QUE CORTEX RECOMIENDA (migración 0177).
 *
 * Una recomendación es una frase con sujeto: «cóbrale primero a Nexa»,
 * «reparte los despachos de Laura», «arregla la rutina de cartera». Para poder
 * decir después si se siguió y qué pasó, cada una se guarda con:
 *
 *   kind             qué tipo de consejo es (la tasa de acierto va por aquí)
 *   subject          sobre quién o qué: un cliente, una persona, un ítem…
 *   expected effect  qué debería moverse si sirve: cobrar, bajar vencidos…
 *   baseline         las cifras del momento, contra las que se mide después
 *
 * Nada de este archivo toca la base ni el reloj.
 */

export const RECOMMENDATION_SOURCES = [
  'weekly_review',
  'work_signals',
  'forecast',
  'pulse',
  'management',
] as const;
export type RecommendationSource = (typeof RECOMMENDATION_SOURCES)[number];

export const RECOMMENDATION_SOURCE_LABEL: Record<RecommendationSource, string> = {
  weekly_review: 'Revisión semanal',
  work_signals: 'Trabajo del equipo',
  forecast: 'Proyección de caja',
  pulse: 'Pulso de la empresa',
  management: 'Gerencia',
};

export const EXPECTED_EFFECTS = [
  'collect',
  'reduce_overdue',
  'reduce_load',
  'raise_cash',
  'decide',
  'fix',
  'setup',
] as const;
export type ExpectedEffect = (typeof EXPECTED_EFFECTS)[number];

export const RECOMMENDATION_KINDS = [
  // Plata
  'collect_counterparty',
  'collect_overdue',
  'automate_collections',
  'cash_alert',
  'confirm_payments',
  // Lo que espera a alguien
  'review_approvals',
  'fix_routine',
  'close_commitments',
  'prepare_due',
  'decide_cases',
  'management_case',
  // El equipo
  'rebalance_person',
  'clear_overdue_person',
  'assign_unassigned',
  'revive_stale',
  // Montaje
  'review_sales',
  'setup_pulse',
  'keep_pulse',
  'setup_goals',
] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

export const RECOMMENDATION_KIND_EFFECT: Record<RecommendationKind, ExpectedEffect> = {
  collect_counterparty: 'collect',
  collect_overdue: 'collect',
  automate_collections: 'collect',
  cash_alert: 'raise_cash',
  confirm_payments: 'collect',
  review_approvals: 'decide',
  fix_routine: 'fix',
  close_commitments: 'reduce_overdue',
  prepare_due: 'reduce_overdue',
  decide_cases: 'decide',
  management_case: 'decide',
  rebalance_person: 'reduce_load',
  clear_overdue_person: 'reduce_overdue',
  assign_unassigned: 'reduce_load',
  revive_stale: 'reduce_overdue',
  review_sales: 'setup',
  setup_pulse: 'setup',
  keep_pulse: 'setup',
  setup_goals: 'setup',
};

/** Cómo se llama cada tipo delante de una persona. */
export const RECOMMENDATION_KIND_LABEL: Record<RecommendationKind, string> = {
  collect_counterparty: 'Cobrarle a un cliente',
  collect_overdue: 'Cobrar la cartera vencida',
  automate_collections: 'Activar la cartera que avisa sola',
  cash_alert: 'Cuidar la caja',
  confirm_payments: 'Confirmar pagos prometidos',
  review_approvals: 'Decidir lo que espera aprobación',
  fix_routine: 'Arreglar una rutina',
  close_commitments: 'Cerrar compromisos vencidos',
  prepare_due: 'Preparar vencimientos',
  decide_cases: 'Decidir asuntos de Gerencia',
  management_case: 'Mover un asunto de Gerencia',
  rebalance_person: 'Repartir la carga de alguien',
  clear_overdue_person: 'Sacar los vencidos de alguien',
  assign_unassigned: 'Asignar lo que no tiene responsable',
  revive_stale: 'Mover lo que está quieto',
  review_sales: 'Revisar las ventas',
  setup_pulse: 'Armar el pulso',
  keep_pulse: 'Dejar corriendo el resumen diario',
  setup_goals: 'Definir metas',
};

export const SUBJECT_KINDS = ['counterparty', 'person', 'item', 'routine', 'company'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const RECOMMENDATION_STATUSES = [
  'open',
  'in_progress',
  'followed',
  'not_followed',
  'unmeasurable',
] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

export const RECOMMENDATION_STATUS_LABEL: Record<RecommendationStatus, string> = {
  open: 'Recién hecha',
  in_progress: 'En curso',
  followed: 'Seguida',
  not_followed: 'No seguida',
  unmeasurable: 'Sin forma de medirla',
};

export const RECOMMENDATION_OUTCOMES = ['pending', 'good', 'none', 'worse'] as const;
export type RecommendationOutcome = (typeof RECOMMENDATION_OUTCOMES)[number];

export const RECOMMENDATION_OUTCOME_LABEL: Record<RecommendationOutcome, string> = {
  pending: 'Por ver',
  good: 'Mejoró después',
  none: 'Sin cambio',
  worse: 'Empeoró',
};

export type Severity = 'info' | 'warn' | 'critical';

export interface SuggestedAction {
  toolId: string;
  input: Record<string, unknown>;
}

/** Las cifras del momento. Sólo números y textos cortos: se citan después. */
export type Baseline = Record<string, number | string | null>;

/** Lo que se guarda al recomendar. */
export interface RecommendationDraft {
  source: RecommendationSource;
  kind: RecommendationKind;
  subjectKind: SubjectKind;
  /** La llave normalizada del sujeto (ver `subjectKeyOf`). */
  subjectKey: string;
  subjectLabel: string | null;
  /** La frase tal como se dijo. */
  text: string;
  /** La versión corta para «Recomendé …»: «cobrarle primero a Nexa». */
  headline: string;
  suggestedAction: SuggestedAction | null;
  severity: Severity;
  baseline: Baseline;
  createdFor?: string | null;
}

/** Lo que dejó escrito la evaluación sobre si se siguió. */
export interface FollowEvidence {
  /** Qué se vio. */
  what?:
    | 'collection_sent'
    | 'collection_proposed'
    | 'reassigned'
    | 'count_dropped'
    | 'decided'
    | 'routine_changed'
    | 'item_moved'
    | 'nothing';
  /** Cuándo (ISO). */
  at?: string | null;
  /** Cuántas cosas (cobros, decisiones…). */
  count?: number | null;
}

/** Lo que dejó escrito la evaluación sobre qué pasó después. */
export interface OutcomeEvidence {
  what?:
    | 'payment'
    | 'no_payment'
    | 'count'
    | 'alert_gone'
    | 'alert_still'
    | 'no_errors'
    | 'errors'
    | 'closed'
    | 'still_open';
  at?: string | null;
  amount?: number | null;
  currency?: string | null;
  from?: number | null;
  to?: number | null;
}

/** Una fila de `recommendations`, ya leída. */
export interface RecommendationRecord extends RecommendationDraft {
  id: string;
  expectedEffect: ExpectedEffect;
  createdAt: string;
  status: RecommendationStatus;
  followedAt: string | null;
  followEvidence: FollowEvidence;
  outcome: RecommendationOutcome | null;
  outcomeEvidence: OutcomeEvidence;
  evaluatedAt: string | null;
}

/** Tipos que no tienen cómo medirse: se guardan para la lista, no cuentan en la tasa. */
export const UNMEASURABLE_KINDS: ReadonlySet<RecommendationKind> = new Set([
  'automate_collections',
  'prepare_due',
  'review_sales',
  'setup_pulse',
  'keep_pulse',
  'setup_goals',
  'confirm_payments',
]);

/**
 * La llave de un sujeto: minúsculas, sin tildes, sin signos ni la razón social
 * («S.A.S.», «Ltda.»). «Nexa S.A.S.» y «NEXA sas» son el mismo cliente.
 */
export function subjectKeyOf(label: string): string {
  return label
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\b(s\.?\s?a\.?\s?s|s\.?\s?a|ltda|limitada|e\.?\s?u|inc|llc|cia)(?=\.|\s|$)\.?/g, ' ')
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

/**
 * La identidad de una recomendación: tipo, sujeto y semana ISO. La misma
 * recomendación dicha el lunes en la revisión y el martes en el pulso es una.
 */
export function recommendationDedupeKey(
  draft: Pick<RecommendationDraft, 'kind' | 'subjectKey'>,
  weekStart: string,
): string {
  return `${draft.kind}:${draft.subjectKey || 'empresa'}:${weekStart}`.slice(0, 300);
}

/** ¿Nunca se puede dejar fuera por el orden? La caja en rojo y la cartera vencida. */
export function isPinnedRecommendation(r: Pick<RecommendationDraft, 'kind' | 'severity'>): boolean {
  if (r.severity === 'critical') return true;
  return r.kind === 'collect_counterparty' || r.kind === 'collect_overdue';
}

/** Lo que propone una fuente antes de saber de dónde salió ni para quién. */
export type RecommendationCandidate = Omit<RecommendationDraft, 'source' | 'createdFor'>;
