import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ORGANIZATION_COLUMN,
  type RpcTenancy,
  rpcTenancyOf,
  tenancyOf,
} from './tables';

/**
 * The workspace-scoped database handle. This is the only way the product is
 * allowed to reach business data.
 *
 * THE PROBLEM IT SOLVES. Writing `\.eq('organization_id', orgId)` on every query
 * works exactly as long as everybody remembers. There are several hundred
 * queries in this codebase and there will be more next month; one of them will
 * be written without the filter, it will pass review because it looks like
 * every other query, and it will return one customer's rows to another with no
 * error, no log line and no test failure. That is the failure mode this file
 * exists to make impossible — not the filter itself, which is easy.
 *
 * HOW IT WORKS. `createOrgScopedClient(raw, organizationId)` returns something
 * that behaves like a SupabaseClient and is passed everywhere one used to be.
 * Call sites are UNCHANGED — `db.from('conversations').select('*')` still reads
 * exactly like that — but the handle pins the workspace onto the query on the
 * way past:
 *
 *   select / update / delete   gain `.eq('organization_id', <workspace>)`
 *   insert / upsert            gain `organization_id: <workspace>` per row
 *   update                     has any organization_id in its payload dropped,
 *                              so no code path can move a row to another tenant
 *
 * Because nothing at the call site has to be remembered, nothing at the call
 * site can be forgotten. And because the handle refuses tables it does not
 * recognise (see tables.ts), a table added later cannot slip through
 * unclassified: its first query throws.
 *
 * WHAT IT IS NOT. It is not a security boundary against a hostile process — the
 * underlying key is still service-role, and anything holding it can construct a
 * raw client. It is a boundary against MISTAKES, which is what actually leaks
 * data between tenants in practice. The database-level boundary (RLS under a
 * role that does not bypass it) is the follow-up migration 0064's header
 * describes; every row now carries the column that makes it a policy change
 * rather than a rewrite.
 */

/** Filter methods whose first argument is a column name. */
const COLUMN_FILTERS = new Set([
  'eq',
  'in',
  'filter',
  'is',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'ilike',
  'contains',
  'containedBy',
  'overlaps',
  'textSearch',
]);

export class DerivedScopeError extends Error {
  constructor(table: string, parentKey: string, parent: string) {
    super(
      `Query on "${table}" does not constrain "${parentKey}". ${table} has no organization_id — ` +
        `it inherits its workspace from ${parent} through ${parentKey} (migration 0064 § 12), so a ` +
        'query that does not name the parent would read across every tenant. Filter by ' +
        `${parentKey}, or give ${table} its own organization_id and reclassify it as tenant().`,
    );
    this.name = 'DerivedScopeError';
  }
}

export class MissingOrganizationError extends Error {
  constructor(what: string) {
    super(
      `${what} without a workspace. A scoped database handle needs the id of the workspace the ` +
        'request is acting in (SessionUser.organization.id, or the organization_id of the row a ' +
        'background job is working on). Refusing to run unscoped.',
    );
    this.name = 'MissingOrganizationError';
  }
}

/** Marks a handle as scoped, and to which workspace. Read by organizationIdOf. */
const ORGANIZATION_ID = Symbol.for('cortex.tenancy.organizationId');

type AnyRecord = Record<string, unknown>;
// The PostgREST builders are structurally recursive and heavily overloaded;
// typing this proxy precisely would mean re-declaring supabase-js. The lies are
// confined to this file, and the exported signature is honest.
// biome-ignore lint/suspicious/noExplicitAny: proxying a third-party builder chain
type Any = any;

function withOrganization(value: unknown, organizationId: string): unknown {
  if (Array.isArray(value)) {
    return value.map((row) => withOrganization(row, organizationId));
  }
  if (value && typeof value === 'object') {
    return { ...(value as AnyRecord), [ORGANIZATION_COLUMN]: organizationId };
  }
  return value;
}

/**
 * An UPDATE may not carry organization_id. Not because it would be rejected —
 * it would happily succeed — but because succeeding is the problem: it is the
 * one statement shape that can hand an existing row to another tenant, and no
 * feature in this product needs to.
 */
function withoutOrganization(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutOrganization);
  if (value && typeof value === 'object') {
    const { [ORGANIZATION_COLUMN]: _dropped, ...rest } = value as AnyRecord;
    return rest;
  }
  return value;
}

/**
 * Wrap a builder for a `derived` table so it cannot be awaited until the parent
 * key has been constrained.
 *
 * The check has to happen at await time rather than at `.from()` time, because
 * the filter arrives several calls later in the chain. So the proxy watches the
 * chain go past and only decides when somebody asks for the result.
 */
