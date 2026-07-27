import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type DeliveryClaimRow,
  type DeliveryLedger,
  type DeliverySettlement,
  PG_UNIQUE_VIOLATION,
  claimDelivery,
  isUniqueViolation,
} from './claim';

/**
 * A ledger that behaves like the real table: `unique (source, event_key)` is a
 * database constraint, so the second insert of the same key FAILS rather than
 * being skipped by a prior read. Modelling it this way is the point — an
 * implementation that read-then-inserted would pass a test built on a Map and
 * still double-fire in production.
 */
function fakeLedger() {
  const keys = new Set<string>();
  const rows = new Map<string, DeliveryClaimRow & { settlement?: DeliverySettlement }>();
  let n = 0;
  const ledger: DeliveryLedger = {
    async insert(row) {
      const key = `${row.source}:${row.eventKey}`;
      if (keys.has(key)) {
        return {
          id: null,
          error: {
            code: PG_UNIQUE_VIOLATION,
            message:
              'duplicate key value violates unique constraint "dev_task_events_source_event_key_key"',
          },
        };
      }
      keys.add(key);
      const id = `delivery-${++n}`;
      rows.set(id, { ...row });
      return { id, error: null };
    },
    async settle(id, settlement) {
      const row = rows.get(id);
      if (row) row.settlement = settlement;
    },
    async release(id) {
      const row = rows.get(id);
      if (row) {
        keys.delete(`${row.source}:${row.eventKey}`);
        rows.delete(id);
      }
    },
  };
  return { ledger, rows, size: () => keys.size };
}

const delivery: DeliveryClaimRow = {
  source: 'linear',
  eventKey: 'a'.repeat(64),
  externalId: 'issue-uuid',
  action: 'update',
};

describe('isUniqueViolation', () => {
  it('recognises only Postgres 23505', () => {
    expect(isUniqueViolation({ code: '23505', message: 'duplicate key' })).toBe(true);
    expect(isUniqueViolation({ code: '23503', message: 'foreign key' })).toBe(false);
    expect(isUniqueViolation({ message: 'connection reset' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});

describe('claimDelivery — one run per Linear delivery', () => {
  it('claims a delivery it has never seen', async () => {
    const { ledger } = fakeLedger();
    const result = await claimDelivery(ledger, delivery);
    expect(result).toEqual({ claimed: true, deliveryId: 'delivery-1' });
  });

  it('refuses the same delivery on retry, however many times Linear sends it', async () => {
    const { ledger, size } = fakeLedger();
    const first = await claimDelivery(ledger, delivery);
    expect(first.claimed).toBe(true);

    for (let i = 0; i < 5; i++) {
      expect(await claimDelivery(ledger, delivery)).toEqual({
        claimed: false,
        reason: 'duplicate',
      });
    }
    expect(size()).toBe(1);
  });

  it('lets exactly one of several concurrent retries through', async () => {
    const { ledger } = fakeLedger();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimDelivery(ledger, delivery)),
    );
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results.filter((r) => !r.claimed)).toHaveLength(7);
  });

  it('treats a different event on the same issue as a new delivery', async () => {
    const { ledger } = fakeLedger();
    await claimDelivery(ledger, delivery);
    const second = await claimDelivery(ledger, { ...delivery, eventKey: 'b'.repeat(64) });
    expect(second.claimed).toBe(true);
  });

  it('lets Linear retry after a released claim, so a real failure is not swallowed', async () => {
    const { ledger } = fakeLedger();
    const first = await claimDelivery(ledger, delivery);
    if (!first.claimed) throw new Error('expected the first claim to succeed');
    await ledger.release(first.deliveryId);
    expect((await claimDelivery(ledger, delivery)).claimed).toBe(true);
  });

  it('throws — rather than silently dropping the event — on any other database error', async () => {
    const broken: DeliveryLedger = {
      async insert() {
        return { id: null, error: { code: '08006', message: 'connection failure' } };
      },
      async settle() {},
      async release() {},
    };
    await expect(claimDelivery(broken, delivery)).rejects.toThrow(/connection failure/);
  });
});

/**
 * The rule above is only as good as the constraint behind it. If somebody drops
 * the unique index, every test above still passes and production quietly starts
 * running each issue twice — so the schema is asserted directly.
 */
describe('migration 0046 enforces idempotency in the database', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const sql = readFileSync(
    join(here, '../../../../infra/supabase/migrations/0046_dev_tasks.sql'),
    'utf8',
  ).toLowerCase();

  it('makes (source, event_key) unique on dev_task_events', () => {
    expect(sql).toMatch(/unique\s*\(\s*source\s*,\s*event_key\s*\)/);
  });

  it('allows at most one open dev_task per issue', () => {
    expect(sql).toMatch(
      /create unique index[\s\S]*?on public\.dev_tasks \(source, external_id\)[\s\S]*?where status in \('queued', 'running', 'needs_review'\)/,
    );
  });
});
