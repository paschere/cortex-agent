import type { SupabaseClient } from '@supabase/supabase-js';
import { fingerprint } from '../actions/shape';
import { bogotaDayStart } from '../security/mandate-store';
import { COOLDOWN_DAYS, type PlanHistory } from './plan';
import type { ItemPatch, RunSummary, SavedItem } from './run';
import {
  type AutopilotSettings,
  type AutopilotSettingsPatch,
  type AutopilotSettingsRow,
  applyPatch,
  settingsFromRow,
} from './settings';
import type {
  AutopilotArea,
  AutopilotDecision,
  AutopilotEffect,
  AutopilotItemStatus,
  AutopilotRisk,
  AutopilotRunStatus,
  AutopilotVerification,
  DecidedItem,
  UndoHint,
} from './types';

/**
 * LA TIENDA DEL PILOTO (0176). Las únicas escrituras de `autopilot_settings`,
 * `autopilot_runs` y `autopilot_items` del producto están aquí.
 *
 * Todas reciben el handle de la empresa (getOrgScopedClient): el filtro por
 * organización lo pone el handle, en lecturas y escrituras.
 */

const SETTINGS_COLUMNS =
  'enabled, run_hour, run_days, skip_holidays, quiet_days, area_levels, max_external_messages, max_amount_referenced, currency, max_actions_per_run, actor_user_id, notify_email, enabled_at, updated_at';

