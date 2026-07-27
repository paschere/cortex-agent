import type { SupabaseClient } from '@supabase/supabase-js';
import type { DevTaskSource } from './contract';

/**
 * Idempotency for inbound Linear deliveries.
 *
 * Linear retries a webhook that does not answer 2xx, and it retries on a timer
 * regardless of whether we were slow or genuinely broken. Without a claim, a
 * single assignment could start three runs against the same repository.
 *
 * The rule is enforced by the DATABASE, not by this file: `dev_task_events` has
 * `unique (source, event_key)` (migration 0046). Every delivery INSERTs its
 * claim row first; the loser of that race gets Postgres error 23505 and is
 * answered 200 without doing any work. Code that "checks then inserts" would
 * still double-fire under concurrent retries — two requests can both see an
 * empty table — so the check IS the insert.
 *
 * Failure handling is the other half. A claim that is taken but never settled
 * would swallow the retry of a delivery we genuinely failed to process, so the
 * route releases (deletes) its claim on any error before returning 5xx. That
 * makes the sequence: claim → work → settle, or claim → fail → release.
 */

export const PG_UNIQUE_VIOLATION = '23505';

export interface LedgerError {
  code?: string | null;
  message: string;
}

export function isUniqueViolation(error: LedgerError | null | undefined): boolean {
  return error?.code === PG_UNIQUE_VIOLATION;
}

export type DeliveryOutcome = 'received' | 'accepted' | 'ignored' | 'rejected';

export interface DeliveryClaimRow {
  source: DevTaskSource;
  eventKey: string;
  externalId: string | null;
  action: string | null;
}

export interface DeliverySettlement {
  outcome: Exclude<DeliveryOutcome, 'received'>;
  taskId?: string | null;
  reason?: string | null;
}

/**
 * The three operations the claim protocol needs. Narrow on purpose: it is what
 * lets the idempotency rule be tested against a fake that models the unique
 * constraint, without a live Postgres.
 */
export interface DeliveryLedger {
  insert(row: DeliveryClaimRow): Promise<{ id: string | null; error: LedgerError | null }>;
  settle(id: string, settlement: DeliverySettlement): Promise<void>;
  release(id: string): Promise<void>;
}

export type ClaimResult =
  | { claimed: true; deliveryId: string }
  | { claimed: false; reason: 'duplicate' };

/**
 * Take the claim for one delivery.
 *
 * Returns `{ claimed: false }` for a retry of something already seen — the
 * caller must answer 2xx and do nothing. Any other database error is thrown:
 * the caller should return 5xx so Linear retries, because at that point we do
 * not know whether the work was done.
 */
export async function claimDelivery(
  ledger: DeliveryLedger,
  row: DeliveryClaimRow,
): Promise<ClaimResult> {
  const { id, error } = await ledger.insert(row);
  if (isUniqueViolation(error)) return { claimed: false, reason: 'duplicate' };
  if (error) throw new Error(`Could not claim delivery: ${error.message}`);
  if (!id) throw new Error('Could not claim delivery: insert returned no id');
  return { claimed: true, deliveryId: id };
}

/** Supabase-backed ledger. */
export function supabaseDeliveryLedger(db: SupabaseClient): DeliveryLedger {
  return {
    async insert(row) {
      const { data, error } = await db
        .from('dev_task_events')
        .insert({
          source: row.source,
          event_key: row.eventKey,
          external_id: row.externalId,
          action: row.action,
          outcome: 'received',
        })
        .select('id')
        .single();
      return {
        id: (data?.id as string | undefined) ?? null,
        error: error ? { code: error.code, message: error.message } : null,
      };
    },
    async settle(id, settlement) {
      await db
        .from('dev_task_events')
        .update({
          outcome: settlement.outcome,
          task_id: settlement.taskId ?? null,
          reason: settlement.reason ?? null,
        })
        .eq('id', id);
    },
    async release(id) {
      await db.from('dev_task_events').delete().eq('id', id);
    },
  };
}