function guardDerived(builder: Any, table: string, parentKey: string, parent: string): Any {
  const state = { constrained: false };

  const wrap = (target: Any): Any =>
    new Proxy(target, {
      get(t, prop, _receiver) {
        // Every method below is invoked against the raw target rather than the
        // proxy: PostgrestBuilder keeps its state in private class fields, and
        // a proxy receiver makes those inaccessible.
        const value = Reflect.get(t, prop, t);

        if (prop === 'then') {
          if (!state.constrained) {
            return (onFulfilled: Any, onRejected: Any) =>
              Promise.reject(new DerivedScopeError(table, parentKey, parent)).then(
                onFulfilled,
                onRejected,
              );
          }
          return typeof value === 'function' ? value.bind(t) : value;
        }

        if (typeof value !== 'function') return value;

        return (...args: Any[]) => {
          // Either the foreign key itself, or a column of the parent reached
          // through an inner-join embed — `select('id, kb_documents!inner(…)')`
          // followed by `.in('kb_documents.collection_id', …)`. Both restrict
          // the rows to a named set of parents, which is the requirement; only
          // the join direction differs.
          const constrains =
            COLUMN_FILTERS.has(String(prop)) &&
            typeof args[0] === 'string' &&
            (args[0] === parentKey || args[0].startsWith(`${parent}.`));
          if (constrains) {
            state.constrained = true;
          } else if (
            prop === 'match' &&
            args[0] &&
            typeof args[0] === 'object' &&
            parentKey in (args[0] as AnyRecord)
          ) {
            state.constrained = true;
          } else if (prop === 'or' && typeof args[0] === 'string') {
            // `or()` can only widen a row set, so it can never satisfy the
            // requirement — and an `or` that mentions the parent key is exactly
            // the shape that looks like it does. Left explicitly unhandled.
          }
          const result = value.apply(t, args);
          return result && typeof result === 'object' && result === t ? wrap(result) : result;
        };
      },
    });

  return wrap(builder);
}

function assertParentOnRows(value: unknown, table: string, parentKey: string, parent: string): void {
  const rows = Array.isArray(value) ? value : [value];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || (row as AnyRecord)[parentKey] == null) {
      throw new DerivedScopeError(table, parentKey, parent);
    }
  }
}

/**
 * @param raw a service-role Supabase client
 * @param organizationId the workspace this handle acts in — never optional, and
 *   never a value the caller made up: it comes from the session, or from the
 *   row an unattended job is processing.
 */
export function createOrgScopedClient(raw: SupabaseClient, organizationId: string): SupabaseClient {
  if (!organizationId) throw new MissingOrganizationError('createOrgScopedClient called');

  const scopedFrom = (table: string): Any => {
    const tenancy = tenancyOf(table);
    const qb: Any = (raw as Any).from(table);

    if (tenancy.kind === 'shared') return qb;

    if (tenancy.kind === 'derived') {
      const { parentKey, parent } = tenancy;
      return {
        select: (...args: Any[]) => guardDerived(qb.select(...args), table, parentKey, parent),
        update: (...args: Any[]) => guardDerived(qb.update(...args), table, parentKey, parent),
        delete: (...args: Any[]) => guardDerived(qb.delete(...args), table, parentKey, parent),
        insert: (value: Any, ...rest: Any[]) => {
          assertParentOnRows(value, table, parentKey, parent);
          return qb.insert(value, ...rest);
        },
        upsert: (value: Any, ...rest: Any[]) => {
          assertParentOnRows(value, table, parentKey, parent);
          return qb.upsert(value, ...rest);
        },
      };
    }

    return {
      select: (...args: Any[]) => qb.select(...args).eq(ORGANIZATION_COLUMN, organizationId),
      insert: (value: Any, ...rest: Any[]) =>
        qb.insert(withOrganization(value, organizationId), ...rest),
      upsert: (value: Any, ...rest: Any[]) =>
        qb.upsert(withOrganization(value, organizationId), ...rest),
      update: (value: Any, ...rest: Any[]) =>
        qb.update(withoutOrganization(value), ...rest).eq(ORGANIZATION_COLUMN, organizationId),
      delete: (...args: Any[]) => qb.delete(...args).eq(ORGANIZATION_COLUMN, organizationId),
    };
  };

  const scopedRpc = (fn: string, args?: AnyRecord, options?: Any): Any => {
    const kind: RpcTenancy = rpcTenancyOf(fn);
    if (kind === 'organization') {
      return (raw as Any).rpc(fn, { ...(args ?? {}), p_organization_id: organizationId }, options);
    }
    // 'person' functions derive the workspace from p_user_id, because a
    // directory row belongs to exactly one workspace (migration 0064 § 3).
    // 'maintenance' functions touch nothing a tenant can see.
    return (raw as Any).rpc(fn, args, options);
  };

  return new Proxy(raw as Any, {
    get(target, prop, _receiver) {
      if (prop === 'from') return scopedFrom;
      if (prop === 'rpc') return scopedRpc;
      if (prop === ORGANIZATION_ID) return organizationId;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as SupabaseClient;
}

/**
 * The workspace a handle is pinned to, or null if it is a raw client.
 *
 * Used by code that has a database handle but not the session that produced it
 * — chiefly `runTool`, which stamps the workspace onto audit and security rows,
 * and the tests that assert a handle is scoped at all.
 */
export function organizationIdOf(db: SupabaseClient): string | null {
  const carrier = db as unknown as Record<symbol, unknown>;
  return (carrier[ORGANIZATION_ID] as string | undefined) ?? null;
}

/** True when the handle came from `createOrgScopedClient`. */
export function isOrgScoped(db: SupabaseClient): boolean {
  return organizationIdOf(db) !== null;
}
