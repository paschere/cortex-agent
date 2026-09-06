import { describe, expect, it } from 'vitest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import { makeDb, type Row } from '../../whatsapp/__tests__/fake-db';
import { canRunFlow } from '../access';
import { browserActorKey, getBrowserProfile } from '../profiles';

describe('personal browser permissions', () => {
  const alice = 'a1111111-1111-4111-a111-111111111111';
  const bob = 'b2222222-2222-4222-a222-222222222222';
  function fixture(shared = false) {
    const rows: Record<string, Row[]> = {
      browser_profiles: [
        {
          id: 'profile',
          organization_id: 'acme',
          owner_id: alice,
          shared,
          revision: 1,
          name: 'Mi perfil',
        },
      ],
    };
    const db = createOrgScopedClient(makeDb(rows), 'acme');
    return { rows, db };
  }
  it('private profiles exclude coworkers, including administrators', async () => {
    const { db } = fixture();
    await expect(getBrowserProfile(db, 'profile', alice)).resolves.toMatchObject({
      owner_id: alice,
    });
    await expect(getBrowserProfile(db, 'profile', bob)).rejects.toThrow();
    expect(
      await canRunFlow(
        db,
        { id: bob, role: 'org_admin' },
        { id: 'flow', name: 'Privado', credentialId: null, profileId: 'profile' },
      ),
    ).toMatchObject({ allowed: false });
  });
  it('explicit sharing grants use only inside the organization; revocation removes it', async () => {
    const { db, rows } = fixture(true);
    await expect(getBrowserProfile(db, 'profile', bob)).resolves.toMatchObject({ shared: true });
    const other = createOrgScopedClient(makeDb(rows), 'other-company');
    await expect(getBrowserProfile(other, 'profile', bob)).rejects.toThrow();
    rows.browser_profiles![0]!.shared = false;
    await expect(getBrowserProfile(db, 'profile', bob)).rejects.toThrow();
  });
  it('session identities separate both people and company memberships', () => {
    expect(browserActorKey('acme', alice)).not.toBe(browserActorKey('acme', bob));
    expect(browserActorKey('acme', alice)).not.toBe(browserActorKey('other', alice));
    expect(browserActorKey('acme', alice).length).toBeLessThanOrEqual(80);
  });
});
