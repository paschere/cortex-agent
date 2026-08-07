import type { SupabaseClient } from '@supabase/supabase-js';
import { type Tables, createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';

/**
 * The extraction schema, as a test double.
 *
 * Same posture as `commitments/__tests__/fake-db.ts`, and for the same two
 * reasons — the fake has to supply what Postgres supplies, or the tests would
 * exercise a shape the real code never sees:
 *
 *   COLUMN DEFAULTS. A row written by `saveReading` has no id, no created_at
 *   and no review_state on its fields.
 *
 *   UNIQUE INDEXES. "One reading per document" and "one row per field" are
 *   guaranteed by the DATABASE in migration 0076, not by an `if (!exists)` in
 *   application code — which is the point, since two ingestion retries can run
 *   at once. A fake that let the second insert through would make the
 *   idempotence tests pass while testing a guarantee the fake was providing.
 *
 * A violation is reported as PostgREST reports one, `code: '23505'`.
 */

type Row = Record<string, unknown>;

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${String(++seq).padStart(4, '0')}`;

const NOW = '2026-08-06T12:00:00Z';

const DEFAULTS: Record<string, () => Row> = {
  document_extractions: () => ({
    id: nextId('ext'),
    doc_type: null,
    classification_quote: null,
    classification_chunk_id: null,
    unclassified_reason: null,
    client_id: null,
    client_nit: null,
    client_match_state: 'no_nit',
    review_state: 'pending',
    confirmed_at: null,
    confirmed_by: null,
    rejected_at: null,
    rejected_by: null,
    doc_number: null,
    counterparty_nit: null,
    counterparty_name: null,
    total_amount: null,
    tax_amount: null,
    currency: null,
    issued_on: null,
    due_on: null,
    extractor_version: 'v1',
    model_id: null,
    created_by: null,
    error_message: null,
    created_at: NOW,
    updated_at: NOW,
  }),
  document_fields: () => ({
    id: nextId('fld'),
    value_text: null,
    value_number: null,
    value_date: null,
    currency: null,
    chunk_id: null,
    review_state: 'pending',
    confirmed_at: null,
    confirmed_by: null,
    rejected_at: null,
    rejected_by: null,
    corrected_text: null,
    corrected_number: null,
    corrected_date: null,
    corrected_currency: null,
    created_at: NOW,
    updated_at: NOW,
  }),
  document_field_corrections: () => ({
    id: nextId('cor'),
    field_id: null,
    extraction_id: null,
    doc_type: null,
    proposed_display: null,
    corrected_display: null,
    outcome: 'corrected',
    corrected_by: null,
    corrected_at: NOW,
  }),
};

/** The unique indexes from migration 0076 that the code depends on. */
const UNIQUE: Record<string, string[][]> = {
  document_extractions: [['organization_id', 'document_id']],
  document_fields: [['extraction_id', 'field_key']],
};

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
  for (const method of ['select', 'single', 'maybeSingle', 'eq', 'in', 'order', 'limit']) {
    builder[method] = () => builder;
  }
  return builder;
}

export interface DocumentsWorld {
  tables: Tables;
  db: SupabaseClient;
  scopedFor(organizationId: string): SupabaseClient;
}

export function createDocumentsWorld(seed: Tables, organizationId: string): DocumentsWorld {
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
