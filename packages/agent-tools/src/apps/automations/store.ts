import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getTrackerBySlug } from '../../trackers/store';
import { isReadOnlySource } from '../../views/spec';
import { listRoles, listScreens } from '../store';
import { forgetAutomationWatch } from './emit';
import { isChanged } from './engine';
import {
  type AutomationAction,
  type AutomationCondition,
  type AutomationInput,
  type AutomationTrigger,
  automationActionSchema,
  automationConditionSchema,
  automationInputSchema,
  automationTriggerSchema,
  structuralProblems,
  triggerTracker,
} from './spec';

/**
 * Las automatizaciones de una app: leer, validar y guardar (migración 0210).
 *
 * `db` es siempre un handle con alcance de espacio: una regla de otra empresa
 * simplemente no existe (NotFound). Una regla se valida contra la app y las
 * tablas REALES antes de guardarse: campos que existen, pantallas de ESTA app,
 * roles de ESTA app. Así una regla guardada no puede nombrar una tabla ni un
 * rol que no son de su app, y el motor no tiene que defenderse de eso al correr.
 */

export interface AutomationRow {
  id: string;
  app_id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  tracker_id: string | null;
  trigger_kind: string;
  schedule_last_slot: string | null;
  last_run_at: string | null;
  last_status: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const AUTOMATION_COLUMNS =
  'id, app_id, name, enabled, trigger, conditions, actions, tracker_id, trigger_kind, schedule_last_slot, last_run_at, last_status, created_by, created_at, updated_at';

export const MAX_AUTOMATIONS_PER_APP = 30;

export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'waiting_person'
  | 'unresolved';

export interface AutomationRunRow {
  id: string;
  app_id: string;
  automation_id: string;
  trigger_ref: string;
  status: RunStatus;
  error: string | null;
  attempts: number;
  next_attempt_at: string | null;
  result: Array<{ index: number; type: string; ok: boolean; detail: string }>;
  ask_cortex_calls: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export const AUTOMATION_RUN_COLUMNS =
  'id, app_id, automation_id, trigger_ref, status, error, attempts, next_attempt_at, result, ask_cortex_calls, started_at, finished_at, created_at';

export function adaptAutomation(row: Record<string, unknown>): AutomationRow {
  const trigger = automationTriggerSchema.safeParse(row.trigger);
  const conditions = Array.isArray(row.conditions)
    ? row.conditions.flatMap((c) => {
        const p = automationConditionSchema.safeParse(c);
        return p.success ? [p.data] : [];
      })
    : [];
  const actions = Array.isArray(row.actions)
    ? row.actions.flatMap((a) => {
        const p = automationActionSchema.safeParse(a);
        return p.success ? [p.data] : [];
      })
    : [];
  return {
    ...(row as unknown as AutomationRow),
    // Una regla guardada que dejó de validar (cambió la gramática) se lee sin
    // disparador: el motor la ignora y el editor la muestra rota.
    trigger: (trigger.success
      ? trigger.data
      : { type: 'button', screen: 'inicio', id: 'roto', label: 'Regla rota' }) as AutomationTrigger,
    conditions,
    actions,
  };
}

export function adaptAutomationRun(row: Record<string, unknown>): AutomationRunRow {
  return {
    ...(row as unknown as AutomationRunRow),
    result: Array.isArray(row.result) ? (row.result as AutomationRunRow['result']) : [],
    attempts: Number(row.attempts ?? 0),
    ask_cortex_calls: Number(row.ask_cortex_calls ?? 0),
  };
}

export async function listAutomations(db: SupabaseClient, appId: string): Promise<AutomationRow[]> {
  const { data, error } = await db
    .from('custom_app_automations')
    .select(AUTOMATION_COLUMNS)
    .eq('app_id', appId)
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) throw error;
  return (data ?? []).map((r) => adaptAutomation(r as Record<string, unknown>));
}

export async function getAutomation(
  db: SupabaseClient,
  appId: string,
  id: string,
): Promise<AutomationRow | null> {
  const { data, error } = await db
    .from('custom_app_automations')
    .select(AUTOMATION_COLUMNS)
    .eq('app_id', appId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? adaptAutomation(data as Record<string, unknown>) : null;
}

export async function mustGetAutomation(
  db: SupabaseClient,
  appId: string,
  id: string,
): Promise<AutomationRow> {
  const a = await getAutomation(db, appId, id);
  if (!a) throw new NotFoundError('Esa automatización no existe en esta app.');
  return a;
}

/** Las últimas corridas de una regla (historial con errores). */
export async function listAutomationRuns(
  db: SupabaseClient,
  automationId: string,
  limit = 20,
): Promise<AutomationRunRow[]> {
  const { data, error } = await db
    .from('custom_app_automation_runs')
    .select(AUTOMATION_RUN_COLUMNS)
    .eq('automation_id', automationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => adaptAutomationRun(r as Record<string, unknown>));
}

/** La última corrida de cada regla de la app, de una sola consulta. */
export async function lastRuns(
  db: SupabaseClient,
  appId: string,
): Promise<Map<string, AutomationRunRow>> {
  const { data, error } = await db
    .from('custom_app_automation_runs')
    .select(AUTOMATION_RUN_COLUMNS)
    .eq('app_id', appId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  const out = new Map<string, AutomationRunRow>();
  for (const r of data ?? []) {
    const run = adaptAutomationRun(r as Record<string, unknown>);
    if (!out.has(run.automation_id)) out.set(run.automation_id, run);
  }
  return out;
}

export interface ValidatedAutomation {
  input: AutomationInput;
  trackerId: string | null;
}

/**
 * Valida una regla contra la app y las tablas reales. Lanza `ValidationError`
 * con TODOS los problemas juntos, en español, para que quien la escribe (la
 * persona o el chat) los arregle de una vez.
 */
export async function validateAutomation(
  db: SupabaseClient,
  appId: string,
  raw: unknown,
): Promise<ValidatedAutomation> {
  const parsed = automationInputSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues
      .slice(0, 4)
      .map((i) => `${i.path.join('.') || 'regla'}: ${i.message}`)
      .join('; ');
    throw new ValidationError(`La automatización no es válida (${first}).`);
  }
  const input = parsed.data;
  const problems = structuralProblems(input);

  const [screens, roles] = await Promise.all([listScreens(db, appId), listRoles(db, appId)]);
  const screenSlugs = new Set(screens.map((s) => s.slug));
  const roleKeys = new Set(roles.map((r) => r.key));

  const slug = triggerTracker(input.trigger);
  let trackerId: string | null = null;
  let triggerFields = new Set<string>();
  if (slug) {
    if (isReadOnlySource(slug))
      problems.push(
        'Una fuente de la plataforma o del Feed es de sólo lectura: no dispara reglas.',
      );
    const tracker = isReadOnlySource(slug) ? null : await getTrackerBySlug(db, slug);
    if (!tracker && !isReadOnlySource(slug))
      problems.push(`La tabla «${slug}» no existe (mira trackers.list).`);
    if (tracker) {
      trackerId = tracker.id;
      triggerFields = new Set([
        ...tracker.fields.map((f) => f.key),
        'label',
        'created_at',
        'updated_at',
      ]);
    }
  }
  const t = input.trigger;
  if (t.type === 'form_submitted' && t.screen && !screenSlugs.has(t.screen))
    problems.push(`La pantalla «${t.screen}» no es de esta app.`);
  if (t.type === 'button' && !screenSlugs.has(t.screen))
    problems.push(`La pantalla «${t.screen}» no es de esta app.`);
  if (t.type === 'row_updated' && t.field && triggerFields.size && !triggerFields.has(t.field))
    problems.push(`«${t.field}» no es un campo de «${t.tracker}».`);

  if (triggerFields.size)
    for (const c of input.conditions) {
      const f = isChanged(c) ? c.field : c.field;
      if (!triggerFields.has(f))
        problems.push(`La condición nombra «${f}», que no es un campo de «${slug}».`);
    }

  for (const a of input.actions) {
    if (a.type === 'set_field' && triggerFields.size && !triggerFields.has(a.field))
      problems.push(`«Cambiar un campo» nombra «${a.field}», que no es un campo de «${slug}».`);
    if (a.type === 'create_row') {
      if (isReadOnlySource(a.tracker))
        problems.push('No se crean filas en una fuente de sólo lectura.');
      else {
        const target = await getTrackerBySlug(db, a.tracker);
        if (!target) problems.push(`La tabla «${a.tracker}» donde crear la fila no existe.`);
        else {
          const keys = new Set(target.fields.map((f) => f.key));
          for (const k of Object.keys(a.values))
            if (!keys.has(k)) problems.push(`«${k}» no es un campo de «${a.tracker}».`);
        }
      }
    }
    if (a.type === 'notify_app_user' && a.to !== 'creator' && !roleKeys.has(a.to.role))
      problems.push(`El rol «${a.to.role}» no existe en esta app.`);
    if (a.type === 'notify_app_user' && a.screen && !screenSlugs.has(a.screen))
      problems.push(`La pantalla «${a.screen}» del aviso no es de esta app.`);
    if ((a.type === 'email' || a.type === 'notify_member') && 'roles' in a)
      for (const r of a.roles)
        if (!roleKeys.has(r)) problems.push(`El rol «${r}» no existe en esta app.`);
  }

  if (problems.length) throw new ValidationError([...new Set(problems)].join(' '));
  return { input, trackerId };
}

export async function createAutomation(
  db: SupabaseClient,
  appId: string,
  raw: unknown,
  userId: string,
): Promise<AutomationRow> {
  const { input, trackerId } = await validateAutomation(db, appId, raw);
  const { count, error: countError } = await db
    .from('custom_app_automations')
    .select('id', { count: 'exact', head: true })
    .eq('app_id', appId);
  if (countError) throw countError;
  if ((count ?? 0) >= MAX_AUTOMATIONS_PER_APP)
    throw new ValidationError(
      `Una app admite hasta ${MAX_AUTOMATIONS_PER_APP} automatizaciones; pausa o borra alguna.`,
    );
  const { data, error } = await db
    .from('custom_app_automations')
    .insert({
      app_id: appId,
      name: input.name,
      enabled: input.enabled,
      trigger: input.trigger,
      conditions: input.conditions,
      actions: input.actions,
      tracker_id: trackerId,
      trigger_kind: input.trigger.type,
      created_by: userId,
    })
    .select(AUTOMATION_COLUMNS)
    .single();
  if (error) throw error;
  forgetAutomationWatch();
  return adaptAutomation(data as Record<string, unknown>);
}

export async function updateAutomation(
  db: SupabaseClient,
  appId: string,
  id: string,
  raw: unknown,
): Promise<AutomationRow> {
  await mustGetAutomation(db, appId, id);
  const { input, trackerId } = await validateAutomation(db, appId, raw);
  const { data, error } = await db
    .from('custom_app_automations')
    .update({
      name: input.name,
      enabled: input.enabled,
      trigger: input.trigger,
      conditions: input.conditions,
      actions: input.actions,
      tracker_id: trackerId,
      trigger_kind: input.trigger.type,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('app_id', appId)
    .select(AUTOMATION_COLUMNS)
    .single();
  if (error) throw error;
  forgetAutomationWatch();
  return adaptAutomation(data as Record<string, unknown>);
}

/** Pausar o reanudar. Pausar no borra el historial ni cancela lo que ya corre. */
export async function setAutomationEnabled(
  db: SupabaseClient,
  appId: string,
  id: string,
  enabled: boolean,
): Promise<AutomationRow> {
  await mustGetAutomation(db, appId, id);
  const { data, error } = await db
    .from('custom_app_automations')
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('app_id', appId)
    .select(AUTOMATION_COLUMNS)
    .single();
  if (error) throw error;
  forgetAutomationWatch();
  return adaptAutomation(data as Record<string, unknown>);
}

export async function deleteAutomation(
  db: SupabaseClient,
  appId: string,
  id: string,
): Promise<void> {
  await mustGetAutomation(db, appId, id);
  const { error } = await db
    .from('custom_app_automations')
    .delete()
    .eq('id', id)
    .eq('app_id', appId);
  if (error) throw error;
  forgetAutomationWatch();
}

/** Los botones de acción manual de una pantalla (disparadores `button`, encendidos). */
export async function screenButtons(
  db: SupabaseClient,
  appId: string,
  screenSlug: string,
): Promise<Array<{ id: string; label: string; automationId: string }>> {
  const { data, error } = await db
    .from('custom_app_automations')
    .select('id, trigger')
    .eq('app_id', appId)
    .eq('enabled', true)
    .eq('trigger_kind', 'button')
    .limit(60);
  if (error) throw error;
  const out: Array<{ id: string; label: string; automationId: string }> = [];
  for (const r of (data ?? []) as Array<{ id: string; trigger: unknown }>) {
    const t = automationTriggerSchema.safeParse(r.trigger);
    if (t.success && t.data.type === 'button' && t.data.screen === screenSlug)
      out.push({ id: t.data.id, label: t.data.label, automationId: r.id });
  }
  return out;
}

/** Corridas de hoy (hora de Bogotá) de la app: el tope diario. */
export async function runsToday(
  db: SupabaseClient,
  appId: string,
  now: Date,
): Promise<{ runs: number; askCortex: number }> {
  const local = new Date(now.getTime() - 5 * 3_600_000);
  const startUtc = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + 5 * 3_600_000,
  ).toISOString();
  const { data, error } = await db
    .from('custom_app_automation_runs')
    .select('ask_cortex_calls')
    .eq('app_id', appId)
    .gte('created_at', startUtc)
    .limit(5000);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ ask_cortex_calls: number }>;
  return {
    runs: rows.length,
    askCortex: rows.reduce((n, r) => n + Number(r.ask_cortex_calls ?? 0), 0),
  };
}
