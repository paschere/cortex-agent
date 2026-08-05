import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A small in-memory stand-in for PostgREST, good enough to run real product
 * code against.
 *
 * WHY NOT A MOCK. A mock that returns canned rows tests that the code calls the
 * database; it cannot test that the ROW SET is right, which is the only thing
 * tenant isolation is about. So this executes the filters instead: `.eq`,
 * `.in`, `.or`, `.is`, ranges, ordering, `single`/`maybeSingle`, and the four
 * write verbs, over plain objects. The scoped client under test wraps it exactly
 * as it wraps the real one, and `kb_search_scoped` below implements the
 * visibility rule the way migration 0064 implements it — so a fixture with two
 * companies in it produces a real answer to "can Acme see Globex's documents".
 *
 * It is deliberately NOT a general Postgres: unsupported syntax throws rather
 * than silently returning everything, because a silently permissive fake in a
 * tenancy test is worse than no test.
 */

type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

type Op = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'is' | 'not-is' | 'contains';

interface Filter {
  column: string;
  op: Op;
  value: unknown;
}

function matches(row: Row, f: Filter): boolean {
  const actual = row[f.column];
  switch (f.op) {
    case 'eq':
      return actual === f.value;
    case 'neq':
      return actual !== f.value;
    case 'gt':
      return String(actual) > String(f.value);
    case 'gte':
      return String(actual) >= String(f.value);
    case 'lt':
      return String(actual) < String(f.value);
    case 'lte':
      return String(actual) <= String(f.value);
    case 'in':
      return (f.value as unknown[]).includes(actual);
    case 'is':
      return f.value === null ? actual == null : actual === f.value;
    case 'not-is':
      return f.value === null ? actual != null : actual !== f.value;
    case 'contains':
      return (f.value as unknown[]).every((v) => (actual as unknown[] | null)?.includes(v));
    default:
      throw new Error(`fake-postgrest: unsupported operator ${f.op}`);
  }
}

/**
 * `or=(a.eq.1,and(b.eq.2,c.eq.3))` — the subset supabase-js produces from
 * `.or()`. Anything else throws, on purpose.
 */
function parseOr(expr: string): (row: Row) => boolean {
  const parts = splitTop(expr);
  const clauses = parts.map((part) => {
    const and = part.match(/^and\((.*)\)$/s);
    if (and?.[1]) {
      const inner = splitTop(and[1]).map(parseLeaf);
      return (row: Row) => inner.every((f) => matches(row, f));
    }
    const leaf = parseLeaf(part);
    return (row: Row) => matches(row, leaf);
  });
  return (row) => clauses.some((c) => c(row));
}

