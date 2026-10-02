import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../../commitments/shape';
import { listCommitments } from '../../commitments/store';
import { FOLLOW_UP_STATES } from '../../management/follow-up';
import { getWorkItemsByIds } from '../../work/store';
import type { WorkItem } from '../../work/types';
import { daysOverdue, dueDayOf } from '../digest';
import {
  EVALUATION_HORIZON_DAYS,
  type FollowThroughEvidence,
  type Verdict,
  isSettledRecommendation,
  judgeRecommendation,
} from './judge';
import type { KindHistory } from './rank';
import {
  type Baseline,
  type FollowEvidence,
  type OutcomeEvidence,
  RECOMMENDATION_KIND_EFFECT,
  type RecommendationDraft,
  type RecommendationKind,
  type RecommendationOutcome,
  type RecommendationRecord,
  type RecommendationSource,
  type RecommendationStatus,
  type Severity,
  type SubjectKind,
  type SuggestedAction,
  recommendationDedupeKey,
  subjectKeyOf,
} from './shape';

/**
 * LA ÚNICA PUERTA DE `recommendations` (0177), Y LA LECTURA DE LOS HECHOS.
 *
 * `db` es siempre un handle con alcance de empresa: nada de aquí filtra por
 * `organization_id` a mano y toda escritura la estampa el handle.
 *
 * Escribir es idempotente: la identidad es (empresa, tipo, sujeto, semana ISO)
 * con índice único, y se inserta con `ignoreDuplicates`. Decir lo mismo dos
 * veces en la semana deja UNA fila — la primera, con sus cifras de entonces.
 *
 * Leer los hechos falla por partes: cada lectura en su `try`, y la que falla
 * deja su campo en `null`. El juez trata un `null` como «no se puede ver hoy»
 * y no como «no pasó nada»: una lectura caída nunca declara ignorado un
 * consejo.
 */

const COLUMNS =
  'id, source, kind, subject_kind, subject_key, subject_label, text, headline, suggested_action, expected_effect, severity, baseline, created_for, status, followed_at, follow_evidence, outcome, outcome_evidence, evaluated_at, created_at';

type Row = Record<string, unknown>;

const DAY_MS = 86_400_000;

