'use server';

import { canManageAccounting } from '@/lib/accounting/card';
import { enqueueJob } from '@/lib/jobs';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import {
  canRefreshOrigin,
  getTrackerBySlug,
  loadOriginStatuses,
  originName,
  requestOriginRefresh,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import type { TableOriginInfo, TableOriginsResult } from './origin-types';

/**
 * DE DÓNDE VIENE UNA TABLA, Y «ACTUALIZAR AHORA» (0237).
 *
 * Lo que dice cada bloque y la grilla de una tabla que se llena sola: su
 * origen, cuándo se leyó por última vez, si está corriendo, y si quien mira
 * puede pedir una lectura nueva (contable: administración; hoja y carpeta: quien
 * la creó o administra). Pedirla es lo que ya hacía cada sincronización
 * —adelantar `next_run_at` y encolar la corrida—, con un tope de un minuto.
 *
 * Devuelven `{ ok, error }` en vez de lanzar (en producción Next borra el
 * mensaje de lo que una acción lanza).
 */

const SLUG_RE = /^[a-z][a-z0-9_]{1,47}$/;

function say(err: unknown, fallback: string): string {
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  return fallback;
}

export async function readTableOrigins(slug: string): Promise<TableOriginsResult> {
  if (!SLUG_RE.test(String(slug))) return { ok: false, error: 'Esa tabla no existe.' };
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const tracker = await getTrackerBySlug(db, slug);
    if (!tracker) return { ok: false, error: 'Esa tabla ya no existe.' };
    const denied = await deniedToolPatterns(db, user.id);
    const canManage = canManageAccounting(user.organization.role);
    const statuses = await loadOriginStatuses(db, tracker);
    const items: TableOriginInfo[] = statuses.map((s) => ({
      ref: s.origin.ref,
      kind: s.origin.kind,
      name: originName(s.origin),
      status: s.status,
      enabled: s.enabled,
      canRefresh:
        s.enabled &&
        !isToolDenied('trackers.retry_sync', denied) &&
        canRefreshOrigin(s, { userId: user.id, canManage }),
    }));
    return { ok: true, items };
  } catch (err) {
    return { ok: false, error: say(err, 'No se pudo leer el estado de la tabla.') };
  }
}

export async function refreshTableOrigin(
  slug: string,
  ref: string,
): Promise<{ ok: true; note: string } | { ok: false; error: string }> {
  if (!SLUG_RE.test(String(slug))) return { ok: false, error: 'Esa tabla no existe.' };
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const tracker = await getTrackerBySlug(db, slug);
    if (!tracker) return { ok: false, error: 'Esa tabla ya no existe.' };
    const denied = await deniedToolPatterns(db, user.id, { failClosed: true });
    if (isToolDenied('trackers.retry_sync', denied))
      return { ok: false, error: 'Tu equipo no tiene permiso para correr sincronizaciones.' };
    const statuses = await loadOriginStatuses(db, tracker);
    const found = statuses.find((s) => s.origin.ref === ref);
    if (!found) return { ok: false, error: 'Esa tabla ya no viene de ese origen.' };
    if (
      !canRefreshOrigin(found, {
        userId: user.id,
        canManage: canManageAccounting(user.organization.role),
      })
    )
      return {
        ok: false,
        error:
          found.origin.kind === 'accounting'
            ? 'Sólo quien administra la empresa puede pedir una lectura nueva del programa contable.'
            : 'Sólo quien la creó o quien administra la empresa puede actualizarla ya.',
      };
    const result = await requestOriginRefresh(db, found.origin, {
      organizationId: user.organization.id,
      enqueueJob,
    });
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath(`/trackers/${slug}`);
    return { ok: true, note: result.note };
  } catch (err) {
    return { ok: false, error: say(err, 'No se pudo pedir la actualización.') };
  }
}