export async function readAutopilotSettings(db: SupabaseClient): Promise<AutopilotSettings> {
  const { data, error } = await db
    .from('autopilot_settings')
    .select(SETTINGS_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return settingsFromRow(data as AutopilotSettingsRow | null);
}

export async function saveAutopilotSettings(
  db: SupabaseClient,
  patch: AutopilotSettingsPatch,
  actor: { userId: string; now?: Date },
): Promise<AutopilotSettings> {
  const current = await readAutopilotSettings(db);
  const now = actor.now ?? new Date();
  const row = applyPatch(current, patch, { userId: actor.userId, now });
  const { data, error } = await db
    .from('autopilot_settings')
    .upsert({ ...row, updated_at: now.toISOString() }, { onConflict: 'organization_id' })
    .select(SETTINGS_COLUMNS)
    .single();
  if (error) throw error;
  return settingsFromRow(data as AutopilotSettingsRow);
}

// ---------------------------------------------------------------------------
// Corridas
// ---------------------------------------------------------------------------

const RUN_COLUMNS =
  'id, run_on, status, actor_user_id, done_count, asked_count, told_count, failed_count, skipped_count, summary, source_errors, started_at, finished_at, notified_at';

export interface AutopilotRunRow {
  id: string;
  run_on: string;
  status: AutopilotRunStatus;
  actor_user_id: string | null;
  done_count: number;
  asked_count: number;
  told_count: number;
  failed_count: number;
  skipped_count: number;
  summary: string | null;
  source_errors: Array<{ source: string; message: string }>;
  started_at: string;
  finished_at: string | null;
  notified_at: string | null;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/**
 * Reclama la corrida del día. El índice único (empresa, día) decide: si ya
 * existía, se devuelve con su estado y `fresh: false`.
 */
export async function claimAutopilotRun(
  db: SupabaseClient,
  input: {
    day: string;
    actorUserId: string;
    sourceErrors?: Array<{ source: string; message: string }>;
  },
): Promise<{ runId: string; fresh: boolean; status: AutopilotRunStatus }> {
  const inserted = await db
    .from('autopilot_runs')
    .insert({
      run_on: input.day,
      actor_user_id: input.actorUserId,
      status: 'running',
      source_errors: input.sourceErrors ?? [],
    })
    .select('id, status')
    .single();
  if (!inserted.error) {
    const r = inserted.data as { id: string; status: AutopilotRunStatus };
    return { runId: r.id, fresh: true, status: r.status };
  }
  if (!isUniqueViolation(inserted.error)) throw inserted.error;
  const existing = await db
    .from('autopilot_runs')
    .select('id, status')
    .eq('run_on', input.day)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (!existing.data) throw inserted.error;
  const r = existing.data as { id: string; status: AutopilotRunStatus };
  return { runId: r.id, fresh: false, status: r.status };
}

export async function finishAutopilotRun(
  db: SupabaseClient,
  runId: string,
  summary: RunSummary,
  status: AutopilotRunStatus,
): Promise<void> {
  const { error } = await db
    .from('autopilot_runs')
    .update({
      status,
      done_count: summary.done,
      asked_count: summary.asked,
      told_count: summary.told,
      failed_count: summary.failed,
      skipped_count: summary.skipped,
      summary: summary.message.slice(0, 600),
      finished_at: new Date().toISOString(),
      // En un reintento la corrida no vuelve a planear: no se pisa lo anotado.
      ...(summary.sourceErrors.length ? { source_errors: summary.sourceErrors } : {}),
    })
    .eq('id', runId);
  if (error) throw error;
}

export async function markRunNotified(db: SupabaseClient, runId: string): Promise<void> {
  const { error } = await db
    .from('autopilot_runs')
    .update({ notified_at: new Date().toISOString() })
    .eq('id', runId);
  if (error) throw error;
}

export async function listAutopilotRuns(
  db: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<AutopilotRunRow[]> {
  const { data, error } = await db
    .from('autopilot_runs')
    .select(RUN_COLUMNS)
    .order('run_on', { ascending: false })
    .limit(Math.min(opts.limit ?? 14, 60));
  if (error) throw error;
  return (data ?? []) as AutopilotRunRow[];
}

export async function getAutopilotRun(
  db: SupabaseClient,
  runId: string,
): Promise<AutopilotRunRow | null> {
  const { data, error } = await db
    .from('autopilot_runs')
    .select(RUN_COLUMNS)
    .eq('id', runId)
    .maybeSingle();
  if (error) throw error;
  return (data as AutopilotRunRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// Cosas
// ---------------------------------------------------------------------------

const ITEM_COLUMNS =
  'id, run_id, dedupe_key, area, title, why, risk, effect, decision, decision_reason, authority, mandate_id, tool_id, tool_input, amount, currency, counterparty, href, undo, status, result_summary, verification, verification_detail, error, action_id, decided_by, decided_at, executed_at, created_at, updated_at';

export interface AutopilotItemRow {
  id: string;
  run_id: string;
  dedupe_key: string;
  area: AutopilotArea;
  title: string;
  why: string;
  risk: AutopilotRisk;
  effect: AutopilotEffect | null;
  decision: AutopilotDecision;
  decision_reason: string;
  authority: 'mandate' | 'routine' | null;
  mandate_id: string | null;
  tool_id: string | null;
  tool_input: Record<string, unknown> | null;
  amount: number | string | null;
  currency: string | null;
  counterparty: string | null;
  href: string | null;
  undo: UndoHint | null;
  status: AutopilotItemStatus;
  result_summary: string | null;
  verification: AutopilotVerification;
  verification_detail: string | null;
  error: string | null;
  action_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  executed_at: string | null;
  created_at: string;
  updated_at: string;
}

function clip(text: string | null | undefined, max: number): string | null {
  if (text == null) return null;
  const t = String(text);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function toRow(runId: string, i: DecidedItem) {
  return {
    run_id: runId,
    dedupe_key: i.dedupeKey.slice(0, 300),
    area: i.area,
    title: clip(i.title, 300),
    why: clip(i.why, 1200),
    risk: i.risk,
    effect: i.effect,
    decision: i.decision,
    decision_reason: clip(i.decisionReason, 600) ?? '',
    authority: i.authority,
    mandate_id: i.mandateId,
    tool_id: i.proposedAction?.toolId ?? null,
    tool_input: i.proposedAction?.input ?? null,
    amount: i.amount ?? null,
    currency: i.amount != null ? (i.currency ?? 'COP').toUpperCase().slice(0, 3) : null,
    counterparty: clip(i.counterparty ?? null, 200),
    href: i.href?.startsWith('/') ? i.href.slice(0, 400) : null,
    undo: i.undo ?? null,
    status: 'planned' as const,
  };
}

/** Guarda el plan de la corrida (idempotente por clave) y devuelve todas sus filas. */
export async function saveAutopilotItems(
  db: SupabaseClient,
  runId: string,
  items: DecidedItem[],
): Promise<SavedItem[]> {
  if (items.length) {
    const { error } = await db.from('autopilot_items').upsert(
      items.map((i) => toRow(runId, i)),
      { onConflict: 'run_id,dedupe_key', ignoreDuplicates: true },
    );
    if (error) throw error;
  }
  const { data, error } = await db
    .from('autopilot_items')
    .select('id, dedupe_key, status')
    .eq('run_id', runId)
    .limit(500);
  if (error) throw error;
  return (
    (data ?? []) as Array<{ id: string; dedupe_key: string; status: AutopilotItemStatus }>
  ).map((r) => ({ id: r.id, dedupeKey: r.dedupe_key, status: r.status }));
}

/** De una fila guardada al ítem decidido (para retomar una corrida). */
export function itemFromRow(r: AutopilotItemRow): DecidedItem {
  return {
    area: r.area,
    title: r.title,
    why: r.why,
    proposedAction: r.tool_id ? { toolId: r.tool_id, input: r.tool_input ?? {} } : null,
    effect: r.effect,
    risk: r.risk,
    amount: r.amount == null ? null : Number(r.amount),
    currency: r.currency,
    counterparty: r.counterparty,
    dedupeKey: r.dedupe_key,
    href: r.href,
    undo: r.undo,
    decision: r.decision,
    decisionReason: r.decision_reason,
    authority: r.authority,
    mandateId: r.mandate_id,
    mandateLabel: null,
  };
}

export async function listAutopilotItems(
  db: SupabaseClient,
  runId: string,
): Promise<AutopilotItemRow[]> {
  const { data, error } = await db
    .from('autopilot_items')
    .select(ITEM_COLUMNS)
    .eq('run_id', runId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as AutopilotItemRow[];
}

export async function getAutopilotItem(
  db: SupabaseClient,
  itemId: string,
): Promise<AutopilotItemRow | null> {
  const { data, error } = await db
    .from('autopilot_items')
    .select(ITEM_COLUMNS)
    .eq('id', itemId)
    .maybeSingle();
  if (error) throw error;
  return (data as AutopilotItemRow | null) ?? null;
}

export async function updateAutopilotItem(
  db: SupabaseClient,
  itemId: string,
  patch: ItemPatch,
): Promise<void> {
  const row: Record<string, unknown> = {
    status: patch.status,
    updated_at: new Date().toISOString(),
  };
  if (patch.resultSummary !== undefined) row.result_summary = clip(patch.resultSummary, 1000);
  if (patch.verification !== undefined) row.verification = patch.verification;
  if (patch.verificationDetail !== undefined)
    row.verification_detail = clip(patch.verificationDetail, 500);
  if (patch.error !== undefined) row.error = clip(patch.error, 1000);
  if (patch.actionId !== undefined) row.action_id = patch.actionId;
  if (patch.executedAt !== undefined) row.executed_at = patch.executedAt;
  if (patch.decisionReason !== undefined) row.decision_reason = clip(patch.decisionReason, 600);
  const { error } = await db.from('autopilot_items').update(row).eq('id', itemId);
  if (error) throw error;
}

/**
 * Lo que pasó otros días con las mismas cosas: hecho o descartado en los
 * últimos `COOLDOWN_DAYS` (no se vuelve a plantear), y lo que sigue esperando
 * decisión (no se vuelve a pedir).
 */
export async function loadPlanHistory(
  db: SupabaseClient,
  opts: { now?: Date },
): Promise<PlanHistory> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - COOLDOWN_DAYS * 86_400_000).toISOString();
  // Lo de hoy no es historia: es esta misma corrida (un reintento la retoma).
  const todayStart = bogotaDayStart(now);
  const { data, error } = await db
    .from('autopilot_items')
    .select('dedupe_key, status, created_at')
    .gte('created_at', since)
    .lt('created_at', todayStart)
    .in('status', ['done', 'dismissed', 'asked'])
    .limit(5000);
  if (error) throw error;
  const settled = new Set<string>();
  const openAsks = new Set<string>();
  for (const r of (data ?? []) as Array<{ dedupe_key: string; status: AutopilotItemStatus }>) {
    if (r.status === 'asked') openAsks.add(r.dedupe_key);
    else settled.add(r.dedupe_key);
  }
  return { settled, openAsks };
}

/** Lo que espera decisión, de cualquier día vigente, para la pantalla y el estado. */
export async function listOpenAsks(
  db: SupabaseClient,
  opts: { now?: Date; limit?: number } = {},
): Promise<AutopilotItemRow[]> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - COOLDOWN_DAYS * 86_400_000).toISOString();
  const { data, error } = await db
    .from('autopilot_items')
    .select(ITEM_COLUMNS)
    .eq('status', 'asked')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(Math.min(opts.limit ?? 50, 200));
  if (error) throw error;
  return (data ?? []) as AutopilotItemRow[];
}

// ---------------------------------------------------------------------------
// Decidir una cosa que esperaba (desde /piloto)
// ---------------------------------------------------------------------------

/** La huella de lo que se ejecutará: la misma de `actions` (actions/shape.ts). */
export function itemFingerprint(r: Pick<AutopilotItemRow, 'tool_id' | 'tool_input'>): string {
  return fingerprint({ toolId: r.tool_id, input: r.tool_input });
}

export type ClaimItemOutcome =
  | { status: 'claimed'; item: AutopilotItemRow }
  | { status: 'unknown' }
  | { status: 'already_decided'; current: AutopilotItemStatus }
  | { status: 'content_changed' };

/**
 * Reclama una cosa que esperaba decisión. UN update condicional: sólo si sigue
 * en `asked` y la huella que vio la persona es la que hay. Dos clics a la vez:
 * uno gana. Aprobar la deja en `planned` (en vuelo) hasta que se ejecute;
 * descartar la deja en `dismissed`.
 */
export async function claimAutopilotItem(
  db: SupabaseClient,
  input: {
    itemId: string;
    userId: string;
    decision: 'approve' | 'dismiss';
    contentHash: string;
    now?: Date;
  },
): Promise<ClaimItemOutcome> {
  const current = await getAutopilotItem(db, input.itemId);
  if (!current) return { status: 'unknown' };
  if (current.status !== 'asked') return { status: 'already_decided', current: current.status };
  if (input.decision === 'approve' && itemFingerprint(current) !== input.contentHash)
    return { status: 'content_changed' };
  const at = (input.now ?? new Date()).toISOString();
  const { data, error } = await db
    .from('autopilot_items')
    .update({
      status: input.decision === 'approve' ? 'planned' : 'dismissed',
      decided_by: input.userId,
      decided_at: at,
      updated_at: at,
    })
    .eq('id', input.itemId)
    .eq('status', 'asked')
    .select(ITEM_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const again = await getAutopilotItem(db, input.itemId);
    return { status: 'already_decided', current: again?.status ?? 'asked' };
  }
  return { status: 'claimed', item: data as AutopilotItemRow };
}

/** Las cifras de «hoy» para Inicio: lo hecho hoy y lo que espera decisión. */
export async function autopilotToday(
  db: SupabaseClient,
  opts: { day: string; now?: Date },
): Promise<{
  settings: AutopilotSettings;
  run: AutopilotRunRow | null;
  waiting: number;
}> {
  const settings = await readAutopilotSettings(db);
  const [runs, asks] = await Promise.all([
    db.from('autopilot_runs').select(RUN_COLUMNS).eq('run_on', opts.day).maybeSingle(),
    listOpenAsks(db, { now: opts.now, limit: 200 }),
  ]);
  if (runs.error) throw runs.error;
  return { settings, run: (runs.data as AutopilotRunRow | null) ?? null, waiting: asks.length };
}
