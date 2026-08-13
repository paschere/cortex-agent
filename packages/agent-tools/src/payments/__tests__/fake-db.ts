import type { SupabaseClient } from '@supabase/supabase-js';
import { type Tables, createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';

/**
 * El esquema de pagos, como doble de prueba.
 *
 * Misma postura que `documents/__tests__/fake-db.ts`, y por las mismas dos
 * razones — el doble tiene que dar lo que da Postgres, o los tests ejercitarían
 * una forma que el código real nunca ve:
 *
 *   VALORES POR DEFECTO. Una fila escrita por `writePayment` no trae id, ni
 *   created_at, ni `state`, ni `source_count`.
 *
 *   ÍNDICES ÚNICOS. "Reimportar Siigo es un no-op" lo garantiza LA BASE DE
 *   DATOS con `payment_reports_source_once_idx`, no un `if (!exists)` en la
 *   aplicación — que es justo el punto, porque dos importaciones pueden correr
 *   a la vez. Un doble que dejara pasar el segundo INSERT haría que el test de
 *   idempotencia pasara probando una garantía que daba el propio doble.
 *
 * El índice se replica con la semántica NULLS NOT DISTINCT de la 0098: un
 * `source_system` nulo cuenta como valor y choca con otro nulo, que es lo que
 * protege a los reportes manuales y de comprobante.
 *
 * Una violación se reporta como la reporta PostgREST, `code: '23505'`.
 */

type Row = Record<string, unknown>;

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${String(++seq).padStart(4, '0')}`;

const NOW = '2026-08-13T12:00:00Z';

const DEFAULTS: Record<string, () => Row> = {
  payments: () => ({
    id: nextId('pay'),
    kind: 'payment',
    client_id: null,
    client_nit: null,
    client_match_state: 'no_nit',
    extraction_id: null,
    invoice_number: null,
    state: 'reported',
    source_count: 1,
    disputed_at: null,
    dispute_note: null,
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    created_at: NOW,
    updated_at: NOW,
  }),
  payment_reports: () => ({
    id: nextId('rep'),
    payment_id: null,
    kind: 'payment',
    client_id: null,
    client_nit: null,
    client_match_state: 'no_nit',
    extraction_id: null,
    invoice_number: null,
    reference: null,
    note: null,
    source_system: null,
    source_read_at: null,
    source_user_id: null,
    source_document_id: null,
    source_chunk_id: null,
    source_quote: null,
    source_ref: null,
    created_by: null,
    created_at: NOW,
  }),
  document_extractions: () => ({
    id: nextId('ext'),
    doc_type: null,
    client_id: null,
    client_nit: null,
    client_match_state: 'no_nit',
    review_state: 'pending',
    doc_number: null,
    counterparty_nit: null,
    counterparty_name: null,
    total_amount: null,
    tax_amount: null,
    currency: null,
    issued_on: null,
    due_on: null,
    created_at: NOW,
    updated_at: NOW,
  }),
};

/**
 * El índice único de la 0098, con la parcialidad y la semántica de nulos que
 * declara: sólo aplica a las filas que traen `source_ref`.
 */
interface UniqueIndex {
  columns: string[];
  /** La fila entra en el índice sólo si estas columnas no son nulas. */
  requires: string[];
}

const UNIQUE: Record<string, UniqueIndex[]> = {
  payment_reports: [
    {
      columns: ['organization_id', 'source_kind', 'source_system', 'source_ref'],
      requires: ['source_ref'],
    },
  ],
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
  for (const method of ['select', 'single', 'maybeSingle', 'eq', 'in', 'is', 'order', 'limit']) {
    builder[method] = () => builder;
  }
  return builder;
}

export interface PaymentsWorld {
  tables: Tables;
  db: SupabaseClient;
  scopedFor(organizationId: string): SupabaseClient;
}

export function createPaymentsWorld(seed: Tables, organizationId: string): PaymentsWorld {
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
                for (const index of indexes ?? []) {
                  if (index.requires.some((c) => row[c] == null)) continue;
                  const clash = (tables[table] ?? []).some((existing) =>
                    // NULLS NOT DISTINCT: un nulo choca con otro nulo.
                    index.columns.every((c) => (existing[c] ?? null) === (row[c] ?? null)),
                  );
                  if (clash) return violation(index.columns);
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
