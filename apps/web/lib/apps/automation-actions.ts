'use server';

import { appBaseUrl } from '@/lib/apps/automation-deps';
import { pushEnabled } from '@/lib/apps/push';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type AutomationLimits,
  type AutomationTemplateParams,
  MAX_AUTOMATION_LIMITS,
  createAutomation,
  deleteAutomation,
  describeAutomation,
  getAppLimits,
  lastRuns,
  listAutomationRuns,
  listAutomations,
  mustGetApp,
  mustGetAutomation,
  setAppLimits,
  setAutomationEnabled,
  simulateAutomation,
  templateById,
  updateAutomation,
  viewerFromSession,
  webhookSecretFor,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { signingSecret } from './automation-deps';

/**
 * Lo que hacen los botones de la pestaña «Automatizaciones» del editor. Todo es
 * de quien administra la empresa; la regla se valida contra la app y las tablas
 * REALES (`validateAutomation`) antes de guardarse, y el navegador nunca manda
 * la empresa: sale de la sesión.
 */

export type AutomationActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface AutomationView {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  input: {
    name: string;
    enabled: boolean;
    trigger: unknown;
    conditions: unknown[];
    actions: unknown[];
  };
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  /** Sólo para webhooks: la llave con la que se firman los envíos de esta regla. */
  webhookKey: string | null;
}

export interface RunView {
  id: string;
  status: string;
  error: string | null;
  attempts: number;
  triggerRef: string;
  createdAt: string;
  finishedAt: string | null;
  results: Array<{ index: number; type: string; ok: boolean; detail: string }>;
}

function describe(err: unknown, fallback: string): string {
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  const message = err instanceof Error ? err.message : '';
  return message && message.length < 300 && !/[{}]|relation|column|violates/.test(message)
    ? message
    : fallback;
}

async function admin(appRef: string) {
  const user = await requireSession();
  if (!viewerFromSession(user).companyAdmin)
    throw new ValidationError(
      'Sólo quien administra la empresa puede cambiar las automatizaciones.',
    );
  const db = getOrgScopedClient(user.organization.id);
  const app = await mustGetApp(db, z.string().trim().min(1).max(80).parse(appRef));
  return { user, db, app };
}

function touched(appId: string) {
  revalidatePath(`/apps/${appId}/edit`);
}

export async function loadAutomationsAction(appRef: string): Promise<
  AutomationActionResult<{
    automations: AutomationView[];
    pushOn: boolean;
    caps: AutomationLimits;
    capsMax: AutomationLimits;
  }>
> {
  try {
    const { db, app } = await admin(appRef);
    const [rows, runs, caps] = await Promise.all([
      listAutomations(db, app.id),
      lastRuns(db, app.id),
      getAppLimits(db, app.id),
    ]);
    return {
      ok: true,
      pushOn: pushEnabled(),
      caps,
      capsMax: MAX_AUTOMATION_LIMITS,
      automations: rows.map((a) => ({
        id: a.id,
        name: a.name,
        enabled: a.enabled,
        description: describeAutomation(a),
        input: {
          name: a.name,
          enabled: a.enabled,
          trigger: a.trigger,
          conditions: a.conditions,
          actions: a.actions,
        },
        lastRunAt: a.last_run_at,
        lastStatus: a.last_status,
        lastError: runs.get(a.id)?.error ?? null,
        webhookKey: a.actions.some((x) => x.type === 'webhook')
          ? webhookSecretFor(signingSecret(), a.id)
          : null,
      })),
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudieron leer las automatizaciones.') };
  }
}

export async function loadRunsAction(
  appRef: string,
  automationId: string,
): Promise<AutomationActionResult<{ runs: RunView[] }>> {
  try {
    const { db, app } = await admin(appRef);
    await mustGetAutomation(db, app.id, z.string().uuid().parse(automationId));
    const runs = await listAutomationRuns(db, automationId, 25);
    return {
      ok: true,
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        error: r.error,
        attempts: r.attempts,
        triggerRef: r.trigger_ref,
        createdAt: r.created_at,
        finishedAt: r.finished_at,
        results: r.result,
      })),
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo leer el historial.') };
  }
}

