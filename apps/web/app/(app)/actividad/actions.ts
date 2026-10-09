'use server';

import { undoActivityEvents } from '@/lib/activity/undo-run';
import { requireSession } from '@/lib/session';
import { revalidatePath } from 'next/cache';

export interface UndoResult {
  ok: boolean;
  message: string;
}

/**
 * «Deshacer» desde /actividad. Todo se vuelve a comprobar aquí: quién es, si
 * puede ver esas filas y si de verdad tienen una inversa (`undoPlanFor`); el
 * navegador sólo manda ids.
 */
export async function undoActivity(eventIds: string[]): Promise<UndoResult> {
  const user = await requireSession();
  if (!Array.isArray(eventIds) || eventIds.some((id) => typeof id !== 'string')) {
    return { ok: false, message: 'Petición no válida.' };
  }
  const outcomes = await undoActivityEvents(user, eventIds);
  revalidatePath('/actividad');
  if (outcomes.length === 0) return { ok: false, message: 'No hay nada que deshacer.' };
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length === 0) {
    return {
      ok: true,
      message: outcomes.length === 1 ? 'Listo, lo deshice.' : `Listo, deshice ${outcomes.length}.`,
    };
  }
  return {
    ok: false,
    message:
      outcomes.length === 1
        ? (failed[0]?.message ?? 'No se pudo deshacer.')
        : `Deshice ${outcomes.length - failed.length} de ${outcomes.length}. ${failed[0]?.message ?? ''}`.trim(),
  };
}
