import type { SupabaseClient } from '@supabase/supabase-js';
import { type Tables, createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';

/**
 * Las tablas de 0184 y las de 0069 que tocan, como doble de prueba.
 *
 * Mismo molde que `commitments/__tests__/fake-db.ts`: el doble pone lo que
 * pone Postgres — los valores por defecto y los ÍNDICES ÚNICOS — porque la
 * idempotencia de este módulo descansa en ellos (una lectura por documento,
 * tipo y sujeto; un vencimiento por vehículo, tipo y fecha).
 */

type Row = Record<string, unknown>;

let seq = 0;
const nextId = (prefix: string) => `${prefix}-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const NOW = '2026-10-03T12:00:00Z';

const subjectKey = (s: unknown) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

const DEFAULTS: Record<string, (row: Row) => Row> = {
  document_expirations: (row) => ({
    id: nextId('dexp'),
    document_id: null,
    chunk_id: null,
    space_id: null,
    source: 'documento',
    subject_kind: 'empresa',
    subject: null,
    // La columna generada de 0184.
    subject_key: subjectKey(row.subject),
    vehicle_id: null,
    client_id: null,
    issuer: null,
    number: null,
    issued_on: null,
    expires_on: null,
    issued_quote: null,
    expires_quote: null,
    renewal_lead_days: 30,
    owner_user_id: null,
    status: 'vigente',
    confidence: 'baja',
    needs_review: true,
    review_note: null,
    confirmed_by: null,
    confirmed_at: null,
    commitment_id: null,
    renewed_by_id: null,
    renewed_at: null,
    dismissed_reason: null,
    model_id: null,
    extractor_version: null,
    created_by: null,
    created_at: NOW,
    updated_at: NOW,
  }),
  document_expiration_scans: () => ({
    id: nextId('dscn'),
    outcome: 'queued',
    model_called: false,
    detail: null,
    renews_expiration_id: null,
    extractor_version: null,
    scanned_at: null,
    created_at: NOW,
    updated_at: NOW,
  }),
  commitments: () => ({
    id: nextId('cmmt'),
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
    vehicle_id: null,
    client_id: null,
    recurrence: 'none',
    series_id: nextId('seri'),
    previous_commitment_id: null,
    calendar_event_id: null,
    calendar_id: null,
    calendar_user_id: null,
    calendar_synced_due_on: null,
    calendar_error: null,
    created_by: null,
    created_at: NOW,
    updated_at: NOW,
  }),
};

const UNIQUE: Record<string, string[][]> = {
  document_expirations: [['organization_id', 'document_id', 'kind', 'subject_key']],
  document_expiration_scans: [['organization_id', 'document_id']],
  commitments: [['previous_commitment_id'], ['organization_id', 'vehicle_id', 'kind', 'due_on']],
};

function violation(columns: string[]) {
  const result = {
    data: null,
    error: { code: '23505', message: `duplicate key on (${columns.join(', ')})` },
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

export interface World {
  tables: Tables;
  db: SupabaseClient;
}

export function createWorld(seed: Tables, organizationId: string): World {
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
            if (method !== 'insert') {
              return typeof value === 'function' ? value.bind(builder) : value;
            }
            return (values: Row | Row[], ...rest: unknown[]) => {
              const incoming = (Array.isArray(values) ? values : [values]).map((row) => ({
                ...(defaults ? defaults(row) : {}),
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
  return { tables, db: createOrgScopedClient(layered, organizationId) };
}
