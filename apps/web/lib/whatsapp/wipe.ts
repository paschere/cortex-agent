import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * OLVIDAR LA SESIÓN DE WHATSAPP DE UNA EMPRESA (0068, 0189).
 *
 * Borra las credenciales y todas las llaves, y suelta el número para que quede
 * libre — aquí o en otra empresa. Los grupos y los números vinculados a
 * personas NO se tocan: son decisiones de gente, no de la conexión, y volver a
 * vincular no debería obligar a elegirlos otra vez.
 *
 * `db` tiene que ser el cliente CON ALCANCE de esa empresa.
 */

export type WipeReason = 'logged_out' | 'unlink' | 'phone_taken';

/** Lo que ve la empresa cuando conectó un número que ya es de otra. */
export const PHONE_TAKEN_ERROR =
  'Ese número ya está vinculado a otro espacio de trabajo en Cortex. Se desvinculó de aquí; vincula un número dedicado distinto.';

const WIPE: Record<WipeReason, { status: string; last_error: string | null }> = {
  // WhatsApp revocó el dispositivo.
  logged_out: {
    status: 'logged_out',
    last_error:
      'WhatsApp cerró la sesión de este dispositivo. Hay que volver a emparejar escaneando el código QR.',
  },
  // Un administrador pidió «Desvincular». No salió nada mal.
  unlink: { status: 'waiting', last_error: null },
  // El número es de otra empresa. `logged_out` para que la razón siga en
  // pantalla hasta que alguien vincule otro.
  phone_taken: { status: 'logged_out', last_error: PHONE_TAKEN_ERROR },
};

export function isWipeReason(value: unknown): value is WipeReason {
  return value === 'logged_out' || value === 'unlink' || value === 'phone_taken';
}

export async function wipeWhatsappSession(
  db: SupabaseClient,
  reason: WipeReason,
  now: Date = new Date(),
): Promise<{ error: string | null }> {
  const keys = await db.from('whatsapp_session_keys').delete().neq('key_type', '__none__');
  if (keys.error) return { error: keys.error.message };

  const { status, last_error } = WIPE[reason];
  const wiped = await db.from('whatsapp_sessions').upsert(
    {
      creds: null,
      status,
      phone_number: null,
      pairing_qr: null,
      pairing_qr_expires_at: null,
      pairing_code: null,
      pairing_code_expires_at: null,
      pairing_requested_at: null,
      pairing_phone: null,
      unlink_requested_at: null,
      last_error,
      updated_at: now.toISOString(),
    },
    { onConflict: 'organization_id' },
  );
  return { error: wiped.error ? wiped.error.message : null };
}
