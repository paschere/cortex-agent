'use server';

import { buildToolContext } from '@/lib/agent';
import type { LookupDraft, LookupPreviewView } from '@/lib/datagrid/lookups';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import {
  type LookupFilterInput,
  type TrackerField,
  fetchCustomToolById,
  getTool,
  getTrackerById,
  previewLookup,
  resolveCredential,
  validateLookup,
  writeAuditEvent,
} from '@cortex/agent-tools';
import { NotFoundError, type UUID, ValidationError } from '@cortex/core';
import type { ActionResult } from './types';

/**
 * LO QUE SE HACE DESDE EL PANEL «CONSULTAS AUTOMÁTICAS».
 *
 * Mismo camino que el chat: crear y cambiar pasan por las herramientas
 * `trackers.row_lookup_create` / `trackers.row_lookup_update` (la validación,
 * la prueba con una fila, la pausa si la API contesta mal), y respetan lo que el
 * equipo de la persona tenga prohibido sobre ellas. La confirmación es el
 * diálogo de la pantalla. Probar no escribe nada. La llave de la credencial
 * nunca llega aquí: sólo su nombre y el servidor al que va.
 *
 * Devuelven `{ ok, error }` en vez de lanzar: en producción Next borra el
 * mensaje de lo que una acción lanza.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DENIED: Record<string, string> = {
  'trackers.row_lookup_create': 'Tu equipo no tiene permiso para crear consultas automáticas.',
  'trackers.row_lookup_update': 'Tu equipo no tiene permiso para cambiar consultas automáticas.',
};

function message(err: unknown, fallback: string): string {
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  const text = err instanceof Error ? err.message : '';
  return text && text.length < 280 && !/[{}]|relation|column|violates|PGRST|JSON/.test(text)
    ? text
    : fallback;
}

async function context(toolId: keyof typeof DENIED) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const denied = await deniedToolPatterns(db, user.id, { failClosed: true });
  if (isToolDenied(toolId, denied)) throw new ValidationError(DENIED[toolId] ?? 'Sin permiso.');
  return { user, db };
}

function toolContext(user: { id: string; organization: { id: string } }) {
  return buildToolContext({
    organizationId: user.organization.id,
    userId: user.id as UUID,
    agentId: user.id as UUID,
    surface: 'web',
  });
}

function toToolInput(draft: LookupDraft) {
  return {
    name: draft.name,
    urlTemplate: draft.urlTemplate,
    ...(draft.credential ? { credential: draft.credential } : {}),
    mapping: draft.mapping.map((m) => ({
      path: m.path,
      field: m.field,
      ...(m.label ? { label: m.label } : {}),
    })),
    filter: draft.filter,
    intervalMinutes: draft.intervalMinutes,
    ...(draft.near ? { near: draft.near } : {}),
    dailyCap: draft.dailyCap,
    perRunCap: draft.perRunCap,
  };
}

/** Una consulta de prueba con una fila, sin escribir nada. */
export async function previewLookupAction(
  trackerId: string,
  draft: LookupDraft,
): Promise<ActionResult<{ preview: LookupPreviewView }>> {
  try {
    const { db } = await context('trackers.row_lookup_create');
    if (!UUID_RE.test(trackerId)) return { ok: false, error: 'Esa tabla ya no existe.' };
    const tracker = await getTrackerById(db, trackerId);
    if (!tracker) return { ok: false, error: 'Esa tabla ya no existe.' };
    let credentialToolId: string | null = null;
    let credentialTool = null;
    if (draft.credential) {
      const ref = await resolveCredential(db, draft.credential);
      credentialTool = await fetchCustomToolById(db, ref.id);
      credentialToolId = ref.id;
    }
    // Las columnas nuevas del mapeo todavía no existen: para la prueba se
    // suponen de texto, que es como se crearían.
    const extra: TrackerField[] = draft.mapping
      .filter((m) => !tracker.fields.some((f) => f.key === m.field))
      .map((m) => ({
        key: m.field,
        label: m.label ?? m.field,
        type: 'text' as const,
        required: false,
      }));
    const withExtra = { ...tracker, fields: [...tracker.fields, ...extra] };
    const checked = validateLookup(
      withExtra,
      {
        name: draft.name,
        urlTemplate: draft.urlTemplate,
        mapping: draft.mapping,
        // La validación de verdad es la del esquema: aquí sólo se pasa.
        filter: draft.filter as LookupFilterInput,
        near: draft.near,
      },
      credentialTool,
    );
    const preview = await previewLookup(db, {
      tracker: withExtra,
      spec: {
        url_template: draft.urlTemplate.trim(),
        filter: checked.filter,
        mapping: checked.mapping,
        credential_tool_id: credentialToolId,
      },
    });
    return {
      ok: true,
      preview: {
        ok: preview.ok,
        rowLabel: preview.rowLabel,
        url: preview.url,
        fields: preview.fields.map(({ label, current, next }) => ({ label, current, next })),
        message: preview.message,
      },
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo probar la consulta.') };
  }
}

export async function createLookupAction(
  trackerId: string,
  draft: LookupDraft,
): Promise<ActionResult<{ message: string; enabled: boolean }>> {
  const started = performance.now();
  try {
    const { user, db } = await context('trackers.row_lookup_create');
    if (!UUID_RE.test(trackerId)) return { ok: false, error: 'Esa tabla ya no existe.' };
    const tracker = await getTrackerById(db, trackerId);
    if (!tracker) return { ok: false, error: 'Esa tabla ya no existe.' };
    const tool = getTool('trackers.row_lookup_create');
    if (!tool) return { ok: false, error: 'Esta instalación no tiene consultas automáticas.' };
    const out = (await tool.handler(
      tool.inputSchema.parse({ table: tracker.slug, ...toToolInput(draft) }),
      toolContext(user),
    )) as { id: string; enabled: boolean; markdown: string };
    await writeAuditEvent({
      db,
      userId: user.id as UUID,
      toolId: 'trackers.row_lookup_create',
      input: { trackerId, name: draft.name },
      status: 'ok',
      latencyMs: Math.round(performance.now() - started),
      surface: 'web',
      decision: 'confirmed',
      metadata: { from: 'tablas', trackerId, lookupId: out.id, enabled: out.enabled },
    });
    return { ok: true, message: out.markdown, enabled: out.enabled };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo crear la consulta.') };
  }
}

export async function updateLookupAction(
  lookupId: string,
  patch: { enabled?: boolean; dailyCap?: number; perRunCap?: number; runNow?: boolean },
): Promise<ActionResult<{ message: string }>> {
  const started = performance.now();
  try {
    const { user, db } = await context('trackers.row_lookup_update');
    if (!UUID_RE.test(lookupId)) return { ok: false, error: 'Esa consulta ya no existe.' };
    const tool = getTool('trackers.row_lookup_update');
    if (!tool) return { ok: false, error: 'Esta instalación no tiene consultas automáticas.' };
    const out = (await tool.handler(
      tool.inputSchema.parse({ lookup: lookupId, ...patch }),
      toolContext(user),
    )) as { markdown: string };
    await writeAuditEvent({
      db,
      userId: user.id as UUID,
      toolId: 'trackers.row_lookup_update',
      input: { lookupId, ...patch },
      status: 'ok',
      latencyMs: Math.round(performance.now() - started),
      surface: 'web',
      decision: 'confirmed',
      metadata: { from: 'tablas', lookupId, ...patch },
    });
    return { ok: true, message: out.markdown };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo cambiar la consulta.') };
  }
}
