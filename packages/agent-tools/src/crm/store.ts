import { randomBytes } from 'node:crypto';
import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type ActivityKind,
  type ActivityOrigin,
  type ActivityRow,
  DEFAULT_STAGES,
  type LostReasonKind,
  type OpportunityRow,
  type OpportunitySource,
  type ResponseRow,
  type RiskLevel,
  type StageDef,
  type SurveyRow,
  npsBucket,
  parseStages,
  stageOf,
  toNumber,
} from './shape';

/**
 * LA BASE DEL EMBUDO (migración 0193). Todo con el handle de la empresa
 * (getOrgScopedClient): el `organization_id` lo pone el cliente con alcance.
 * Cada lectura revisa su `error`: «no hay» y «no pude leer» no se confunden.
 */

export const OPP_COLUMNS =
  'id, pipeline_id, client_id, client_name, title, value, currency, stage, probability, expected_close, owner_user_id, source, prospect_ref, next_step, next_step_due, lost_reason_kind, lost_reason, quote_id, order_id, notes, stage_changed_at, last_activity_at, won_at, lost_at, created_by, created_at, updated_at';

export const ACTIVITY_COLUMNS =
  'id, opportunity_id, client_id, kind, title, body, due_on, done_at, owner_user_id, origin, created_by, created_at';

export const SURVEY_COLUMNS =
  'id, client_id, client_name, contact_name, contact_email, token, channel, status, sent_at, opened_at, responded_at, expires_on, created_by, created_at';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function adaptOpp(r: Record<string, unknown>): OpportunityRow {
  return {
    ...(r as unknown as OpportunityRow),
    value: toNumber(r.value),
    probability: r.probability == null ? null : toNumber(r.probability),
  };
}

// ---------------------------------------------------------------------------
// El embudo
// ---------------------------------------------------------------------------

