import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The `user_preferences` row (migration 0043) that governs the daily digest.
 *
 * Every field that could cause Zippy to read a mailbox or send something
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
   * Direct-message the person as the Zippy Chat app (migration 0045). Private
   * to them, and only possible once they have messaged the app — the DM space
   * is discovered then, not created by us.
   */
  deliverChatDm: boolean;
  /** Free text: "clients first, ignore newsletters". */
  digestFocus: string | null;
}

export const PREFERENCE_COLUMNS =
  'user_id, inbox_digest_enabled, inbox_digest_time, timezone, deliver_email, deliver_chat, chat_webhook_url, deliver_chat_dm, digest_focus';

export const DEFAULT_PREFERENCES: Omit<DigestPreferences, 'userId'> = {
  enabled: false,
  time: '07:30',
  timezone: 'America/Bogota',
  deliverEmail: true,
  deliverChat: false,
  chatWebhookUrl: null,
  deliverChatDm: false,
  digestFocus: null,
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
