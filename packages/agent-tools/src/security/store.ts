/**
 * Loads the tunable half of the risk model from `security_policies`.
 *
 * Thresholds live in the database so they can change without a deploy, but the
 * enforcement layer must keep working when the table is unreachable — so this
 * caches process-wide for a minute and FAILS OPEN to DEFAULT_POLICY.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_POLICY, type SecurityPolicy } from './policy.js';

export const POLICY_CACHE_TTL_MS = 60_000;

let cached: { policy: SecurityPolicy; expiresAt: number } | null = null;
let inflight: Promise<SecurityPolicy> | null = null;

/** Test hook. */
export function resetPolicyCache(): void {
  cached = null;
  inflight = null;
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true';
  return fallback;
}

function asNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function policyFromRows(rows: { key: string; value: unknown }[] | null): SecurityPolicy {
  const map = new Map((rows ?? []).map((r) => [r.key, r.value]));
  return {
    blockCritical: asBool(map.get('block_critical'), DEFAULT_POLICY.blockCritical),
    sensitiveReadsPerHour: asNumber(
      map.get('sensitive_reads_per_hour'),
      DEFAULT_POLICY.sensitiveReadsPerHour,
    ),
    externalSendRequiresConfirmation: asBool(
      map.get('external_send_requires_confirmation'),
      DEFAULT_POLICY.externalSendRequiresConfirmation,
    ),
  };
}

/**
 * Current policy. At most one round-trip per minute per process, and
 * concurrent callers share the in-flight request.
 */
export async function loadPolicy(db: SupabaseClient): Promise<SecurityPolicy> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.policy;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const { data, error } = await db.from('security_policies').select('key, value');
      if (error) return DEFAULT_POLICY;
      const policy = policyFromRows(data as { key: string; value: unknown }[] | null);
      cached = { policy, expiresAt: Date.now() + POLICY_CACHE_TTL_MS };
      return policy;
    } catch {
      return DEFAULT_POLICY;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
