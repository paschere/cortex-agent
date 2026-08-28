import type { SupabaseClient } from '@supabase/supabase-js';
import { type FakeStore, fakeSpaceRpcs } from '../../kb/__tests__/space-fake';

/**
 * A Supabase stand-in with just enough behaviour to be wrong in the same ways.
 *
 * Same shape and same intent as the one in `meetings/__tests__`: enough of
 * PostgREST's builder to exercise real code paths (filters, ordering, upsert on
 * a conflict key, replace-the-chunks) without a database, and deliberately not
 * more — the moment it grows features nobody's production query uses, it stops
 * being a stand-in and starts being a second implementation that can agree with
 * the tests while disagreeing with Postgres.
 */

export type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

export class FakeQuery
  implements PromiseLike<{ data: unknown; error: { message: string } | null }>
{
  private filters: Predicate[] = [];
  private mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private payload: Row[] = [];
  private conflictKeys: string[] | null = null;
  private limitTo: number | null = null;
  private sort: { column: string; ascending: boolean } | null = null;

  constructor(
    private readonly store: Record<string, Row[]>,
    private readonly table: string,
    private readonly nextId: () => string,
    /** Columns a unique index covers, so an insert can be REJECTED like Postgres. */
    private readonly uniqueBy: string[] | null = null,
  ) {}

  private get rows(): Row[] {
    this.store[this.table] ??= [];
    return this.store[this.table] as Row[];
  }

  private matching(): Row[] {
    let found = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.sort) {
      const { column, ascending } = this.sort;
      found = [...found].sort((a, b) => {
        const av = String(a[column] ?? '');
        const bv = String(b[column] ?? '');
        return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    return found;
  }

  select(_cols?: string): this {
    return this;
  }
  eq(col: string, value: unknown): this {
    this.filters.push((r) => r[col] === value);
    return this;
  }
  neq(col: string, value: unknown): this {
    this.filters.push((r) => r[col] !== value);
    return this;
  }
  is(col: string, value: unknown): this {
    this.filters.push((r) => (value === null ? r[col] == null : r[col] === value));
    return this;
  }
  in(col: string, values: unknown[]): this {
    this.filters.push((r) => values.includes(r[col]));
    return this;
  }
  gte(col: string, value: string): this {
    this.filters.push((r) => String(r[col] ?? '') >= value);
    return this;
  }
  lte(col: string, value: string): this {
    this.filters.push((r) => String(r[col] ?? '') <= value);
    return this;
  }
  order(column: string, opts?: { ascending?: boolean }): this {
    this.sort = { column, ascending: opts?.ascending !== false };
    return this;
  }
  limit(n: number): this {
    this.limitTo = n;
    return this;
  }

  insert(payload: Row | Row[]): this {
    this.mode = 'insert';
    this.payload = Array.isArray(payload) ? payload : [payload];
    return this;
  }
  update(patch: Row): this {
    this.mode = 'update';
    this.payload = [patch];
    return this;
  }
  delete(): this {
    this.mode = 'delete';
    return this;
  }
  upsert(payload: Row | Row[], opts?: { onConflict?: string }): this {
    this.mode = 'upsert';
    this.payload = Array.isArray(payload) ? payload : [payload];
    this.conflictKeys = opts?.onConflict?.split(',').map((k) => k.trim()) ?? null;
    return this;
  }

  private run(): { data: Row[]; error: { message: string } | null } {
    if (this.mode === 'insert') {
      // A unique index is not decoration in the code under test — the claim on
      // a mention IS an insert that is expected to fail on a re-delivery. A
      // stand-in that always succeeds would make the dedupe test vacuous.
      if (this.uniqueBy) {
        for (const row of this.payload) {
          const clash = this.rows.find((r) =>
            (this.uniqueBy as string[]).every((k) => r[k] === row[k]),
          );
          if (clash) {
            return {
              data: [],
              error: { message: 'duplicate key value violates unique constraint' },
            };
          }
        }
      }
      const created = this.payload.map((p) => ({ id: this.nextId(), ...p }));
      this.rows.push(...created);
      return { data: created, error: null };
    }
    if (this.mode === 'update') {
      const target = this.matching();
      for (const row of target) Object.assign(row, this.payload[0]);
      return { data: target, error: null };
    }
    if (this.mode === 'delete') {
      const target = new Set(this.matching());
      this.store[this.table] = this.rows.filter((r) => !target.has(r));
      return { data: [], error: null };
    }
    if (this.mode === 'upsert') {
      const out: Row[] = [];
      for (const row of this.payload) {
        // The unique index, modelled: the composite conflict key decides
        // whether this is a second row or an update of the first.
        const keys = this.conflictKeys;
        const existing = keys
          ? this.rows.find((r) => keys.every((k) => r[k] === row[k]))
          : undefined;
        if (existing) {
          Object.assign(existing, row);
          out.push(existing);
        } else {
          const created = { id: this.nextId(), ...row };
          this.rows.push(created);
          out.push(created);
        }
      }
      return { data: out, error: null };
    }
    const found = this.matching();
    return { data: this.limitTo != null ? found.slice(0, this.limitTo) : found, error: null };
  }

  async maybeSingle(): Promise<{ data: Row | null; error: { message: string } | null }> {
    const { data, error } = this.run();
    return { data: data[0] ?? null, error };
  }
  async single(): Promise<{ data: Row | null; error: { message: string } | null }> {
    const { data, error } = this.run();
    if (error) return { data: null, error };
    return data[0] ? { data: data[0], error: null } : { data: null, error: { message: 'no rows' } };
  }
  // biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are thenables, so the stub must be one to stand in for them.
  then<R1, R2 = never>(
    onFulfilled?:
      | ((v: { data: unknown; error: { message: string } | null }) => R1 | PromiseLike<R1>)
      | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }
}

/**
 * The row id counter belongs to the STORE, not to the handle.
 *
 * Learned the hard way: with a counter per client, code that builds a fresh
 * handle per call — which is what a route does — handed every row the id
 * `id_1`, and an update by primary key silently rewrote the whole table. Every
 * assertion still passed until one depended on two rows differing.
 */
const COUNTER = new WeakMap<object, { n: number }>();

export function makeDb(
  store: Record<string, Row[]>,
  uniqueBy: Record<string, string[]> = {},
): SupabaseClient {
  const counter = COUNTER.get(store) ?? { n: 0 };
  COUNTER.set(store, counter);
  const spaceRpcs = fakeSpaceRpcs(() => store as FakeStore);
  return {
    from: (table: string) =>
      new FakeQuery(store, table, () => `id_${++counter.n}`, uniqueBy[table] ?? null),
    // `assertCanWriteToSpace` pregunta a la base de datos quién ve qué desde la
    // 0123. Ver src/kb/__tests__/space-fake.ts.
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      const impl = spaceRpcs[fn];
      if (!impl) return { data: null, error: { message: `no fake for rpc ${fn}` } };
      return { data: impl(args), error: null };
    },
  } as unknown as SupabaseClient;
}

export const silentLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  // biome-ignore lint/suspicious/noExplicitAny: standing in for pino's surface
} as any;
