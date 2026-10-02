'use server';

import type { MappingSuggestion, TeamActionResult } from '@/components/team/types';
import { buildToolContext } from '@/lib/agent';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { REGISTRY_ONLY_SOURCES, canMarkDone, isIsoDay } from '@/lib/team/shape';
import {
  getTrackerBySlug,
  getWorkItemsByIds,
  markMet,
  personLabelOf,
  syncWork,
  updateWorkPerson,
  upsertWorkItems,
  workAssign,
  workConfigure,
  workDirectory,
  workSuggestMapping,
  writeAuditEvent,
} from '@cortex/agent-tools';
import { type UUID, logger } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE CAMBIA DESDE «EQUIPO».
 *
 * Cada export es un endpoint que cualquiera con sesión puede llamar, así que
 * cada uno vuelve a mirar quién es y qué puede, y delega en la MISMA lógica
 * del chat (packages/agent-tools/src/work): reasignar es `work.assign`,
 * conectar una tabla es `work.suggest_mapping` + `work.configure`, los días
 * fuera son la regla de `updateWorkPerson`. La confirmación es el diálogo de
 * la pantalla: aquí no se escribe nada que la persona no haya visto.
 *
 *   - Pasar trabajo de otra persona: sólo quien administra (`org_admin`).
 *   - Qué se mide y quién ve qué: sólo quien administra.
 *   - Marcar hecho: sólo lo propio, y sólo por un camino que ya existe.
 *   - Días fuera: los propios, cualquiera; los de otro, quien administra.
 */

const PATH = '/team';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function message(err: unknown, fallback: string): string {
  const text = err instanceof Error ? err.message : '';
  return text && text.length < 300 ? text : fallback;
}

function toolContext(user: { id: string; organization: { id: string } }) {
  return buildToolContext({
    organizationId: user.organization.id,
    userId: user.id as UUID,
    agentId: user.id as UUID,
    surface: 'web',
  });
}

