import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLE_TENANCY } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';

/**
 * ONE COMPANY MUST NEVER SEE ANOTHER COMPANY'S ERRANDS.
 *
 * An errand is the most sensitive thing this product produces: a dossier
 * assembled from a workspace's mail, documents, clients and meetings, sitting
 * in one row with the answer already written out. A leak here is not a leaked
 * record, it is a leaked briefing.
 *
 * Isolation is structural rather than remembered, in two layers, and this file
 * asserts both — as a property of the SOURCE, because the alternative is a
 * live multi-tenant database in CI and because "which client did this file
 * reach for" is a question about the source anyway.
 *
 *   LAYER ONE  every errand table is registered `tenant()` in the tenancy
 *              registry, so `createOrgScopedClient` filters every read and
 *              stamps every write. An unregistered table is refused outright.
 *
 *   LAYER TWO  every by-id read ALSO passes the workspace explicitly, so an
 *              errand id from another tenant is a 404 and not a document. Two
 *              layers, because they fail differently: the first is a property
 *              of the handle, the second survives somebody handing this code
 *              the wrong handle.
 */

/** Both without a trailing slash, so `slice(ROOT.length)` leaves a leading `/`. */
const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const ERRAND_TABLES = ['errands', 'errand_legs', 'errand_questions'] as const;

/** Every errand source file: the library, its routes, its screens, its jobs. */
function errandSources(): Array<{ path: string; source: string }> {
  const roots = [
    HERE,
    join(ROOT, 'app', 'api', 'errands'),
    join(ROOT, 'app', '(app)', 'errands'),
    join(ROOT, 'inngest', 'functions'),
  ];
  const out: Array<{ path: string; source: string }> = [];

  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || entry.endsWith('.test.ts')) continue;
      // Only the errand jobs from the shared inngest folder.
      if (dir.endsWith(join('inngest', 'functions')) && !entry.startsWith('errand-')) continue;
      out.push({ path: `apps/web${full.slice(ROOT.length)}`, source: readFileSync(full, 'utf8') });
    }
  };

  for (const root of roots) walk(root);
  return out;
}

describe('errands stay inside their workspace', () => {
  it('registers every errand table, or the scoped client refuses to query it', () => {
    for (const table of ERRAND_TABLES) {
      const tenancy = (TABLE_TENANCY as Record<string, { kind: string }>)[table];
      expect(tenancy, `${table} is missing from tenancy/tables.ts`).toBeDefined();
      // `tenant`, not `derived`: the sweep scans errands across workspaces and
      // the nav counts open questions across one, so both children are read on
      // their own and need their own organization_id.
      expect(tenancy?.kind, `${table} must carry its own organization_id`).toBe('tenant');
    }
  });

  it('never reaches for a raw, unscoped client outside the sweep', () => {
    // `getSupabaseServiceClient` bypasses tenant scoping entirely. Exactly one
    // file may hold it — the cron sweep, whose question ("which errands
    // anywhere need a look") has no workspace to be scoped to, and which only
    // ever runs a SELECT before switching to a scoped handle per errand.
    const offenders = errandSources()
      .filter(({ source }) => source.includes('getSupabaseServiceClient'))
      .map(({ path }) => path)
      .filter((path) => !path.endsWith('errand-sweep.ts'));
    expect(
      offenders,
      `these must use getOrgScopedClient, not the raw service client: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('scopes every by-id read to the workspace as well as to the handle', () => {
    // Belt and braces. `loadErrand`, `loadSnapshot` and `loadDetail` all take
    // organizationId as a required argument and put it in the WHERE clause, so
    // forgetting it is a type error rather than a leak nobody notices.
    const repository = readFileSync(join(HERE, 'repository.ts'), 'utf8');
    for (const fn of ['loadErrand', 'loadSnapshot', 'loadDetail']) {
      const signature = repository.match(
        new RegExp(`export async function ${fn}\\([\\s\\S]*?\\)\\s*:`),
      )?.[0];
      expect(signature, `${fn} should exist`).toBeDefined();
      expect(signature, `${fn} must take the workspace explicitly`).toContain(
        'organizationId: string',
      );
    }
    expect(repository).toContain(".eq('organization_id', organizationId)");
  });

  it('makes every route resolve the workspace from the session, never from the request', () => {
    // A workspace id taken off the body or the query is a workspace id an
    // attacker chooses. Every errand route reads it from requireSession().
    const routes = errandSources().filter(({ path }) => path.includes('/app/api/errands/'));
    expect(routes.length).toBeGreaterThan(2);
    for (const { path, source } of routes) {
      expect(source, `${path} must authenticate`).toContain('requireSession()');
      expect(source, `${path} must scope its handle`).toContain(
        'getOrgScopedClient(user.organization.id)',
      );
      expect(source, `${path} must not take a workspace from the caller`).not.toMatch(
        /organizationId:\s*(?:body|parsed|req|searchParams)/,
      );
    }
  });

  it('carries the workspace on the event, because a background job has no session', () => {
    // The unattended half. `requireSession` inside an Inngest function would
    // throw at best and pick somebody arbitrary at worst, so the workspace
    // rides on the event and every handle is pinned to it.
    for (const { path, source } of errandSources().filter(({ path: p }) =>
      p.includes('inngest/functions/errand-'),
    )) {
      expect(source, `${path} must never ask for a session`).not.toContain('requireSession');
    }
    const worker = readFileSync(join(HERE, 'worker.ts'), 'utf8');
    expect(worker).not.toContain('requireSession');
    expect(worker).toContain('getOrgScopedClient(input.organizationId)');
  });
});
