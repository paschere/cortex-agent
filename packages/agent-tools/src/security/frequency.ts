/**
 * Trailing-hour frequency signal.
 *
 * One person legitimately reading a handful of payroll records looks nothing
 * like a model (or a compromised session) walking the whole roster. We count
 * the caller's sensitive-family tool calls in the last hour and, above the
 * `sensitive_reads_per_hour` policy value, add the `high-frequency` signal —
 * which bumps the call's risk one level in `classify()`.
 *
 * Two hard constraints:
 *   1. FAIL OPEN. A broken count query must never block a legitimate call.
 *   2. Cheap. A short-TTL in-memory cache keeps this off the hot path; the
 *      caller also skips it entirely for non-sensitive tools.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { SENSITIVE_FAMILIES } from './policy.js';

/** How long a per-user count is reused before we re-query. */
export const FREQUENCY_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  count: number;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test hook — drops the memoised counts. */
export function resetFrequencyCache(): void {
  cache.clear();
}

/**
 * Records a call we just made so the cached count keeps climbing without a
 * re-query. Cheap approximation: the next refresh re-reads the truth.
 */
export function noteSensitiveCall(userId: string): void {
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now()) hit.count += 1;
}

async function countSensitiveCalls(db: SupabaseClient, userId: string): Promise<number | null> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const orFilter = SENSITIVE_FAMILIES.map((f) => `tool_id.like.${f}.%`).join(',');
  try {
    const { count, error } = await db
      .from('audit_events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      // Sin las filas de intención (0118): una llamada con efectos deja
      // `attempted` + `ok`, y contarla dos veces inflaría esta señal.
      .neq('status', 'attempted')
      .gte('created_at', since)
      .or(orFilter);
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

export interface FrequencyResult {
  /** true when the caller is over the trailing-hour budget */
  highFrequency: boolean;
  /** calls counted in the window; null when unknown (query failed) */
  count: number | null;
}

/**
 * Sensitive-family call count for `userId` in the trailing hour, or null when
 * it cannot be determined. Never throws; served from cache when warm, so a
 * warm cache costs zero round-trips.
 */
export async function sensitiveCallCount(
  db: SupabaseClient,
  userId: string,
): Promise<number | null> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > now) return hit.count;

  const count = await countSensitiveCalls(db, userId);
  // Fail open: on error return null and don't poison the cache.
  if (count === null) return null;
  cache.set(userId, { count, expiresAt: now + FREQUENCY_CACHE_TTL_MS });
  return count;
}

/** True when `count` exceeds the per-hour budget. `perHour <= 0` disables. */
export function isHighFrequency(count: number | null, perHour: number): boolean {
  if (count === null) return false;
  if (!perHour || perHour <= 0) return false;
  return count > perHour;
}

/**
 * Convenience wrapper: count + threshold in one call. Never throws.
 */
export async function checkFrequency(
  db: SupabaseClient,
  userId: string,
  perHour: number,
): Promise<FrequencyResult> {
  if (!perHour || perHour <= 0) return { highFrequency: false, count: null };
  const count = await sensitiveCallCount(db, userId);
  return { highFrequency: isHighFrequency(count, perHour), count };
}
