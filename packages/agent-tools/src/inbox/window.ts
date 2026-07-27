import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Time-zone arithmetic for "is this person's digest due right now?".
 *
 * The scheduled routine runs every half hour in UTC and each person picks a
 * local wall-clock time, so the matching has to happen per user, in their own
 * zone. `Intl.DateTimeFormat` is the whole implementation — it already knows
 * every zone and every DST rule, and no dependency does it better.
 */

export const DELIVERY_TOOL_ID = 'inbox.deliver_digest';

interface LocalParts {
  hour: number;
  minute: number;
  second: number;
}

function localParts(timezone: string, now: Date): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return { hour: get('hour') % 24, minute: get('minute'), second: get('second') };
}

/** Minutes since local midnight, or null when the zone is unusable. */
export function localMinutesOfDay(timezone: string, now = new Date()): number | null {
  try {
    const p = localParts(timezone, now);
    return p.hour * 60 + p.minute;
  } catch {
    return null;
  }
}

/** "HH:MM" → minutes since midnight, or null when malformed. */
export function parseHHMM(value: string): number | null {
  const m = value.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Is `target` inside the window that ENDS now and is `windowMinutes` long?
 * Half-open on purpose — [now - window, now] — so consecutive runs of the same
 * cron cover every minute exactly once and never twice.
 */
export function isWithinWindow(
  targetMinutes: number,
  nowMinutes: number,
  windowMinutes: number,
): boolean {
  const delta = (nowMinutes - targetMinutes + 1440) % 1440;
  return delta < windowMinutes;
}

/** Start of today in `timezone`, as a UTC instant. */
export function startOfLocalDay(timezone: string, now = new Date()): Date {
  try {
    const p = localParts(timezone, now);
    const elapsedMs = p.hour * 3_600_000 + p.minute * 60_000 + p.second * 1000;
    return new Date(now.getTime() - elapsedMs);
  } catch {
    return new Date(now.getTime() - 86_400_000);
  }
}

/**
 * Has this person already had today's digest?
 *
 * The marker is the audit row `inbox.deliver_digest` writes under THEIR user
 * id after a successful delivery — so the every-30-minutes routine is safely
 * re-runnable without a bookkeeping table of its own. A failed read reads as
 * "not yet", because a missing digest is a smaller problem than a duplicate
 * being silently suppressed by an outage.
 */
export async function hasDigestToday(
  db: SupabaseClient,
  userId: string,
  timezone: string,
  now = new Date(),
): Promise<boolean> {
  const { data, error } = await db
    .from('audit_events')
    .select('id')
    .eq('user_id', userId)
    .eq('tool_id', DELIVERY_TOOL_ID)
    .eq('status', 'ok')
    .gte('created_at', startOfLocalDay(timezone, now).toISOString())
    .limit(1);
  if (error) return false;
  return (data ?? []).length > 0;
}
