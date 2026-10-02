import type { SessionUser } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { managesTeam, teamViewer } from './read';

/**
 * Quién administra el equipo en las pantallas: `org_admin` o el DUEÑO de la
 * empresa (decisión del dueño). Ser dueño de un espacio personal no cuenta.
 */

const user = (
  role: SessionUser['role'],
  org: { role: string; kind: 'company' | 'personal' },
): SessionUser =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    email: 'a@x.co',
    name: 'A',
    role,
    organization: { id: 'org-1', name: 'Andina', slug: null, ...org },
  }) as SessionUser;

// Para administradores y dueños, `teamViewer` no lee la base.
const noDb = {} as SupabaseClient;

describe('quién administra el equipo', () => {
  it('org_admin o dueño de una empresa; un miembro o el dueño de su espacio personal, no', () => {
    expect(managesTeam(user('org_admin', { role: 'admin', kind: 'company' }))).toBe(true);
    expect(managesTeam(user('member', { role: 'owner', kind: 'company' }))).toBe(true);
    expect(managesTeam(user('member', { role: 'member', kind: 'company' }))).toBe(false);
    expect(managesTeam(user('member', { role: 'owner', kind: 'personal' }))).toBe(false);
  });

  it('el dueño ve todo, reasigna y configura como un administrador', async () => {
    const viewer = await teamViewer(noDb, user('member', { role: 'owner', kind: 'company' }));
    expect(viewer).toMatchObject({ admin: true, founder: true, seesAll: true, visibleIds: null });
  });
});
