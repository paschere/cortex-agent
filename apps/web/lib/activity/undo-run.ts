import 'server-only';
import { buildToolContext } from '@/lib/agent';
import { mustReadList } from '@/lib/supabase/read';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { getTool, isCompanyManager, runTool, writeAuditEvent } from '@cortex/agent-tools';
import { loadUndoneIds } from './load';
import { canSeeEvent } from './scope';
import { describeEvent } from './sentences';
import type { ActivityEvent } from './types';
import { undoPlanFor } from './undo';

export interface UndoOutcome {
  eventId: string;
  ok: boolean;
  message: string;
}

const MAX_EVENTS = 20;

/**
 * DESHACER, POR EL MISMO CAMINO QUE TODO LO DEMÁS.
 *
 * Nada de escribir en la base a mano: el plan de `undo.ts` se ejecuta con
 * `runTool` y la sesión de quien pulsa «Deshacer» (permisos del equipo, límites,
 * auditoría de la propia herramienta). Pulsarlo es la confirmación humana, igual
 * que aprobar una tarjeta. Si sale bien, queda además una fila `activity.undo`
 * que (1) es el registro de que se deshizo y (2) apaga el botón.
 */
export async function undoActivityEvents(
  user: { id: string; role: string; organization: { id: string } },
  eventIds: string[],
): Promise<UndoOutcome[]> {
  const ids = [...new Set(eventIds)].slice(0, MAX_EVENTS);
  if (ids.length === 0) return [];
  const orgId = user.organization.id;
  const db = getOrgScopedClient(orgId);
  const viewer = {
    id: user.id,
    isManager: user.role === 'org_admin' || (await isCompanyManager(db, user.id)),
  };
  const events = mustReadList<ActivityEvent>(
    await db
      .from('audit_events')
      .select(
        'id,user_id,conversation_id,tool_id,status,decision,surface,mandate_id,created_at,metadata',
      )
      .in('id', ids),
    'las acciones a deshacer',
  );
  const done = await loadUndoneIds(db, ids);
  const denied = await deniedToolPatterns(db, user.id);
  const out: UndoOutcome[] = [];

  for (const id of ids) {
    const ev = events.find((e) => e.id === id);
    if (!ev || !canSeeEvent(viewer, ev)) {
      out.push({ eventId: id, ok: false, message: 'No encontré esa acción.' });
      continue;
    }
    if (done.has(id)) {
      out.push({ eventId: id, ok: false, message: 'Esto ya se deshizo.' });
      continue;
    }
    const plan = undoPlanFor(ev);
    const tool = plan ? getTool(plan.toolId) : undefined;
    if (!plan || !tool) {
      out.push({ eventId: id, ok: false, message: 'Esto no se puede deshacer.' });
      continue;
    }
    if (isToolDenied(plan.toolId, denied)) {
      out.push({ eventId: id, ok: false, message: 'No tienes permiso para deshacer esto.' });
      continue;
    }
    const sentence = describeEvent(ev).text;
    try {
      const ctx = buildToolContext({
        organizationId: orgId,
        userId: user.id,
        agentId: user.id,
        surface: 'web',
      });
      await runTool(tool, plan.input, ctx, { confirmed: true });
      await writeAuditEvent({
        db,
        userId: user.id,
        toolId: 'activity.undo',
        input: { eventId: id },
        status: 'ok',
        latencyMs: 0,
        surface: 'web',
        metadata: { undoes: id, tool: ev.tool_id, via: plan.toolId, sentence },
      });
      out.push({ eventId: id, ok: true, message: 'Listo, lo deshice.' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo deshacer.';
      await writeAuditEvent({
        db,
        userId: user.id,
        toolId: 'activity.undo',
        input: { eventId: id },
        status: 'error',
        latencyMs: 0,
        surface: 'web',
        metadata: { undoes: id, tool: ev.tool_id, via: plan.toolId, error: message.slice(0, 200) },
      });
      out.push({ eventId: id, ok: false, message });
    }
  }
  return out;
}