function obj<T>(v: unknown): T {
  return (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as T;
}

export function adaptRecommendationRow(row: Row): RecommendationRecord {
  const kind = String(row.kind) as RecommendationKind;
  return {
    id: String(row.id),
    source: String(row.source) as RecommendationSource,
    kind,
    subjectKind: String(row.subject_kind) as SubjectKind,
    subjectKey: String(row.subject_key),
    subjectLabel: typeof row.subject_label === 'string' ? row.subject_label : null,
    text: String(row.text),
    headline: String(row.headline),
    suggestedAction: (row.suggested_action as SuggestedAction | null) ?? null,
    expectedEffect:
      (row.expected_effect as RecommendationRecord['expectedEffect']) ??
      RECOMMENDATION_KIND_EFFECT[kind] ??
      'setup',
    severity: (row.severity as Severity) ?? 'info',
    baseline: obj<Baseline>(row.baseline),
    createdFor: typeof row.created_for === 'string' ? row.created_for : null,
    status: (row.status as RecommendationStatus) ?? 'open',
    followedAt: typeof row.followed_at === 'string' ? row.followed_at : null,
    followEvidence: obj<FollowEvidence>(row.follow_evidence),
    outcome: (row.outcome as RecommendationOutcome | null) ?? null,
    outcomeEvidence: obj<OutcomeEvidence>(row.outcome_evidence),
    evaluatedAt: typeof row.evaluated_at === 'string' ? row.evaluated_at : null,
    createdAt: String(row.created_at),
  };
}

/** El lunes de la semana ISO de un día. */
export function weekStartOf(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const dow = d.getUTCDay() || 7;
  return new Date(d.getTime() - (dow - 1) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Guarda lo recomendado. Devuelve cuántas filas NUEVAS quedaron (las repetidas
 * de la semana no cuentan). Nunca lanza por una repetida.
 */
export async function recordRecommendations(
  db: SupabaseClient,
  drafts: readonly RecommendationDraft[],
  opts: { now?: Date } = {},
): Promise<number> {
  if (!drafts.length) return 0;
  const week = weekStartOf(bogotaToday(opts.now ?? new Date()));
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const d of drafts) {
    const subjectKey = d.subjectKey || subjectKeyOf(d.subjectLabel ?? '') || 'empresa';
    const dedupe = recommendationDedupeKey({ kind: d.kind, subjectKey }, week);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    rows.push({
      source: d.source,
      kind: d.kind,
      subject_kind: d.subjectKind,
      subject_key: subjectKey.slice(0, 200),
      subject_label: d.subjectLabel ? d.subjectLabel.slice(0, 200) : null,
      text: d.text.trim().slice(0, 600),
      headline: d.headline.trim().slice(0, 200),
      suggested_action: d.suggestedAction ?? null,
      expected_effect: RECOMMENDATION_KIND_EFFECT[d.kind],
      severity: d.severity,
      baseline: d.baseline ?? {},
      created_for: d.createdFor ?? null,
      dedupe_key: dedupe,
      ...(opts.now ? { created_at: opts.now.toISOString() } : {}),
    });
  }
  const { data, error } = await db
    .from('recommendations')
    .upsert(rows, { onConflict: 'organization_id,dedupe_key', ignoreDuplicates: true })
    .select('id');
  if (error) throw error;
  return (data ?? []).length;
}

export interface ListRecommendationsFilter {
  /** Desde cuándo (ISO). */
  since?: string;
  /** Hasta cuándo (ISO, excluido). */
  until?: string;
  statuses?: readonly RecommendationStatus[];
  kinds?: readonly RecommendationKind[];
  limit?: number;
}

export async function listRecommendations(
  db: SupabaseClient,
  filter: ListRecommendationsFilter = {},
): Promise<RecommendationRecord[]> {
  let q = db
    .from('recommendations')
    .select(COLUMNS)
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(filter.limit ?? 200, 2000)));
  if (filter.since) q = q.gte('created_at', filter.since);
  if (filter.until) q = q.lt('created_at', filter.until);
  if (filter.statuses?.length) q = q.in('status', [...filter.statuses]);
  if (filter.kinds?.length) q = q.in('kind', [...filter.kinds]);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as Row[]).map(adaptRecommendationRow);
}

