import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RPC_TENANCY, TABLE_TENANCY } from '../tables';

/**
 * THE TEST THAT CATCHES THE MISTAKE NOBODY WILL MAKE ON PURPOSE.
 *
 * Everything else about this change protects a query that exists today. This
 * one protects the query somebody writes in three months. It reads the source
 * of the whole repository, collects every table name reached through
 * `.from('…')` and every database function called through `.rpc('…')`, and
 * fails if a single one of them is missing a tenancy classification.
 *
 * The point is the ORDER of discovery. Without it, a new table is discovered
 * when a customer sees another customer's rows. With it, it is discovered by
 * whoever added the table, before the branch merges, with a message telling
 * them the three choices and where to make them. The scoped client throws at
 * runtime for the same reason, but a runtime throw only fires on a code path
 * somebody actually ran; this fires on all of them.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const SCANNED = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo', 'build', '.git']);

/** `sb.storage.from('kb-uploads')` is a bucket, not a table. */
const STORAGE_CALL = /storage\s*\.\s*from\(/;

/**
 * This directory is excluded from its own scan. `scoped-client.test.ts` asks
 * for `invoices` and `settle_invoices` deliberately — proving the client
 * refuses names nobody has classified is the point of it — and a scan that
 * counted those would make the two tests contradict each other.
 */
const SELF = join('packages', 'agent-tools', 'src', 'tenancy', '__tests__');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

interface Reference {
  name: string;
  file: string;
}

function collect(pattern: RegExp, isStorageAware: boolean): Reference[] {
  const found: Reference[] = [];
  for (const root of SCANNED) {
    for (const file of sourceFiles(join(REPO_ROOT, root))) {
      if (file.includes(SELF)) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(pattern)) {
        const name = match[1];
        if (!name) continue;
        if (isStorageAware) {
          // Look back far enough to see `.storage` on the same expression.
          const before = text.slice(Math.max(0, (match.index ?? 0) - 20), match.index ?? 0);
          if (STORAGE_CALL.test(`${before}.from(`)) continue;
        }
        found.push({ name, file: file.slice(REPO_ROOT.length) });
      }
    }
  }
  return found;
}

function group(refs: Reference[], known: Readonly<Record<string, unknown>>): string[] {
  const unknownNames = new Map<string, Set<string>>();
  for (const ref of refs) {
    if (known[ref.name]) continue;
    const files = unknownNames.get(ref.name) ?? new Set<string>();
    files.add(ref.file);
    unknownNames.set(ref.name, files);
  }
  return [...unknownNames.entries()].map(
    ([name, files]) => `${name}  (${[...files].sort().join(', ')})`,
  );
}

describe('tenancy registry', () => {
  it('classifies every table the codebase queries', () => {
    const refs = collect(/\.from\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*\)/g, true);
    // A sanity floor: if the scan silently stops finding anything (a moved
    // directory, a changed call style), the assertion below would pass while
    // testing nothing.
    expect(refs.length).toBeGreaterThan(100);
    expect(group(refs, TABLE_TENANCY)).toEqual([]);
  });

  it('classifies every database function the codebase calls', () => {
    const refs = collect(/\.rpc\(\s*['"]([a-z_][a-z0-9_]*)['"]/g, false);
    expect(refs.length).toBeGreaterThan(5);
    expect(group(refs, RPC_TENANCY)).toEqual([]);
  });

  it('every shared table says why it is exempt, in a sentence', () => {
    for (const [table, tenancy] of Object.entries(TABLE_TENANCY)) {
      if (tenancy.kind !== 'shared') continue;
      // "shared" is the answer that can hide a leak. A one-word reason is not
      // an argument, and this is the only place the argument gets written down.
      expect(tenancy.why.length, `${table} needs a real reason`).toBeGreaterThan(30);
    }
  });

  it('every derived table names a parent that is itself scoped', () => {
    for (const [table, tenancy] of Object.entries(TABLE_TENANCY)) {
      if (tenancy.kind !== 'derived') continue;
      const parent = TABLE_TENANCY[tenancy.parent];
      expect(parent, `${table} inherits from unknown table ${tenancy.parent}`).toBeDefined();
      // Inheriting from a `shared` or another `derived` table would mean the
      // chain never reaches an organization_id.
      expect(parent?.kind, `${table} inherits from a table that is not tenant-scoped`).toBe(
        'tenant',
      );
    }
  });
});
