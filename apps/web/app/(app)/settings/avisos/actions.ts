'use server';

import {
  loadPreferencesFor,
  sanitizePreferencesInput,
  savePreferences,
} from '@/lib/notifications/preferences';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { revalidatePath } from 'next/cache';

/**
 * Guarda los avisos de ESTA persona. Cada export es un endpoint que cualquiera
 * con sesión puede llamar: sólo escribe la fila de quien llama (el id sale de la
 * sesión, nunca del cuerpo) y descarta lo que no reconoce.
 */
export async function savePreferencesAction(
  input: unknown,
): Promise<{ ok: boolean; note: string }> {
  const user = await requireSession();
  const prefs = sanitizePreferencesInput(input);
  if (!prefs) return { ok: false, note: 'Las horas de silencio no tienen un formato válido.' };
  try {
    const db = getOrgScopedClient(user.organization.id);
    await savePreferences(db, user.id, prefs);
    revalidatePath('/settings/avisos');
    return { ok: true, note: 'Listo. Tus avisos quedaron así.' };
  } catch (err) {
    const text = err instanceof Error ? err.message : '';
    return {
      ok: false,
      note: text && text.length < 300 ? text : 'No se pudo guardar. Intenta de nuevo.',
    };
  }
}

/** Las de esta persona, para repintar la pantalla. */
export async function readPreferencesAction() {
  const user = await requireSession();
  return loadPreferencesFor(getOrgScopedClient(user.organization.id), user.id);
}
