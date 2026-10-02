import type { SupabaseClient } from '@supabase/supabase-js';
import { getTool } from '../registry';
import { guardFor, splitRepeatFlag } from './runtime';
import { readAction, withinWindow } from './store';
import type { VerifyStatus } from './types';

/**
 * ¿ESTO YA SE HIZO? — para quien va a aprobar.
 *
 * La tarjeta de aprobación lo pregunta antes de enseñar el botón: si la misma
 * persona ya hizo exactamente esta acción dentro de la ventana, la tarjeta lo
 * dice («Esto repite algo que ya se hizo a las 10:42») y aprobar significa
 * repetir a sabiendas. Sin este aviso, aprobar una segunda tarjeta idéntica se
 * devolvería como «ya estaba hecho», que es correcto pero llega tarde: la
 * persona tenía que saberlo al decidir, no después.
 *
 * Sólo lee. Cualquier fallo es «no se sabe», que en la tarjeta es no decir
 * nada — la guardia de `runTool` sigue en pie igualmente.
 */
export interface PriorAction {
  at: string;
  verification: VerifyStatus | null;
}

export async function findPriorAction(opts: {
  db: SupabaseClient;
  organizationId: string;
  userId: string;
  toolId: string;
  input: unknown;
  now?: Date;
}): Promise<PriorAction | null> {
  const tool = getTool(opts.toolId);
  if (!tool?.safeAction) return null;
  const { data } = splitRepeatFlag(opts.input);
  let guard: ReturnType<typeof guardFor>;
  try {
    guard = guardFor(tool.safeAction, tool.id, data, {
      organizationId: opts.organizationId,
      userId: opts.userId,
    });
  } catch {
    return null;
  }
  if (!guard) return null;
  const row = await readAction(opts.db, guard.key);
  if (!row || !withinWindow(row, opts.now ?? new Date())) return null;
  return { at: row.finished_at ?? row.claimed_at, verification: row.verification };
}
