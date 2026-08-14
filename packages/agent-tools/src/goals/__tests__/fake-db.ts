import type { SupabaseClient } from '@supabase/supabase-js';
import { type Tables, createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';

/**
 * El esquema de metas, como doble de prueba.
 *
 * Misma postura que `payments/__tests__/fake-db.ts`, y por las mismas dos
 * razones — el doble tiene que dar lo que da Postgres, o los tests ejercitarían
 * una forma que el código real nunca ve:
 *
 *   VALORES POR DEFECTO. Una fila escrita por `writeGoal` no trae id, ni
 *   created_at, ni `state`.
 *
 *   ÍNDICES ÚNICOS. «Una lectura ya escrita no se recalcula» lo garantiza LA
 *   BASE DE DATOS con `goal_readings_once`, no un `if (!existe)` en la
 *   aplicación — que es justo el punto, porque el cron reintenta y los
 *   despliegues reinician pasos. Un doble que dejara pasar el segundo INSERT
 *   haría que el test de congelación pasara probando una garantía que daba el
 *   propio doble.
 *
 * Una violación se reporta como la reporta PostgREST, `code: '23505'`.
 */

type Row = Record<string, unknown>;

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${String(++seq).padStart(4, '0')}`;

const NOW = '2026-08-13T12:00:00Z';

const DEFAULTS: Record<string, () => Row> = {
  goals: () => ({
    id: nextId('goal'),
    state: 'active',
    created_at: NOW,
    updated_at: NOW,
    archived_at: null,
    archived_by: null,
  }),
  goal_readings: () => ({
    id: nextId('read'),
    value: null,
    sample_size: 0,
    computed_at: NOW,
  }),
  goal_notices: () => ({
    id: nextId('note'),
    reading_id: null,
    channel: 'email',
    recipient_user_id: null,
    recipient_email: null,
    delivered: false,
    note: null,
    settled_at: null,
    created_at: NOW,
  }),
};

interface UniqueIndex {
  columns: string[];
  /** La fila entra en el índice sólo si estas columnas tienen estos valores. */
  when?: Record<string, unknown>;
}

const UNIQUE: Record<string, UniqueIndex[]> = {
  // `goal_readings_once`: la congelación, garantizada donde no hay carreras.
  goal_readings: [{ columns: ['goal_id', 'period_start'] }],
  // `goal_notices_once_idx`: correr el cron diez veces manda un correo.
  goal_notices: [{ columns: ['goal_id', 'period_start', 'notice_class'] }],
  // `goals_active_metric_idx`, parcial sobre las activas.
  goals: [
    {
      columns: ['organization_id', 'metric_key', 'cadence'],
      when: { state: 'active' },
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

export interface GoalsWorld {
  tables: Tables;
  db: SupabaseClient;
  scopedFor(organizationId: string): SupabaseClient;
}

export function createGoalsWorld(seed: Tables, organizationId: string): GoalsWorld {
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
                  const applies = Object.entries(index.when ?? {}).every(
                    ([column, expected]) => row[column] === expected,
                  );
                  if (!applies) continue;
                  const clash = (tables[table] ?? []).some(
                    (existing) =>
                      Object.entries(index.when ?? {}).every(
                        ([column, expected]) => existing[column] === expected,
                      ) && index.columns.every((c) => (existing[c] ?? null) === (row[c] ?? null)),
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