export async function loadStages(
  db: SupabaseClient,
): Promise<{ pipelineId: string | null; stages: StageDef[] }> {
  const { data, error } = await db
    .from('crm_pipelines')
    .select('id, stages')
    .eq('is_default', true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { pipelineId: null, stages: [...DEFAULT_STAGES] };
  const row = data as { id: string; stages: unknown };
  return { pipelineId: row.id, stages: parseStages(row.stages) };
}

// ---------------------------------------------------------------------------
// Oportunidades
// ---------------------------------------------------------------------------

export interface ListOpportunitiesOptions {
  clientId?: string;
  ownerUserId?: string;
  includeClosed?: boolean;
  limit?: number;
}

export async function listOpportunities(
  db: SupabaseClient,
  opts: ListOpportunitiesOptions = {},
): Promise<OpportunityRow[]> {
  let q = db.from('crm_opportunities').select(OPP_COLUMNS);
  if (opts.clientId) q = q.eq('client_id', opts.clientId);
  if (opts.ownerUserId) q = q.eq('owner_user_id', opts.ownerUserId);
  if (!opts.includeClosed) q = q.is('won_at', null).is('lost_at', null);
  const { data, error } = await q
    .order('updated_at', { ascending: false })
    .limit(Math.min(opts.limit ?? 500, 5000));
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(adaptOpp);
}

export async function getOpportunity(
  db: SupabaseClient,
  id: string,
): Promise<OpportunityRow | null> {
  if (!UUID_RE.test(id)) return null;
  const { data, error } = await db
    .from('crm_opportunities')
    .select(OPP_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? adaptOpp(data as Record<string, unknown>) : null;
}

/**
 * Una oportunidad por id, o por un texto que esté en su título o en el nombre
 * del cliente. Varias candidatas → error que las nombra (no se adivina).
 */
export async function resolveOpportunity(db: SupabaseClient, ref: string): Promise<OpportunityRow> {
  const clean = ref.trim();
  if (UUID_RE.test(clean)) {
    const opp = await getOpportunity(db, clean);
    if (opp) return opp;
  }
  const like = `%${clean.replace(/[%_,()]/g, ' ').trim()}%`;
  const { data, error } = await db
    .from('crm_opportunities')
    .select(OPP_COLUMNS)
    .or(`title.ilike.${like},client_name.ilike.${like}`)
    .order('updated_at', { ascending: false })
    .limit(10);
  if (error) throw error;
  const rows = ((data ?? []) as Array<Record<string, unknown>>).map(adaptOpp);
  const open = rows.filter((r) => !r.won_at && !r.lost_at);
  const pool = open.length ? open : rows;
  if (pool.length === 1) return pool[0] as OpportunityRow;
  if (pool.length === 0)
    throw new NotFoundError(
      `No encuentro una oportunidad que diga «${clean}». Búscala con crm.pipeline.`,
    );
  throw new ValidationError(
    `Hay varias oportunidades que se parecen a «${clean}»: ${pool
      .slice(0, 5)
      .map((r) => `«${r.title}» (${r.client_name})`)
      .join(', ')}. ¿Cuál?`,
  );
}

export interface OpportunityInput {
  clientId?: string | null;
  clientName: string;
  title: string;
  value?: number;
  currency?: string;
  stage?: string;
  probability?: number | null;
  expectedClose?: string | null;
  ownerUserId?: string | null;
  source?: OpportunitySource;
  prospectRef?: string | null;
  nextStep?: string | null;
  nextStepDue?: string | null;
  quoteId?: string | null;
  notes?: string | null;
}

export async function createOpportunity(
  db: SupabaseClient,
  input: OpportunityInput,
  opts: { userId: string | null },
): Promise<OpportunityRow> {
  const { pipelineId, stages } = await loadStages(db);
  const stage = input.stage ?? stages[0]?.key ?? 'nuevo';
  const def = stageOf(stages, stage);
  if (!def)
    throw new ValidationError(
      `La etapa «${stage}» no existe. Las etapas son: ${stages.map((s) => s.label).join(', ')}.`,
    );
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('crm_opportunities')
    .insert({
      pipeline_id: pipelineId,
      client_id: input.clientId ?? null,
      client_name: input.clientName.trim().slice(0, 200),
      title: input.title.trim().slice(0, 200),
      value: Math.max(0, input.value ?? 0),
      currency: (input.currency ?? 'COP').toUpperCase(),
      stage,
      probability: input.probability ?? null,
      expected_close: input.expectedClose ?? null,
      owner_user_id: input.ownerUserId ?? opts.userId,
      source: input.source ?? 'otro',
      prospect_ref: input.prospectRef ?? null,
      next_step: input.nextStep?.trim().slice(0, 500) || null,
      next_step_due: input.nextStepDue ?? null,
      quote_id: input.quoteId ?? null,
      notes: input.notes?.trim().slice(0, 4000) || null,
      won_at: def.role === 'won' ? now : null,
      lost_at: def.role === 'lost' ? now : null,
      created_by: opts.userId,
      updated_by: opts.userId,
    })
    .select(OPP_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505')
      throw new ValidationError('Esa cotización ya está atada a otra oportunidad.');
    throw error;
  }
  return adaptOpp(data as Record<string, unknown>);
}

export interface OpportunityPatch {
  title?: string;
  value?: number;
  currency?: string;
  stage?: string;
  probability?: number | null;
  expectedClose?: string | null;
  ownerUserId?: string | null;
  nextStep?: string | null;
  nextStepDue?: string | null;
  lostReasonKind?: LostReasonKind | null;
  lostReason?: string | null;
  quoteId?: string | null;
  orderId?: string | null;
  clientId?: string | null;
  clientName?: string;
  notes?: string | null;
  source?: OpportunitySource;
}

/**
 * Cambia lo que se pida. Un cambio de etapa deja huella en las actividades
 * (con quién o qué regla lo movió) y fija/limpia `won_at`/`lost_at`.
 */
export async function updateOpportunity(
  db: SupabaseClient,
  id: string,
  patch: OpportunityPatch,
  opts: { userId: string | null; origin?: ActivityOrigin; reason?: string | null },
): Promise<OpportunityRow> {
  const current = await getOpportunity(db, id);
  if (!current) throw new NotFoundError('Esa oportunidad ya no existe.');
  const { stages } = await loadStages(db);
  const row: Record<string, unknown> = { updated_by: opts.userId };
  const now = new Date().toISOString();
  if (patch.title !== undefined) row.title = patch.title.trim().slice(0, 200);
  if (patch.value !== undefined) row.value = Math.max(0, patch.value);
  if (patch.currency !== undefined) row.currency = patch.currency.toUpperCase();
  if (patch.probability !== undefined) row.probability = patch.probability;
  if (patch.expectedClose !== undefined) row.expected_close = patch.expectedClose;
  if (patch.ownerUserId !== undefined) row.owner_user_id = patch.ownerUserId;
  if (patch.nextStep !== undefined) row.next_step = patch.nextStep?.trim().slice(0, 500) || null;
  if (patch.nextStepDue !== undefined) row.next_step_due = patch.nextStepDue;
  if (patch.lostReasonKind !== undefined) row.lost_reason_kind = patch.lostReasonKind;
  if (patch.lostReason !== undefined)
    row.lost_reason = patch.lostReason?.trim().slice(0, 1000) || null;
  if (patch.quoteId !== undefined) row.quote_id = patch.quoteId;
  if (patch.orderId !== undefined) row.order_id = patch.orderId;
  if (patch.clientId !== undefined) row.client_id = patch.clientId;
  if (patch.clientName !== undefined) row.client_name = patch.clientName.trim().slice(0, 200);
  if (patch.notes !== undefined) row.notes = patch.notes?.trim().slice(0, 4000) || null;
  if (patch.source !== undefined) row.source = patch.source;

  const moving = patch.stage !== undefined && patch.stage !== current.stage;
  let to: StageDef | null = null;
  if (moving) {
    to = stageOf(stages, patch.stage as string);
    if (!to)
      throw new ValidationError(
        `La etapa «${patch.stage}» no existe. Las etapas son: ${stages.map((s) => s.label).join(', ')}.`,
      );
    row.stage = to.key;
    row.stage_changed_at = now;
    row.last_activity_at = now;
    row.won_at = to.role === 'won' ? (current.won_at ?? now) : null;
    row.lost_at = to.role === 'lost' ? (current.lost_at ?? now) : null;
    // Una probabilidad puesta a mano no sobrevive a un cambio de etapa: la
    // nueva etapa trae la suya (salvo que en el mismo cambio se fije otra).
    if (patch.probability === undefined) row.probability = null;
  }

  const { data, error } = await db
    .from('crm_opportunities')
    .update(row)
    .eq('id', id)
    .select(OPP_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505')
      throw new ValidationError('Esa cotización ya está atada a otra oportunidad.');
    throw error;
  }
  const next = adaptOpp(data as Record<string, unknown>);
  if (moving && to) {
    const from = stageOf(stages, current.stage)?.label ?? current.stage;
    await insertActivity(db, {
      opportunityId: id,
      clientId: next.client_id,
      kind: 'stage',
      title: `${from} → ${to.label}`,
      body: opts.reason ?? (to.role === 'lost' && next.lost_reason ? next.lost_reason : null),
      ownerUserId: opts.userId,
      origin: opts.origin ?? 'manual',
      createdBy: opts.userId,
      doneAt: now,
    });
  }
  return next;
}

// ---------------------------------------------------------------------------
// Actividades
// ---------------------------------------------------------------------------

export interface ActivityInput {
  opportunityId?: string | null;
  clientId?: string | null;
  kind: ActivityKind;
  title: string;
  body?: string | null;
  dueOn?: string | null;
  doneAt?: string | null;
  ownerUserId?: string | null;
  origin?: ActivityOrigin;
  createdBy: string | null;
}

async function insertActivity(db: SupabaseClient, input: ActivityInput): Promise<ActivityRow> {
  const { data, error } = await db
    .from('crm_activities')
    .insert({
      opportunity_id: input.opportunityId ?? null,
      client_id: input.clientId ?? null,
      kind: input.kind,
      title: input.title.trim().slice(0, 300),
      body: input.body?.trim().slice(0, 4000) || null,
      due_on: input.dueOn ?? null,
      done_at: input.doneAt ?? null,
      owner_user_id: input.ownerUserId ?? null,
      origin: input.origin ?? 'manual',
      created_by: input.createdBy,
    })
    .select(ACTIVITY_COLUMNS)
    .single();
  if (error) throw error;
  return data as ActivityRow;
}

/**
 * Registra una llamada, reunión, correo, nota o tarea. Lo que no es una tarea
 * pendiente cuenta como actividad del negocio (`last_activity_at`): saca la
 * oportunidad de la lista de lo quieto.
 */
export async function logActivity(db: SupabaseClient, input: ActivityInput): Promise<ActivityRow> {
  if (!input.opportunityId && !input.clientId)
    throw new ValidationError('Una actividad va con una oportunidad o con un cliente.');
  const isOpenTask = input.kind === 'task' && !input.doneAt;
  const activity = await insertActivity(db, {
    ...input,
    doneAt: input.doneAt ?? (input.kind === 'task' ? null : new Date().toISOString()),
  });
  if (input.opportunityId && !isOpenTask) {
    const { error: upError } = await db
      .from('crm_opportunities')
      .update({ last_activity_at: new Date().toISOString() })
      .eq('id', input.opportunityId);
    if (upError) throw upError;
  }
  return activity;
}

/** Marca una tarea hecha (o la reabre). Hecha cuenta como actividad. */
export async function setActivityDone(
  db: SupabaseClient,
  id: string,
  done: boolean,
): Promise<ActivityRow> {
  const { data, error } = await db
    .from('crm_activities')
    .update({ done_at: done ? new Date().toISOString() : null })
    .eq('id', id)
    .select(ACTIVITY_COLUMNS)
    .single();
  if (error) throw error;
  const row = data as ActivityRow;
  if (done && row.opportunity_id) {
    const { error: upError } = await db
      .from('crm_opportunities')
      .update({ last_activity_at: new Date().toISOString() })
      .eq('id', row.opportunity_id);
    if (upError) throw upError;
  }
  return row;
}

export interface ListActivitiesOptions {
  opportunityId?: string;
  clientId?: string;
  ownerUserId?: string;
  /** Sólo tareas sin hacer. */
  openTasks?: boolean;
  /** Tareas con fecha hasta este día (inclusive). */
  dueBy?: string;
  limit?: number;
}

export async function listActivities(
  db: SupabaseClient,
  opts: ListActivitiesOptions = {},
): Promise<ActivityRow[]> {
  let q = db.from('crm_activities').select(ACTIVITY_COLUMNS);
  if (opts.opportunityId) q = q.eq('opportunity_id', opts.opportunityId);
  if (opts.clientId) q = q.eq('client_id', opts.clientId);
  if (opts.ownerUserId) q = q.eq('owner_user_id', opts.ownerUserId);
  if (opts.openTasks) q = q.eq('kind', 'task').is('done_at', null);
  if (opts.dueBy) q = q.lte('due_on', opts.dueBy);
  const { data, error } = await q
    .order(opts.openTasks ? 'due_on' : 'created_at', {
      ascending: !!opts.openTasks,
      nullsFirst: false,
    })
    .limit(Math.min(opts.limit ?? 200, 2000));
  if (error) throw error;
  return (data ?? []) as ActivityRow[];
}

// ---------------------------------------------------------------------------
// Encuestas
// ---------------------------------------------------------------------------

export function newSurveyToken(): string {
  return randomBytes(24).toString('base64url');
}

export async function createSurvey(
  db: SupabaseClient,
  input: {
    clientId: string | null;
    clientName: string;
    contactName?: string | null;
    contactEmail?: string | null;
    channel: 'email' | 'link';
    expiresOn?: string | null;
  },
  opts: { userId: string | null },
): Promise<SurveyRow> {
  const { data, error } = await db
    .from('nps_surveys')
    .insert({
      client_id: input.clientId,
      client_name: input.clientName.trim().slice(0, 200),
      contact_name: input.contactName?.trim().slice(0, 200) || null,
      contact_email: input.contactEmail?.trim().slice(0, 320) || null,
      token: newSurveyToken(),
      channel: input.channel,
      status: 'pendiente',
      expires_on: input.expiresOn ?? null,
      created_by: opts.userId,
    })
    .select(SURVEY_COLUMNS)
    .single();
  if (error) throw error;
  return data as SurveyRow;
}

export async function markSurveySent(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db
    .from('nps_surveys')
    .update({ status: 'enviada', sent_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['pendiente', 'enviada']);
  if (error) throw error;
}

export async function getSurvey(db: SupabaseClient, id: string): Promise<SurveyRow | null> {
  const { data, error } = await db
    .from('nps_surveys')
    .select(SURVEY_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as SurveyRow | null) ?? null;
}

export async function listSurveys(
  db: SupabaseClient,
  opts: { clientId?: string; limit?: number } = {},
): Promise<SurveyRow[]> {
  let q = db.from('nps_surveys').select(SURVEY_COLUMNS);
  if (opts.clientId) q = q.eq('client_id', opts.clientId);
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .limit(Math.min(opts.limit ?? 300, 2000));
  if (error) throw error;
  return (data ?? []) as SurveyRow[];
}

export async function listResponses(
  db: SupabaseClient,
  opts: { clientId?: string; surveyId?: string; since?: string; limit?: number } = {},
): Promise<ResponseRow[]> {
  let q = db
    .from('nps_responses')
    .select('id, survey_id, client_id, score, comment, respondent_name, follow_up_id, created_at');
  if (opts.clientId) q = q.eq('client_id', opts.clientId);
  if (opts.surveyId) q = q.eq('survey_id', opts.surveyId);
  if (opts.since) q = q.gte('created_at', opts.since);
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .limit(Math.min(opts.limit ?? 500, 5000));
  if (error) throw error;
  return (data ?? []) as ResponseRow[];
}

/** La primera apertura del enlace deja la hora (no se cuenta más). */
export async function markSurveyOpened(db: SupabaseClient, survey: SurveyRow): Promise<void> {
  if (survey.opened_at) return;
  const { error } = await db
    .from('nps_surveys')
    .update({ opened_at: new Date().toISOString() })
    .eq('id', survey.id)
    .is('opened_at', null);
  if (error) throw error;
}

export interface RecordedResponse {
  response: ResponseRow;
  /** La tarea que dejó un detractor, con a quién le quedó. */
  followUp: { activityId: string; ownerUserId: string | null } | null;
  alreadyAnswered: boolean;
}

/**
 * Guarda la respuesta (una por encuesta: la segunda devuelve la primera). Un
 * detractor (0–6) deja una tarea para el responsable del cliente —o para quien
 * mandó la encuesta, si el cliente no tiene responsable— con la calificación y
 * el comentario, para hoy.
 */
export async function recordSurveyResponse(
  db: SupabaseClient,
  survey: SurveyRow,
  input: { score: number; comment?: string | null; respondentName?: string | null; today: string },
): Promise<RecordedResponse> {
  if (!Number.isInteger(input.score) || input.score < 0 || input.score > 10)
    throw new ValidationError('La calificación va de 0 a 10.');
  if (survey.status === 'anulada') throw new ValidationError('Esta encuesta ya no está abierta.');
  const { data: prior, error: priorError } = await db
    .from('nps_responses')
    .select('id, survey_id, client_id, score, comment, respondent_name, follow_up_id, created_at')
    .eq('survey_id', survey.id)
    .maybeSingle();
  if (priorError) throw priorError;
  if (prior) return { response: prior as ResponseRow, followUp: null, alreadyAnswered: true };

  const comment = input.comment?.trim().slice(0, 2000) || null;
  const { data, error } = await db
    .from('nps_responses')
    .insert({
      survey_id: survey.id,
      client_id: survey.client_id,
      score: input.score,
      comment,
      respondent_name: input.respondentName?.trim().slice(0, 200) || null,
    })
    .select('id, survey_id, client_id, score, comment, respondent_name, follow_up_id, created_at')
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      const again = await db
        .from('nps_responses')
        .select(
          'id, survey_id, client_id, score, comment, respondent_name, follow_up_id, created_at',
        )
        .eq('survey_id', survey.id)
        .single();
      if (again.error) throw again.error;
      return { response: again.data as ResponseRow, followUp: null, alreadyAnswered: true };
    }
    throw error;
  }
  const response = data as ResponseRow;
  const { error: surveyError } = await db
    .from('nps_surveys')
    .update({ status: 'respondida', responded_at: new Date().toISOString() })
    .eq('id', survey.id);
  if (surveyError) throw surveyError;

  // Sin cliente del hub la tarea no tiene a quién atarse (la base pide un
  // cliente o una oportunidad): la respuesta queda y el aviso lo da quien llama.
  if (npsBucket(input.score) !== 'detractor' || !survey.client_id)
    return { response, followUp: null, alreadyAnswered: false };

  const { data: client, error: clientError } = await db
    .from('clients')
    .select('owner_user_id')
    .eq('id', survey.client_id)
    .maybeSingle();
  if (clientError) throw clientError;
  const owner =
    (client as { owner_user_id?: string | null } | null)?.owner_user_id ?? survey.created_by;
  const task = await insertActivity(db, {
    clientId: survey.client_id,
    opportunityId: null,
    kind: 'task',
    title: `Llamar a ${survey.client_name}: calificó ${input.score}/10 en la encuesta`,
    body: comment
      ? `Comentario${input.respondentName ? ` de ${input.respondentName.trim()}` : ''}: «${comment}»`
      : 'No dejó comentario: pregúntale qué podemos mejorar.',
    dueOn: input.today,
    ownerUserId: owner,
    origin: 'nps',
    createdBy: null,
  });
  const { error: linkError } = await db
    .from('nps_responses')
    .update({ follow_up_id: task.id })
    .eq('id', response.id);
  if (linkError) throw linkError;
  return {
    response: { ...response, follow_up_id: task.id },
    followUp: { activityId: task.id, ownerUserId: owner },
    alreadyAnswered: false,
  };
}

// ---------------------------------------------------------------------------
// El riesgo guardado
// ---------------------------------------------------------------------------

export interface StoredRisk {
  client_id: string;
  level: RiskLevel;
  score: number;
  evidence: string[];
  suggested_action: string | null;
  computed_at: string;
  told_level: RiskLevel | null;
  told_at: string | null;
}

export async function listStoredRisk(db: SupabaseClient): Promise<StoredRisk[]> {
  const { data, error } = await db
    .from('crm_client_risk')
    .select('client_id, level, score, evidence, suggested_action, computed_at, told_level, told_at')
    .limit(5000);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    ...(r as unknown as StoredRisk),
    evidence: Array.isArray(r.evidence) ? (r.evidence as string[]) : [],
  }));
}

/** Guarda la lectura de hoy. No toca `told_level`: eso lo marca el piloto. */
export async function saveRisk(
  db: SupabaseClient,
  rows: ReadonlyArray<{
    clientId: string;
    level: RiskLevel;
    score: number;
    evidence: string[];
    action: string | null;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from('crm_client_risk').upsert(
      rows.slice(i, i + 500).map((r) => ({
        client_id: r.clientId,
        level: r.level,
        score: r.score,
        evidence: r.evidence.slice(0, 10),
        suggested_action: r.action?.slice(0, 500) ?? null,
        computed_at: now,
      })),
      { onConflict: 'organization_id,client_id' },
    );
    if (error) throw error;
  }
}

export async function markRiskTold(
  db: SupabaseClient,
  rows: ReadonlyArray<{ clientId: string; level: RiskLevel }>,
): Promise<void> {
  const now = new Date().toISOString();
  for (const r of rows) {
    const { error } = await db
      .from('crm_client_risk')
      .update({ told_level: r.level, told_at: now })
      .eq('client_id', r.clientId);
    if (error) throw error;
  }
}
