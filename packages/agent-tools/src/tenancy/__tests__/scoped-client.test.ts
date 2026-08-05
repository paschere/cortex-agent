import { describe, expect, it } from 'vitest';
import {
  DerivedScopeError,
  MissingOrganizationError,
  createOrgScopedClient,
  isOrgScoped,
  organizationIdOf,
} from '../scoped-client';
import { UnclassifiedFunctionError, UnclassifiedTableError } from '../tables';
import { createFakeSupabase } from './fake-postgrest';

/**
 * The refusals.
 *
 * isolation.test.ts proves the scoped client returns the right rows. This file
 * proves it REFUSES the things that would let a future change return the wrong
 * ones: an unclassified table, an unclassified database function, a query that
 * sweeps a child table without naming its parent, and a handle built without a
 * workspace. Every one of these is a loud failure on purpose — the alternative
 * to a thrown error here is a quiet cross-tenant read.
 */

const ORG = 'org-acme';

function scoped(tables = {}, rpcs = {}) {
  const fake = createFakeSupabase(tables, rpcs);
  return { fake, db: createOrgScopedClient(fake.client, ORG) };
}

describe('refusals', () => {
  it('refuses a table nobody has classified, and says what to do', () => {
    const { db } = scoped();
    expect(() => db.from('invoices')).toThrow(UnclassifiedTableError);
    expect(() => db.from('invoices')).toThrow(/TABLE_TENANCY/);
  });

  it('refuses a database function nobody has classified', () => {
    const { db } = scoped();
    expect(() => db.rpc('settle_invoices')).toThrow(UnclassifiedFunctionError);
  });

  it('refuses to exist without a workspace', () => {
    const fake = createFakeSupabase({});
    expect(() => createOrgScopedClient(fake.client, '')).toThrow(MissingOrganizationError);
  });

  it('refuses to sweep a derived table, and allows it when the parent is named', async () => {
    const { db } = scoped({
      kb_chunks: [
        { id: 'c1', document_id: 'doc-1', content: 'uno' },
        { id: 'c2', document_id: 'doc-2', content: 'dos' },
      ],
    });

    await expect(db.from('kb_chunks').select('content')).rejects.toBeInstanceOf(DerivedScopeError);
    // `.in()` names the parent too — the requirement is the key, not the operator.
    const { data } = await db.from('kb_chunks').select('content').in('document_id', ['doc-1']);
    expect(data).toHaveLength(1);
  });

  it('refuses a derived write whose row does not name its parent', () => {
    const { db } = scoped({ kb_chunks: [] });
    expect(() => db.from('kb_chunks').insert({ content: 'huérfano' })).toThrow(DerivedScopeError);
    expect(() =>
      db.from('kb_chunks').insert([{ document_id: 'doc-1', content: 'ok' }]),
    ).not.toThrow();
  });

  it('refuses to delete from a derived table without naming the parent', async () => {
    const { db } = scoped({ kb_chunks: [{ id: 'c1', document_id: 'doc-1' }] });
    await expect(db.from('kb_chunks').delete()).rejects.toBeInstanceOf(DerivedScopeError);
    expect(await db.from('kb_chunks').delete().eq('document_id', 'doc-1')).toBeTruthy();
  });
});

describe('pass-through and stamping', () => {
  it('leaves shared tables alone — they have no workspace to filter by', async () => {
    const { db } = scoped({
      ba_member: [
        { id: 'm1', organizationId: ORG, userId: 'u1' },
        { id: 'm2', organizationId: 'org-globex', userId: 'u2' },
      ],
    });
    const { data } = await db.from('ba_member').select('id');
    expect((data as Array<{ id: string }>).map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('fills in p_organization_id for functions that take one', async () => {
    const { fake, db } = scoped({}, { provision_organization_agents: () => 3 });
    await db.rpc('provision_organization_agents');
    expect(fake.rpcCalls[0]?.args).toEqual({ p_organization_id: ORG });
  });

  it('leaves person-scoped functions untouched: the person already names the workspace', async () => {
    const { fake, db } = scoped({}, { user_memory_context: () => [] });
    await db.rpc('user_memory_context', { p_user_id: 'u1' });
    expect(fake.rpcCalls[0]?.args).toEqual({ p_user_id: 'u1' });
  });

  it('stamps every row of a multi-row insert', async () => {
    const { fake, db } = scoped({ vehicles: [] });
    await db.from('vehicles').insert([
      { id: 'v1', plate: 'AAA111' },
      { id: 'v2', plate: 'BBB222', organization_id: 'org-globex' },
    ]);
    expect(fake.tables.vehicles?.map((v) => v.organization_id)).toEqual([ORG, ORG]);
  });

  it('reports which workspace a handle is pinned to, and that a raw one is not', () => {
    const fake = createFakeSupabase({});
    const db = createOrgScopedClient(fake.client, ORG);
    expect(organizationIdOf(db)).toBe(ORG);
    expect(isOrgScoped(db)).toBe(true);
    expect(isOrgScoped(fake.client)).toBe(false);
  });
});
