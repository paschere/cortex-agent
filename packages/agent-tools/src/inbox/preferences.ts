import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The `user_preferences` row (migration 0043) that governs the daily digest.
 *
 * Every field that could cause Cortex to read a mailbox or send something
 * defaults to OFF. A missing row means "this person never opted in" — never
 * "use sensible defaults and go".
 */
export interface DigestPreferences {
  userId: string;
  /** Master opt-in. Nothing scheduled happens while this is false. */
  enabled: boolean;
  /** Local wall-clock delivery time, "HH:MM". */
  time: string;
  /** IANA zone the delivery time is expressed in. */
  timezone: string;
  deliverEmail: boolean;
  /** Post into a Google Chat SPACE, via the webhook below. Others can see it. */
  deliverChat: boolean;
  chatWebhookUrl: string | null;
  /**
   * Direct-message the person as the Cortex Chat app (migration 0045). Private
   * to them, and only possible once they have messaged the app — the DM space
   * is discovered then, not created by us.
   */
  deliverChatDm: boolean;
  /** Free text: "clients first, ignore newsletters". */
  digestFocus: string | null;
  /**
   * EL PARTE SEMANAL, Y LA ÚNICA PREFERENCIA DE ESTA TABLA QUE VIENE ENCENDIDA.
   *
   * El resto está apagado porque concede una CAPACIDAD sobre algo ajeno: que
   * Cortex lea el buzón de esta persona, que publique en su espacio de Chat.
   * Eso lo tiene que conceder su dueño, deliberadamente, desde la pantalla.
   *
   * El parte no lee nada de nadie. Es la empresa rindiéndole cuentas a quien
   * responde por ella, con datos que ese destinatario ya puede abrir en la
   * aplicación. Apagado por defecto significaría que el producto no reporta
   * nunca hasta que alguien descubra una casilla, que es la forma más cara
   * posible de no tener la funcionalidad. Ver la migración 0100, sección 4.
   *
   * Sólo se consulta para quienes son `org_admin`: nadie más lo recibe, esté
   * como esté esta columna.
   */
  weeklyReportEnabled: boolean;

  /**
   * Si Cortex puede INTERRUMPIR a esta persona cuando llegue al buzón algo que
   * lo merece (migración 0126). Apagado por defecto, y con más razón que el
   * resto: el resumen se lee cuando se puede, esto suena.
   */
  mailAlertsEnabled: boolean;
  /** Cuántos avisos como mucho en un día. 0 equivale a apagarlo. */
  mailAlertsMaxPerDay: number;
  /** La franja en la que se puede interrumpir, en `timezone`. */
  mailAlertsFrom: string;
  mailAlertsTo: string;
}

export const PREFERENCE_COLUMNS =
  'user_id, inbox_digest_enabled, inbox_digest_time, timezone, deliver_email, deliver_chat, chat_webhook_url, deliver_chat_dm, digest_focus, weekly_report_enabled, mail_alerts_enabled, mail_alerts_max_per_day, mail_alerts_from, mail_alerts_to';

export const DEFAULT_PREFERENCES: Omit<DigestPreferences, 'userId'> = {
  enabled: false,
  time: '07:30',
  timezone: 'America/Bogota',
  deliverEmail: true,
  deliverChat: false,
  chatWebhookUrl: null,
  deliverChatDm: false,
  digestFocus: null,
  weeklyReportEnabled: true,
  mailAlertsEnabled: false,
  mailAlertsMaxPerDay: 5,
  mailAlertsFrom: '07:00',
  mailAlertsTo: '21:00',
};

type PreferenceRow = Record<string, unknown>;

export function rowToPreferences(userId: string, row: PreferenceRow | null): DigestPreferences {
  if (!row) return { userId, ...DEFAULT_PREFERENCES };
  const str = (v: unknown, fallback: string | null): string | null => {
    if (typeof v !== 'string') return fallback;
    const t = v.trim();
    return t.length > 0 ? t : fallback;
  };
  return {
    userId,
    enabled: row.inbox_digest_enabled === true,
    time: str(row.inbox_digest_time, DEFAULT_PREFERENCES.time) ?? DEFAULT_PREFERENCES.time,
    timezone: str(row.timezone, DEFAULT_PREFERENCES.timezone) ?? DEFAULT_PREFERENCES.timezone,
    // NULL means "column default", which is true for email and false for chat.
    deliverEmail: row.deliver_email !== false,
    deliverChat: row.deliver_chat === true,
    chatWebhookUrl: str(row.chat_webhook_url, null),
    deliverChatDm: row.deliver_chat_dm === true,
    digestFocus: str(row.digest_focus, null),
    // NULL significa «el default de la columna», que aquí es true. Es la misma
    // lectura que `deliver_email` y por la misma razón: una fila escrita antes
    // de que la columna existiera no es una renuncia.
    weeklyReportEnabled: row.weekly_report_enabled !== false,
    // Éste sí es `=== true` y no `!== false`: una fila escrita antes de que la
    // columna existiera NO es un permiso para interrumpir a nadie. La
    // diferencia con las dos de arriba es deliberada y es la de siempre — nada
    // que moleste se enciende solo.
    mailAlertsEnabled: row.mail_alerts_enabled === true,
    mailAlertsMaxPerDay:
      typeof row.mail_alerts_max_per_day === 'number'
        ? row.mail_alerts_max_per_day
        : DEFAULT_PREFERENCES.mailAlertsMaxPerDay,
    mailAlertsFrom:
      str(row.mail_alerts_from, DEFAULT_PREFERENCES.mailAlertsFrom) ??
      DEFAULT_PREFERENCES.mailAlertsFrom,
    mailAlertsTo:
      str(row.mail_alerts_to, DEFAULT_PREFERENCES.mailAlertsTo) ?? DEFAULT_PREFERENCES.mailAlertsTo,
  };
}

/** Load one user's digest preferences. Never throws — a read failure reads as "not opted in". */
export async function loadDigestPreferences(
  db: SupabaseClient,
  userId: string,
): Promise<DigestPreferences> {
  const { data } = await db
    .from('user_preferences')
    .select(PREFERENCE_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();
  return rowToPreferences(userId, (data as PreferenceRow | null) ?? null);
}
