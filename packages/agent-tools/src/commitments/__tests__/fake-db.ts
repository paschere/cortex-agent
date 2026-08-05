import type { SupabaseClient } from '@supabase/supabase-js';
import { type Tables, createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';

/**
 * The commitments schema, as a test double.
 *
 * `fake-postgrest.ts` executes filters over plain objects, which is most of
 * what is needed. Two things it does not do are exactly the two things this
 * module's guarantees rest on, so they are added here rather than asserted
 * around:
 *
 *   COLUMN DEFAULTS. A row created by `createCommitment` has no id, no
 *   series_id and no created_at, because Postgres supplies them. Without them
 *   every test would be exercising a shape the real code never sees.
 *
 *   UNIQUE INDEXES. Migration 0069 makes "one notice per occurrence" and "one
 *   successor per occurrence" impossible in the DATABASE, not in application
 *   code — that is the whole point, since a retried job and two concurrent
 *   watcher runs both get past any `if (!exists)` check. A fake that let the
 *   second insert through would turn the idempotence tests into theatre: they
 *   would pass while testing a guarantee the fake was providing for free.
 *
 * A violation is reported the way PostgREST reports one — `code: '23505'` —
 * because `isUniqueViolation` reads that code, and a fake that failed
 * differently would be testing a different branch.
 */

type Row = Record<string, unknown>;

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${String(++seq).padStart(4, '0')}`;

const DEFAULTS: Record<string, () => Row> = {
  commitments: () => ({
    id: nextId('cmt'),
    detail: null,
    counterparty: null,
    amount_cop: null,
    notice_days: 15,
    state: 'in_force',
    met_at: null,
    met_by: null,
    met_note: null,
    dropped_at: null,
    dropped_reason: null,
    owner_user_id: null,
    escalate_to_user_id: null,
    escalate_after_days: 3,
    source_system: null,
    source_read_at: null,
    source_user_id: null,
    source_document_id: null,
    source_chunk_id: null,
    source_quote: null,
    review_state: 'confirmed',
    confirmed_at: null,
    confirmed_by: null,
    rejected_at: null,
    rejected_by: null,
    vehicle_id: null,
    recurrence: 'none',
    series_id: nextId('ser'),
    previous_commitment_id: null,
    calendar_event_id: null,
    calendar_id: null,
    calendar_user_id: null,
    calendar_synced_due_on: null,
    calendar_error: null,
    created_by: null,
    created_at: '2026-08-04T12:00:00Z',
    updated_at: '2026-08-04T12:00:00Z',
  }),
  commitment_notices: () => ({
    id: nextId('ntc'),
    channel: 'email',
    recipient_user_id: null,
    recipient_email: null,
    delivered: false,
    delivery_note: null,
    acknowledged_at: null,
    acknowledged_by: null,
    created_at: '2026-08-04T12:00:00Z',
  }),
};

/** The unique indexes from migration 0069 that the code depends on. */
const UNIQUE: Record<string, string[][]> = {
  commitments: [['previous_commitment_id'], ['organization_id', 'vehicle_id', 'kind', 'due_on']],
  commitment_notices: [['commitment_id', 'notice_kind', 'due_on']],
};

/** A builder that refuses, however far the caller chains it. */
function violation(columns: string[]) {
  const result = {
    data: null,
    error: {
      code: '23505',
      message: `duplicate key value violates unique constraint on (${columns.join(', ')})`,
    },
  };
  const builder: Record<string, unknown> = {
    // biome-ignore lint/suspicious/noThenProperty: mirrors PostgrestBuilder's thenable shape
    then: (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled),
  };
  for (const method of ['select', 'single', 'maybeSingle', 'eq', 'order', 'limit']) {
    builder[method] = () => builder;
  }
  return builder;
}

export interface CommitmentsWorld {
  tables: Tables;
  /** A workspace-scoped handle, the same wrapper production uses. */
  db: SupabaseClient;
  scopedFor(organizationId: string): SupabaseClient;
}

export function createCommitmentsWorld(seed: Tables, organizationId: string): CommitmentsWorld {
  const fake = createFakeSupabase(seed);
  const tables = fake.tables;

  const layered = new Proxy(fake.client as unknown as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop !== 'from') {
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (table: string) => {
        // biome-ignore lint/suspicious/noExplicitAny: proxying a builder chain
        const qb = (fake.client as any).from(table);
        const defaults = DEFAULTS[table];
        const indexes = UNIQUE[table];
        if (!defaults && !indexes) return qb;

        return new Proxy(qb, {
          get(builder, method) {
            const value = Reflect.get(builder, method, builder);
            if (method !== 'insert' && method !== 'upsert') {
              return typeof value === 'function' ? value.bind(builder) : value;
            }
            return (values: Row | Row[], ...rest: unknown[]) => {
              const incoming = (Array.isArray(values) ? values : [values]).map((row) => ({
                ...(defaults ? defaults() : {}),
                ...row,
              }));
              for (const row of incoming) {
                for (const columns of indexes ?? []) {
                  // A partial index over nullable columns does not constrain
                  // rows where the column is null — same as Postgres.
                  if (columns.some((c) => row[c] == null)) continue;
                  const clash = (tables[table] ?? []).some((existing) =>
                    columns.every((c) => existing[c] === row[c]),
                  );
                  if (clash) return violation(columns);
                }
              }
              return (value as (v: unknown, ...r: unknown[]) => unknown).apply(builder, [
                Array.isArray(values) ? incoming : incoming[0],
                ...rest,
              ]);
            };
          },
          // biome-ignore lint/suspicious/noExplicitAny: proxying a builder chain
        }) as any;
      };
    },
  }) as unknown as SupabaseClient;

  return {
    tables,
    db: createOrgScopedClient(layered, organizationId),
    scopedFor: (org: string) => createOrgScopedClient(layered, org),
  };
}