export async function reassignWork(input: {
  moves: Array<{ toId: string; itemIds: string[] }>;
}): Promise<TeamActionResult> {
  const started = performance.now();
  try {
    const user = await requireSession();
    if (user.role !== 'org_admin')
      return {
        ok: false,
        error: 'Sólo quien administra la empresa puede pasar trabajo de otra persona.',
      };
    const moves = (Array.isArray(input?.moves) ? input.moves : [])
      .map((m) => ({
        toId: String(m?.toId ?? ''),
        itemIds: (Array.isArray(m?.itemIds) ? m.itemIds : [])
          .map(String)
          .filter((id) => UUID_RE.test(id)),
      }))
      .filter((m) => UUID_RE.test(m.toId) && m.itemIds.length > 0);
    const total = moves.reduce((n, m) => n + m.itemIds.length, 0);
    if (!total) return { ok: false, error: 'Elige al menos un ítem para pasar.' };
    if (total > 100) return { ok: false, error: 'Son demasiados ítems de una vez (máximo 100).' };

    const ctx = toolContext(user);
    const names = new Map((await workDirectory(ctx.db)).map((p) => [p.id, personLabelOf(p)]));
    const lines: string[] = [];
    const refused: string[] = [];
    let assigned = 0;
    let notified = false;
    for (const move of moves) {
      const parsed = workAssign.inputSchema.parse({ itemIds: move.itemIds, person: move.toId });
      const out = await workAssign.handler(parsed, ctx);
      assigned += out.assigned;
      notified ||= out.notified;
      if (out.assigned)
        lines.push(`${out.assigned} a ${names.get(move.toId) ?? 'la persona elegida'}`);
      for (const r of out.refused) refused.push(`${r.title || 'Un ítem'}: ${r.reason}`);
    }
    await writeAuditEvent({
      db: ctx.db,
      userId: user.id as UUID,
      toolId: 'work.assign',
      input: { moves },
      status: 'ok',
      latencyMs: Math.round(performance.now() - started),
      surface: 'web',
      decision: 'confirmed',
      metadata: { assigned, refused: refused.length, from: 'team' },
    });
    revalidatePath(PATH, 'layout');
    if (!assigned)
      return { ok: false, error: refused[0] ?? 'No se pudo pasar ninguno de esos ítems.' };
    return {
      ok: true,
      note: [
        `Listo: pasé ${lines.join(' y ')}.`,
        notified ? 'Les avisé en la campana.' : '',
        refused.length ? `No pude pasar ${refused.length}: ${refused.slice(0, 2).join(' ')}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo reasignar. Intenta de nuevo.') };
  }
}

export async function markWorkDone(input: { itemId: string }): Promise<TeamActionResult> {
  const started = performance.now();
  try {
    const user = await requireSession();
    const id = String(input?.itemId ?? '');
    if (!UUID_RE.test(id)) return { ok: false, error: 'Ese ítem no existe.' };
    const db = getOrgScopedClient(user.organization.id);
    const [item] = await getWorkItemsByIds(db, [id]);
    if (!item) return { ok: false, error: 'Ese ítem ya no está en el registro.' };
    if (item.assigneeId !== user.id)
      return { ok: false, error: 'Sólo puedes marcar como hecho tu propio trabajo.' };
    if (item.status !== 'open') return { ok: true, note: 'Ya estaba cerrado.' };
    if (!canMarkDone(item, user.id))
      return { ok: false, error: 'Este se cierra en su fuente: ábrelo desde el enlace.' };

    const now = new Date().toISOString();
    if (item.source.kind === 'commitment') {
      // El mismo camino que «Cumplido» en /commitments; el registro se entera
      // con la sincronización incremental, que lee lo cambiado desde la última.
      await markMet(db, { id: item.source.ref, userId: user.id, note: null });
      try {
        await syncWork(db, user.organization.id);
      } catch (err) {
        logger.warn({ err }, 'team: el compromiso se cumplió pero el registro no se refrescó');
      }
    } else if (REGISTRY_ONLY_SOURCES.includes(item.source.kind)) {
      // Su fuente es el registro: re-anotarlo con la misma identidad lo actualiza.
      await upsertWorkItems(db, [
        {
          assigneeId: item.assigneeId,
          assigneeLabel: null,
          workType: item.workType,
          title: item.title,
          status: 'done',
          openedAt: item.openedAt,
          dueAt: item.dueAt ?? null,
          doneAt: now,
          lastActivityAt: now,
          quantity: item.quantity ?? null,
          unit: item.unit ?? null,
          team: item.team ?? null,
          source: item.source,
        },
      ]);
    }
    await writeAuditEvent({
      db,
      userId: user.id as UUID,
      toolId: 'work.mark_done',
      input: { itemId: id },
      status: 'ok',
      latencyMs: Math.round(performance.now() - started),
      surface: 'web',
      decision: 'confirmed',
      metadata: { source: item.source.kind },
    });
    revalidatePath(PATH, 'layout');
    return { ok: true, note: `Hecho: «${item.title}».` };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo marcar como hecho.') };
  }
}

export async function saveAwayDays(input: {
  personId: string;
  add: string[];
  remove: string[];
}): Promise<TeamActionResult> {
  try {
    const user = await requireSession();
    const personId = String(input?.personId ?? '');
    if (!UUID_RE.test(personId)) return { ok: false, error: 'Esa persona no existe.' };
    const add = (input?.add ?? []).map(String).filter(isIsoDay).slice(0, 120);
    const remove = (input?.remove ?? []).map(String).filter(isIsoDay).slice(0, 120);
    if (!add.length && !remove.length) return { ok: false, error: 'No hay días para cambiar.' };
    const db = getOrgScopedClient(user.organization.id);
    const meta = await updateWorkPerson(db, {
      actor: { id: user.id, admin: user.role === 'org_admin' },
      userId: personId,
      change: { addAwayDays: add, removeAwayDays: remove },
    });
    revalidatePath(PATH, 'layout');
    return {
      ok: true,
      note: add.length
        ? `Anotado: ${add.length === 1 ? '1 día fuera' : `${add.length} días fuera`}. No cuentan en contra.`
        : `Quitado. Quedan ${meta.awayDays.length} días fuera anotados.`,
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudieron guardar los días fuera.') };
  }
}

export async function suggestWorkMapping(input: { tracker: string }): Promise<MappingSuggestion> {
  try {
    const user = await requireSession();
    if (user.role !== 'org_admin')
      return { ok: false, error: 'Sólo quien administra decide qué trabajo se mide.' };
    const ctx = toolContext(user);
    const out = await workSuggestMapping.handler(
      workSuggestMapping.inputSchema.parse({ tracker: String(input?.tracker ?? '') }),
      ctx,
    );
    const m = out.mapping as Record<string, unknown> | null;
    const key = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    return {
      ok: true,
      mapping:
        m && key(m.assigneeField)
          ? {
              assigneeField: String(m.assigneeField),
              statusField: key(m.statusField),
              doneValues: list(m.doneValues),
              cancelledValues: list(m.cancelledValues),
              dueField: key(m.dueField),
              quantityField: key(m.quantityField),
              unit: key(m.unit),
              titleField: key(m.titleField),
            }
          : null,
      candidates: out.assigneeCandidates.map((c) => ({
        key: c.key,
        label: c.label,
        reason: c.reason,
      })),
      notes: out.markdown,
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo leer esa tabla.') };
  }
}

export async function configureWork(input: {
  mapTracker?: {
    tracker: string;
    workType: string;
    assigneeField: string;
    statusField: string | null;
    doneValues: string[];
    cancelledValues: string[];
    dueField: string | null;
    quantityField: string | null;
    unit: string | null;
    titleField: string | null;
  };
  unmapTracker?: string;
  measuredTypes?: string[] | null;
  teamVisibility?: 'self' | 'team' | 'all';
}): Promise<TeamActionResult> {
  const started = performance.now();
  try {
    const user = await requireSession();
    if (user.role !== 'org_admin')
      return { ok: false, error: 'Sólo quien administra decide qué trabajo se mide.' };
    const ctx = toolContext(user);
    if (input?.mapTracker) {
      const tracker = await getTrackerBySlug(ctx.db, input.mapTracker.tracker);
      if (!tracker) return { ok: false, error: 'Esa tabla ya no existe.' };
    }
    const parsed = workConfigure.inputSchema.safeParse({
      ...(input?.mapTracker ? { mapTracker: input.mapTracker } : {}),
      ...(input?.unmapTracker ? { unmapTracker: input.unmapTracker } : {}),
      ...(input?.measuredTypes !== undefined ? { measuredTypes: input.measuredTypes } : {}),
      ...(input?.teamVisibility ? { teamVisibility: input.teamVisibility } : {}),
    });
    if (!parsed.success)
      return { ok: false, error: 'Revisa los campos: falta el responsable o el tipo de trabajo.' };
    const out = await workConfigure.handler(parsed.data, ctx);
    await writeAuditEvent({
      db: ctx.db,
      userId: user.id as UUID,
      toolId: 'work.configure',
      input: parsed.data,
      status: 'ok',
      latencyMs: Math.round(performance.now() - started),
      surface: 'web',
      decision: 'confirmed',
      metadata: { loaded: out.loaded, from: 'team' },
    });
    revalidatePath(PATH, 'layout');
    return {
      ok: true,
      note:
        out.loaded !== null
          ? `Conectada. Cargué ${out.loaded} ${out.loaded === 1 ? 'ítem' : 'ítems'} de trabajo.`
          : 'Guardado.',
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo guardar.') };
  }
}
