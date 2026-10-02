import type { SupabaseClient } from '@supabase/supabase-js';
import type { TeamVisibility } from './shape';
import { type WorkPersonMeta, isWorkAdmin, listWorkPeopleMeta, readWorkSettings } from './store';

/**
 * QUIÉN VE EL TRABAJO DE QUIÉN.
 *
 * Tres reglas, decididas por el dueño y no negociables en el código:
 *
 *   1. Cada persona puede ver TODO lo que se mide de ella. Siempre.
 *   2. Quien administra la empresa (`users.role = 'org_admin'`) ve a todo el
 *      equipo, y lo que no tiene responsable.
 *   3. Los demás ven lo suyo, salvo que la empresa abra la visibilidad
 *      (`work_settings.team_visibility`): `team` = lo de las personas de su
 *      mismo equipo; `all` = todo el equipo.
 *
 * Sin nadie mirando (una lectura sin persona) no se ve nada: lo personal se
 * esconde por defecto, como la nómina en ledger/privacy.ts. La misma regla se
 * aplica en el chat (`work.query`) y en las vistas (`cortex.trabajo`,
 * `cortex.equipo`): una puerta que la respeta y otra que no, no es una regla.
 */

export interface WorkScope {
  viewerId: string | null;
  admin: boolean;
  visibility: TeamVisibility;
  /** Personas visibles. `null` = todas (y lo que no tiene responsable). */
  visibleIds: ReadonlySet<string> | null;
}

/** La regla, pura: quién mira, si administra, la visibilidad y los equipos. */
export function scopeFor(input: {
  viewerId: string | null;
  admin: boolean;
  visibility: TeamVisibility;
  meta: ReadonlyMap<string, Pick<WorkPersonMeta, 'team'>>;
}): WorkScope {
  const base = { viewerId: input.viewerId, admin: input.admin, visibility: input.visibility };
  if (!input.viewerId) return { ...base, admin: false, visibleIds: new Set() };
  if (input.admin || input.visibility === 'all') return { ...base, visibleIds: null };
  if (input.visibility === 'team') {
    const team = input.meta.get(input.viewerId)?.team?.trim().toLowerCase();
    if (team) {
      const ids = new Set<string>([input.viewerId]);
      for (const [id, m] of input.meta) if (m.team?.trim().toLowerCase() === team) ids.add(id);
      return { ...base, visibleIds: ids };
    }
  }
  return { ...base, visibleIds: new Set([input.viewerId]) };
}

export async function workScope(db: SupabaseClient, viewerId: string | null): Promise<WorkScope> {
  if (!viewerId) return scopeFor({ viewerId, admin: false, visibility: 'self', meta: new Map() });
  const [admin, settings, meta] = await Promise.all([
    isWorkAdmin(db, viewerId),
    readWorkSettings(db),
    listWorkPeopleMeta(db),
  ]);
  return scopeFor({ viewerId, admin, visibility: settings.teamVisibility, meta });
}

/** ¿Ve este ítem? Lo sin responsable sólo lo ve quien ve a todos. */
export function canSeeAssignee(scope: WorkScope, assigneeId: string | null): boolean {
  if (scope.visibleIds === null) return true;
  return assigneeId !== null && scope.visibleIds.has(assigneeId);
}

/** Para filtrar en la base: `null` = sin filtro; un arreglo = sólo esas personas. */
export function scopeAssigneeIds(scope: WorkScope): string[] | null {
  return scope.visibleIds === null ? null : [...scope.visibleIds];
}