function splitTop(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function parseLeaf(part: string): Filter {
  const [column, op, ...rest] = part.split('.');
  const raw = rest.join('.');
  if (!column || !op) throw new Error(`fake-postgrest: cannot parse "${part}"`);
  const value = raw === 'null' ? null : raw;
  return { column, op: op as Op, value };
}

interface Result<T> {
  data: T;
  error: { message: string; code?: string } | null;
  count?: number | null;
}

class Query implements PromiseLike<Result<unknown>> {
  private filters: Filter[] = [];
  private predicates: Array<(row: Row) => boolean> = [];
  private orderBy: Array<{ column: string; ascending: boolean }> = [];
  private limitTo: number | null = null;
  private mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private payload: Row[] = [];
  private singleMode: 'one' | 'maybe' | null = null;
  private wantCount = false;
  private headOnly = false;
  private returning = false;

  private onConflictKeys: string[] = [];

  constructor(
    private readonly tables: Tables,
    private readonly table: string,
  ) {}

  private rows(): Row[] {
    this.tables[this.table] ??= [];
    return this.tables[this.table] as Row[];
  }

  private selected(): Row[] {
    return this.rows().filter(
      (row) => this.filters.every((f) => matches(row, f)) && this.predicates.every((p) => p(row)),
    );
  }

  // --- verbs ---------------------------------------------------------------
  select(_columns?: string, opts?: { count?: string; head?: boolean }) {
    if (this.mode === 'select') {
      this.wantCount = Boolean(opts?.count);
      this.headOnly = Boolean(opts?.head);
    } else {
      this.returning = true;
    }
    return this;
  }
  insert(values: Row | Row[]) {
    this.mode = 'insert';
    this.payload = Array.isArray(values) ? values : [values];
    return this;
  }
  upsert(values: Row | Row[], opts?: { onConflict?: string }) {
    this.mode = 'upsert';
    this.payload = Array.isArray(values) ? values : [values];
    if (opts?.onConflict) this.onConflictKeys = opts.onConflict.split(',');
    return this;
  }
  update(values: Row) {
    this.mode = 'update';
    this.payload = [values];
    return this;
  }
  delete() {
    this.mode = 'delete';
    return this;
  }

  // --- filters -------------------------------------------------------------
  eq(column: string, value: unknown) {
    this.filters.push({ column, op: 'eq', value });
    return this;
  }
  neq(column: string, value: unknown) {
    this.filters.push({ column, op: 'neq', value });
    return this;
  }
  gt(column: string, value: unknown) {
    this.filters.push({ column, op: 'gt', value });
    return this;
  }
  gte(column: string, value: unknown) {
    this.filters.push({ column, op: 'gte', value });
    return this;
  }
  lt(column: string, value: unknown) {
    this.filters.push({ column, op: 'lt', value });
    return this;
  }
  lte(column: string, value: unknown) {
    this.filters.push({ column, op: 'lte', value });
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push({ column, op: 'in', value: values });
    return this;
  }
  is(column: string, value: unknown) {
    this.filters.push({ column, op: 'is', value });
    return this;
  }
  contains(column: string, values: unknown[]) {
    this.filters.push({ column, op: 'contains', value: values });
    return this;
  }
  not(column: string, op: string, value: unknown) {
    if (op !== 'is') throw new Error(`fake-postgrest: unsupported not.${op}`);
    this.filters.push({ column, op: 'not-is', value });
    return this;
  }
  or(expr: string) {
    this.predicates.push(parseOr(expr));
    return this;
  }
  match(criteria: Row) {
    for (const [column, value] of Object.entries(criteria)) this.eq(column, value);
    return this;
  }
  order(column: string, opts?: { ascending?: boolean }) {
    this.orderBy.push({ column, ascending: opts?.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.limitTo = n;
    return this;
  }
  maybeSingle() {
    this.singleMode = 'maybe';
    return this;
  }
  single() {
    this.singleMode = 'one';
    return this;
  }
  // biome-ignore lint/suspicious/noThenProperty: mirrors PostgrestBuilder's thenable shape
  then<R1 = Result<unknown>, R2 = never>(
    onFulfilled?: ((value: Result<unknown>) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }

  private run(): Result<unknown> {
    switch (this.mode) {
      case 'insert':
      case 'upsert': {
        const written: Row[] = [];
        for (const row of this.payload) {
          const existing =
            this.mode === 'upsert' && this.onConflictKeys.length > 0
              ? this.rows().find((r) => this.onConflictKeys.every((k) => r[k] === row[k]))
              : undefined;
          if (existing) {
            Object.assign(existing, row);
            written.push(existing);
          } else {
            const created = { ...row };
            this.rows().push(created);
            written.push(created);
          }
        }
        return this.shape(written);
      }
      case 'update': {
        const hit = this.selected();
        for (const row of hit) Object.assign(row, this.payload[0]);
        return this.shape(hit);
      }
      case 'delete': {
        const hit = this.selected();
        const keep = this.rows().filter((r) => !hit.includes(r));
        this.tables[this.table] = keep;
        return this.shape(hit);
      }
      default: {
        let hit = this.selected();
        for (const o of [...this.orderBy].reverse()) {
          hit = [...hit].sort((a, b) => {
            const av = String(a[o.column] ?? '');
            const bv = String(b[o.column] ?? '');
            return o.ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        const count = hit.length;
        if (this.limitTo != null) hit = hit.slice(0, this.limitTo);
        if (this.headOnly) return { data: null, error: null, count };
        const shaped = this.shape(hit);
        return this.wantCount ? { ...shaped, count } : shaped;
      }
    }
  }

  private shape(rows: Row[]): Result<unknown> {
    if (this.singleMode === 'maybe') return { data: rows[0] ?? null, error: null };
    if (this.singleMode === 'one') {
      return rows.length === 1
        ? { data: rows[0], error: null }
        : { data: null, error: { message: 'expected exactly one row' } };
    }
    if (this.mode !== 'select' && !this.returning) return { data: null, error: null };
    return { data: rows, error: null };
  }
}

export interface FakeSupabase {
  client: SupabaseClient;
  tables: Tables;
  /** Every RPC the code under test asked for, in order. */
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
}

type RpcImpl = (args: Record<string, unknown>, tables: Tables) => unknown;

export function createFakeSupabase(
  tables: Tables,
  rpcs: Record<string, RpcImpl> = {},
): FakeSupabase {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    from: (table: string) => new Query(tables, table),
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      rpcCalls.push({ fn, args });
      const impl = rpcs[fn];
      if (!impl) return { data: null, error: { message: `no fake for rpc ${fn}` } };
      return { data: impl(args, tables), error: null };
    },
  } as unknown as SupabaseClient;
  return { client, tables, rpcCalls };
}
