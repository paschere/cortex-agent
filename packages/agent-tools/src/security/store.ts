/**
 * Loads the tunable half of the risk model from `security_policies`.
 *
 * Thresholds live in the database so they can change without a deploy, but the
 * enforcement layer must keep working when the table is unreachable — so this
 * caches per organization for a minute and FAILS OPEN to DEFAULT_POLICY.
 *
 * Per organization, not per process: desde la migración 0064 la tabla es por
 * tenant, y un caché de una sola celda le serviría al tenant B la política del
 * tenant A durante un minuto. El `db` que llega ya viene acotado por RLS; la
 * clave del caché es lo único que faltaba.
 *
 * La misma consulta trae también la política CEL (`action_policy`, ver
 * action-policy.ts): una key más de la misma tabla, cero round-trips extra.
 */

import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type ActionPolicy, parseActionPolicy } from './action-policy.js';
import { DEFAULT_POLICY, type SecurityPolicy } from './policy.js';

export const POLICY_CACHE_TTL_MS = 60_000;

interface CachedConfig {
  policy: SecurityPolicy;
  actionPolicy: ActionPolicy | null;
  expiresAt: number;
}

const cache = new Map<string, CachedConfig>();
const inflight = new Map<string, Promise<CachedConfig>>();

/** Un `db` sin tenant conocido (tests, jobs viejos) cae en una celda propia. */
const NO_ORG = '__no_org__';

/** Test hook. */
export function resetPolicyCache(): void {
  cache.clear();
  inflight.clear();
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
 * La política CEL del tenant, o null si no ha escrito una — null apaga el motor
 * entero, que es la compatibilidad hacia atrás: todo workspace existente sigue
 * exactamente igual hasta que alguien escribe su primera regla.
 *
 * Una fila malformada también es null, y ruidosa: mejor un motor apagado que
 * uno aplicando una política distinta de la que el administrador cree que
 * escribió. (`parseActionPolicy` rechaza en la escritura; esto solo puede pasar
 * si alguien editó la fila por SQL.)
 */
export function actionPolicyFromRows(
  rows: { key: string; value: unknown }[] | null,
): ActionPolicy | null {
  const row = (rows ?? []).find((r) => r.key === 'action_policy');
  if (!row) return null;
  const parsed = parseActionPolicy(row.value);
  if (!parsed.ok) {
    logger.error({ error: parsed.error }, 'security: stored action_policy is malformed, ignoring');
    return null;
  }
  return parsed.policy;
}

async function loadConfig(db: SupabaseClient, organizationId?: string): Promise<CachedConfig> {
  const key = organizationId ?? NO_ORG;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;

  const fetch = (async () => {
    try {
      const { data, error } = await db.from('security_policies').select('key, value');
      if (error) return { policy: DEFAULT_POLICY, actionPolicy: null, expiresAt: 0 };
      const rows = data as { key: string; value: unknown }[] | null;
      const config: CachedConfig = {
        policy: policyFromRows(rows),
        actionPolicy: actionPolicyFromRows(rows),
        expiresAt: Date.now() + POLICY_CACHE_TTL_MS,
      };
      cache.set(key, config);
      return config;
    } catch {
      return { policy: DEFAULT_POLICY, actionPolicy: null, expiresAt: 0 };
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, fetch);
  return fetch;
}

/**
 * Current policy. At most one round-trip per minute per organization per
 * process, and concurrent callers share the in-flight request.
 */
export async function loadPolicy(
  db: SupabaseClient,
  organizationId?: string,
): Promise<SecurityPolicy> {
  return (await loadConfig(db, organizationId)).policy;
}

/** La política CEL vigente del tenant, del mismo caché que `loadPolicy`. */
export async function loadActionPolicy(
  db: SupabaseClient,
  organizationId?: string,
): Promise<ActionPolicy | null> {
  return (await loadConfig(db, organizationId)).actionPolicy;
}