/** La historia que alimenta la tasa de acierto: los últimos seis meses. */
export async function readKindHistory(
  db: SupabaseClient,
  now = new Date(),
): Promise<KindHistory[]> {
  const since = new Date(now.getTime() - 180 * DAY_MS).toISOString();
  const { data, error } = await db
    .from('recommendations')
    .select('kind, status, outcome')
    .gte('created_at', since)
    .in('status', ['followed', 'not_followed'])
    .limit(5000);
  if (error) throw error;
  return ((data ?? []) as Row[]).map((r) => ({
    kind: String(r.kind) as RecommendationKind,
    status: String(r.status) as RecommendationStatus,
    outcome: (r.outcome as RecommendationOutcome | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Los hechos
// ---------------------------------------------------------------------------

type Rows<T> = { data: T[] | null; error: { message: string } | null };

async function rows<T>(query: PromiseLike<Rows<T>>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function attempt<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** Abiertos y vencidos de hoy por persona (y por persona y tipo), y sin responsable. */
export function workLoad(
  items: readonly WorkItem[],
  today: string,
): {
  personLoad: Record<string, { open: number; overdue: number }>;
  unassigned: Record<string, number>;
} {
  const personLoad: Record<string, { open: number; overdue: number }> = {};
  const unassigned: Record<string, number> = {};
  const bump = (key: string, overdue: boolean) => {
    const cur = personLoad[key] ?? { open: 0, overdue: 0 };
    cur.open += 1;
    if (overdue) cur.overdue += 1;
    personLoad[key] = cur;
  };
  for (const i of items) {
    if (i.status !== 'open') continue;
    const due = dueDayOf(i.dueAt);
    const overdue = due !== null && daysOverdue(due, today) >= 1;
    if (!i.assigneeId) {
      unassigned['*'] = (unassigned['*'] ?? 0) + 1;
      unassigned[i.workType] = (unassigned[i.workType] ?? 0) + 1;
      continue;
    }
    bump(i.assigneeId, overdue);
    bump(`${i.assigneeId}|${i.workType}`, overdue);
  }
  return { personLoad, unassigned };
}

/** Compromisos confirmados que ya se pasaron de fecha, hoy. */
export async function countOverdueCommitments(db: SupabaseClient, today: string): Promise<number> {
  const list = await listCommitments(db, {
    states: ['overdue'],
    dueBefore: today,
    today,
    limit: 2000,
  });
  return list.length;
}

/** Asuntos de Gerencia cuyo siguiente paso es de alguien (por organizar, en gestión, bloqueados). */
export async function countOpenCases(db: SupabaseClient): Promise<number> {
  const { count, error } = await db
    .from('management_cases')
    .select('id', { count: 'exact', head: true })
    .in('data->>state', [...FOLLOW_UP_STATES]);
  if (error) throw error;
  return count ?? 0;
}

/** Lo que espera aprobación de cada persona hoy: llamadas paradas y borradores vivos. */
export async function pendingApprovalsByUser(
  db: SupabaseClient,
  now: Date,
  userIds?: readonly string[],
): Promise<Record<string, number>> {
  const nowIso = now.toISOString();
  let parked = db
    .from('mcp_pending_actions')
    .select('user_id')
    .is('decision', null)
    .gt('expires_at', nowIso)
    .limit(5000);
  let drafts = db
    .from('actions')
    .select('user_id')
    .eq('state', 'proposed')
    .gt('expires_at', nowIso)
    .limit(5000);
  if (userIds?.length) {
    parked = parked.in('user_id', [...userIds]);
    drafts = drafts.in('user_id', [...userIds]);
  }
  const [a, b] = await Promise.all([
    rows<{ user_id: string }>(parked),
    rows<{ user_id: string }>(drafts),
  ]);
  const out: Record<string, number> = {};
  for (const r of [...a, ...b]) out[r.user_id] = (out[r.user_id] ?? 0) + 1;
  return out;
}

export interface EvidenceOptions {
  now: Date;
  /** Desde cuándo mirar hechos (la recomendación más vieja que se evalúa). */
  since: Date;
  /** Lo abierto del registro de trabajo que se mide (de `loadTeamReport`). */
  workItems?: readonly WorkItem[] | null;
  /** Las clases de alerta que da hoy la proyección de caja, si ya se leyó. */
  cashAlertKinds?: string[] | null;
  /** Los ítems y asuntos que alguna recomendación nombra. */
  itemIds?: readonly string[];
  caseIds?: readonly string[];
  routineKeys?: readonly string[];
}

/** Los hechos de la empresa para juzgar sus recomendaciones. */
export async function gatherFollowThroughEvidence(
  db: SupabaseClient,
  opts: EvidenceOptions,
): Promise<FollowThroughEvidence> {
  const sinceIso = opts.since.toISOString();
  const sinceDay = bogotaToday(opts.since);
  const today = bogotaToday(opts.now);

  const [
    collections,
    inflows,
    reassignments,
    decisions,
    pending,
    routines,
    routineEdits,
    overdue,
    openCases,
    cases,
    items,
  ] = await Promise.all([
    attempt(async () => {
      const list = await rows<{
        id: string;
        state: string;
        created_at: string;
        executed_at: string | null;
        execution_status: string | null;
        subject: string | null;
        recipient: string | null;
        rationale: string | null;
      }>(
        db
          .from('actions')
          .select(
            'id, state, created_at, executed_at, execution_status, subject, recipient, rationale',
          )
          .eq('kind', 'collect_payment')
          .gte('created_at', new Date(opts.since.getTime() - DAY_MS).toISOString())
          .limit(3000),
      );
      return list.map((r) => ({
        id: r.id,
        state: r.state,
        createdAt: r.created_at,
        executedAt: r.executed_at,
        sentOk: r.execution_status === 'ok',
        haystack: subjectKeyOf(`${r.subject ?? ''} ${r.recipient ?? ''} ${r.rationale ?? ''}`),
      }));
    }),
    attempt(async () => {
      const list = await rows<{
        date: string;
        settled_at: string | null;
        counterparty_name: string | null;
        amount: number | string;
        currency: string;
      }>(
        db
          .from('ledger_movements')
          .select('date, settled_at, counterparty_name, amount, currency')
          .eq('direction', 'in')
          .eq('status', 'settled')
          .neq('kind', 'transfer')
          .is('duplicate_of', null)
          .is('excluded_reason', null)
          .gte('date', sinceDay)
          .limit(5000),
      );
      return list.map((r) => ({
        on: (r.settled_at ?? r.date).slice(0, 10),
        counterpartyKey: subjectKeyOf(r.counterparty_name ?? ''),
        amount: Number(r.amount) || 0,
        currency: r.currency,
      }));
    }),
    attempt(async () =>
      (
        await rows<{ created_at: string }>(
          db
            .from('audit_events')
            .select('created_at')
            .eq('tool_id', 'work.assign')
            .eq('status', 'ok')
            .gte('created_at', sinceIso)
            .limit(2000),
        )
      ).map((r) => r.created_at),
    ),
    attempt(async () => {
      const [a, b] = await Promise.all([
        rows<{ decided_at: string | null; user_id: string }>(
          db
            .from('actions')
            .select('decided_at, user_id')
            .neq('state', 'proposed')
            .gte('decided_at', sinceIso)
            .limit(3000),
        ),
        rows<{ decided_at: string | null; user_id: string }>(
          db
            .from('mcp_pending_actions')
            .select('decided_at, user_id')
            .not('decision', 'is', null)
            .gte('decided_at', sinceIso)
            .limit(3000),
        ),
      ]);
      return [...a, ...b]
        .filter((r): r is { decided_at: string; user_id: string } => Boolean(r.decided_at))
        .map((r) => ({ at: r.decided_at, userId: r.user_id }));
    }),
    attempt(() => pendingApprovalsByUser(db, opts.now)),
    attempt(async () => {
      if (!opts.routineKeys?.length) return {};
      const jobs = await rows<{ id: string; name: string }>(
        db.from('scheduled_jobs').select('id, name').limit(1000),
      );
      const wanted = new Set(opts.routineKeys);
      const byId = new Map(
        jobs.map((j) => [j.id, subjectKeyOf(j.name)] as const).filter(([, k]) => wanted.has(k)),
      );
      const out: FollowThroughEvidence['routines'] = {};
      for (const key of byId.values()) out[key] = { errors: [], runs: [] };
      if (!byId.size) return out;
      const runs = await rows<{ job_id: string; status: string; started_at: string }>(
        db
          .from('scheduled_job_runs')
          .select('job_id, status, started_at')
          .in('job_id', [...byId.keys()])
          .gte('started_at', sinceIso)
          .limit(5000),
      );
      for (const r of runs) {
        const key = byId.get(r.job_id);
        const slot = key ? out[key] : undefined;
        if (!slot || r.status === 'running') continue;
        slot.runs.push(r.started_at);
        if (r.status === 'error') slot.errors.push(r.started_at);
      }
      return out;
    }),
    attempt(async () =>
      (
        await rows<{ created_at: string }>(
          db
            .from('audit_events')
            .select('created_at')
            .eq('tool_id', 'schedule.update')
            .eq('status', 'ok')
            .gte('created_at', sinceIso)
            .limit(2000),
        )
      ).map((r) => r.created_at),
    ),
    attempt(() => countOverdueCommitments(db, today)),
    attempt(() => countOpenCases(db)),
    attempt(async () => {
      if (!opts.caseIds?.length) return {};
      const list = await rows<{
        id: string;
        revision: number;
        data: { state?: string };
        updated_at: string;
      }>(
        db
          .from('management_cases')
          .select('id, revision, data, updated_at')
          .in('id', [...opts.caseIds]),
      );
      return Object.fromEntries(
        list.map((c) => [
          c.id,
          { revision: c.revision, state: String(c.data?.state ?? ''), updatedAt: c.updated_at },
        ]),
      );
    }),
    attempt(async () => {
      if (!opts.itemIds?.length) return {};
      const list = await getWorkItemsByIds(db, opts.itemIds);
      return Object.fromEntries(
        list.map((i) => [
          i.id,
          { status: i.status, doneAt: i.doneAt ?? null, lastActivityAt: i.lastActivityAt ?? null },
        ]),
      );
    }),
  ]);

  const load = opts.workItems ? workLoad(opts.workItems, today) : null;
  return {
    now: opts.now.toISOString(),
    collections,
    inflows,
    reassignments,
    personLoad: load?.personLoad ?? null,
    unassigned: load?.unassigned ?? null,
    items,
    decisions,
    pendingApprovals: pending,
    routines,
    routineEdits,
    overdueCommitments: overdue,
    openCases,
    cases,
    cashAlertKinds: opts.cashAlertKinds ?? null,
  };
}

function changed(a: RecommendationRecord, v: Verdict): boolean {
  return (
    a.status !== v.status ||
    a.outcome !== v.outcome ||
    a.followedAt !== v.followedAt ||
    JSON.stringify(a.followEvidence) !== JSON.stringify(v.followEvidence) ||
    JSON.stringify(a.outcomeEvidence) !== JSON.stringify(v.outcomeEvidence)
  );
}

export interface EvaluateResult {
  considered: number;
  updated: number;
  records: RecommendationRecord[];
}

/**
 * Juzga de nuevo lo recomendado en los últimos 40 días y guarda lo que cambió.
 * Devuelve las filas ya con su veredicto de hoy (también las que no cambiaron),
 * que es lo que la revisión semanal cuenta.
 */
export async function evaluateRecommendations(
  db: SupabaseClient,
  opts: {
    now?: Date;
    workItems?: readonly WorkItem[] | null;
    cashAlertKinds?: string[] | null;
  } = {},
): Promise<EvaluateResult> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - EVALUATION_HORIZON_DAYS * DAY_MS);
  const all = await listRecommendations(db, { since: since.toISOString(), limit: 1000 });
  const live = all.filter((r) => !isSettledRecommendation(r, now));
  if (!live.length) return { considered: 0, updated: 0, records: all };

  const oldest = live.reduce((m, r) => Math.min(m, Date.parse(r.createdAt)), now.getTime());
  const ev = await gatherFollowThroughEvidence(db, {
    now,
    since: new Date(Number.isFinite(oldest) ? oldest : since.getTime()),
    workItems: opts.workItems ?? null,
    cashAlertKinds: opts.cashAlertKinds ?? null,
    itemIds: live.filter((r) => r.kind === 'revive_stale').map((r) => r.subjectKey),
    caseIds: live.filter((r) => r.kind === 'management_case').map((r) => r.subjectKey),
    routineKeys: live.filter((r) => r.kind === 'fix_routine').map((r) => r.subjectKey),
  });

  let updated = 0;
  const byId = new Map(all.map((r) => [r.id, r]));
  for (const rec of live) {
    // Sin la carga del equipo (corrida sin registro de trabajo) no se juzga lo
    // del equipo: quedaría como «no seguida» por no haber mirado.
    if (
      !ev.personLoad &&
      ['rebalance_person', 'clear_overdue_person', 'assign_unassigned'].includes(rec.kind)
    )
      continue;
    const verdict = judgeRecommendation(rec, ev);
    if (!changed(rec, verdict)) continue;
    const { error } = await db
      .from('recommendations')
      .update({
        status: verdict.status,
        followed_at: verdict.followedAt,
        follow_evidence: verdict.followEvidence,
        outcome: verdict.outcome,
        outcome_evidence: verdict.outcomeEvidence,
        evaluated_at: now.toISOString(),
      })
      .eq('id', rec.id);
    if (error) throw error;
    updated += 1;
    byId.set(rec.id, { ...rec, ...verdict, evaluatedAt: now.toISOString() });
  }
  return { considered: live.length, updated, records: [...byId.values()] };
}