export async function saveAutomationAction(
  appRef: string,
  id: string | null,
  input: unknown,
): Promise<AutomationActionResult<{ id: string }>> {
  try {
    const { user, db, app } = await admin(appRef);
    const saved = id
      ? await updateAutomation(db, app.id, z.string().uuid().parse(id), input)
      : await createAutomation(db, app.id, input, user.id);
    touched(app.id);
    return { ok: true, id: saved.id };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar la automatización.') };
  }
}

export async function createFromTemplateAction(
  appRef: string,
  templateId: string,
  params: AutomationTemplateParams,
): Promise<AutomationActionResult<{ id: string }>> {
  try {
    const { user, db, app } = await admin(appRef);
    const template = templateById(templateId);
    if (!template) throw new NotFoundError('Esa plantilla no existe.');
    let draft: unknown;
    try {
      draft = template.build(params);
    } catch (err) {
      throw new ValidationError(
        err instanceof Error ? err.message : 'Faltan datos de la plantilla.',
      );
    }
    const saved = await createAutomation(db, app.id, draft, user.id);
    touched(app.id);
    return { ok: true, id: saved.id };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo crear desde la plantilla.') };
  }
}

export async function toggleAutomationAction(
  appRef: string,
  id: string,
  enabled: boolean,
): Promise<AutomationActionResult> {
  try {
    const { db, app } = await admin(appRef);
    await setAutomationEnabled(db, app.id, z.string().uuid().parse(id), enabled);
    touched(app.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo cambiar el estado.') };
  }
}

export async function deleteAutomationAction(
  appRef: string,
  id: string,
): Promise<AutomationActionResult> {
  try {
    const { db, app } = await admin(appRef);
    await deleteAutomation(db, app.id, z.string().uuid().parse(id));
    touched(app.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo borrar la automatización.') };
  }
}

/** Probar con una fila de ejemplo: dice qué haría, sin hacer NADA. */
export async function testAutomationAction(
  appRef: string,
  input: unknown,
  rowId?: string,
): Promise<
  AutomationActionResult<{
    triggers: boolean;
    conditionsOk: boolean;
    conditionsFailed: string | null;
    sample: string | null;
    actions: Array<{ type: string; summary: string }>;
  }>
> {
  try {
    const { db, app } = await admin(appRef);
    const { validateAutomation } = await import('@cortex/agent-tools');
    const { input: valid } = await validateAutomation(db, app.id, input);
    const sim = await simulateAutomation(db, app, valid, {
      rowId: rowId || undefined,
      baseUrl: appBaseUrl(),
    });
    return {
      ok: true,
      triggers: sim.triggers,
      conditionsOk: sim.conditions.ok,
      conditionsFailed: sim.conditions.failed ?? null,
      sample: sim.sample?.label ?? null,
      actions: sim.actions,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo probar la automatización.') };
  }
}

/** Cambia los topes diarios de la app (corridas y pedidos a Cortex). */
export async function saveLimitsAction(
  appRef: string,
  limits: { runsPerDay: number; askCortexPerDay: number },
): Promise<AutomationActionResult<{ caps: AutomationLimits }>> {
  try {
    const { db, app } = await admin(appRef);
    const caps = await setAppLimits(db, app.id, {
      runsPerDay: Math.floor(Number(limits.runsPerDay)),
      askCortexPerDay: Math.floor(Number(limits.askCortexPerDay)),
    });
    touched(app.id);
    return { ok: true, caps };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudieron guardar los topes.') };
  }
}

/** Las filas más recientes de una tabla, para elegir con cuál probar una regla. */
export async function sampleRowsAction(
  appRef: string,
  trackerSlug: string,
): Promise<AutomationActionResult<{ rows: Array<{ id: string; label: string }> }>> {
  try {
    const { db } = await admin(appRef);
    const { getTrackerBySlug } = await import('@cortex/agent-tools');
    const tracker = await getTrackerBySlug(db, z.string().trim().min(1).max(60).parse(trackerSlug));
    if (!tracker) return { ok: true, rows: [] };
    const { data, error } = await db
      .from('tracker_rows')
      .select('id, label')
      .eq('tracker_id', tracker.id)
      .order('updated_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    return { ok: true, rows: (data ?? []) as Array<{ id: string; label: string }> };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudieron leer las filas.') };
  }
}
