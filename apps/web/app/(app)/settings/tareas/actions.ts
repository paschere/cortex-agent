'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { loadIntakePrefs, saveIntakePrefs } from '@/lib/task-intake/create';
import { sanitizeIntakePrefs } from '@/lib/task-intake/shape';
import { revalidatePath } from 'next/cache';

/**
 * Guarda cómo ESTA persona acepta pedir tareas por correo y por WhatsApp. Cada
 * export es un endpoint al que llega cualquiera con sesión: sólo escribe la fila
 * de quien llama (el id sale de la sesión, nunca del cuerpo).
 */
export async function saveIntakePrefsAction(
  input: unknown,
): Promise<{ ok: boolean; note: string }> {
  const user = await requireSession();
  const prefs = sanitizeIntakePrefs(input);
  if (!prefs) {
    return { ok: false, note: 'La palabra de WhatsApp debe ser una sola, de 3 a 20 letras.' };
  }
  try {
    const db = getOrgScopedClient(user.organization.id);
    await saveIntakePrefs(db, user.id, prefs);
    await db
      .from('audit_events')
      .insert({
        user_id: user.id,
        tool_id: 'task.intake_prefs',
        input_hash: user.id,
        status: 'ok',
        latency_ms: 0,
        metadata: { email: prefs.emailEnabled, whatsapp: prefs.whatsappEnabled },
      })
      .then(undefined, () => undefined);
    revalidatePath('/settings/tareas');
    return { ok: true, note: 'Listo. Quedó guardado.' };
  } catch {
    return { ok: false, note: 'No se pudo guardar. Intenta de nuevo.' };
  }
}

export async function readIntakePrefsAction() {
  const user = await requireSession();
  return loadIntakePrefs(getOrgScopedClient(user.organization.id), user.id);
}
