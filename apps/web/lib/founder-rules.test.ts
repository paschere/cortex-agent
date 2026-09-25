import { describe, expect, it } from 'vitest';
import {
  type MembershipChangeInput,
  type MembershipRow,
  decideRemoval,
  decideRoleChange,
  directoryRoleFor,
  groupPeople,
  healthOf,
  membershipTargetFor,
  ownerCounts,
  partitionOwned,
  summarizeResults,
} from './founder-rules';

/**
 * LAS REGLAS QUE, SI FALLAN, DEJAN A UNA EMPRESA SIN DUEÑO O A UN ADMIN POR
 * ENCIMA DE SU FUNDADOR.
 *
 * Se prueban sin base de datos porque son puras a propósito: la consola del
 * fundador y «Personas» de cada empresa llaman a estas mismas funciones, así
 * que una prueba aquí cubre las dos puertas.
 */

const base: MembershipChangeInput = {
  workspaceKind: 'company',
  actorRole: 'owner',
  actorIsTarget: false,
  targetRole: 'member',
  ownerCount: 1,
};

describe('el rol del directorio se traduce a una membresía que persiste', () => {
  it('admin de la organización es admin en better-auth; los otros dos son member', () => {
    expect(membershipTargetFor('org_admin')).toEqual({
      membershipRole: 'admin',
      directoryRole: 'org_admin',
    });
    expect(membershipTargetFor('team_admin')).toEqual({
      membershipRole: 'member',
      directoryRole: 'team_admin',
    });
    expect(membershipTargetFor('member')).toEqual({
      membershipRole: 'member',
      directoryRole: 'member',
    });
  });

  it('lee la membresía igual que resolveSessionDirectory: team_admin sólo sobrevive sobre member', () => {
    expect(directoryRoleFor('owner')).toBe('org_admin');
    expect(directoryRoleFor('admin', 'team_admin')).toBe('org_admin');
    expect(directoryRoleFor('member', 'team_admin')).toBe('team_admin');
    expect(directoryRoleFor('member', 'org_admin')).toBe('member');
    expect(directoryRoleFor('algo-raro')).toBe('member');
  });

  it('ningún rol del directorio produce owner: la transferencia de propiedad es otro flujo', () => {
    for (const role of ['member', 'team_admin', 'org_admin'] as const) {
      expect(membershipTargetFor(role).membershipRole).not.toBe('owner');
    }
  });
});

describe('cambiar el rol', () => {
  const change = (patch: Partial<Parameters<typeof decideRoleChange>[0]>) =>
    decideRoleChange({ ...base, currentDirectoryRole: 'member', next: 'org_admin', ...patch });

  it('un fundador asciende a un miembro', () => {
    expect(change({})).toEqual({ ok: true });
  });

  it('un admin también puede ascender o bajar a quien no es fundador', () => {
    expect(change({ actorRole: 'admin' })).toEqual({ ok: true });
    expect(
      change({
        actorRole: 'admin',
        targetRole: 'admin',
        currentDirectoryRole: 'org_admin',
        next: 'member',
      }),
    ).toEqual({ ok: true });
  });

  it('un admin no puede tocar a un fundador, aunque haya varios', () => {
    expect(
      change({ actorRole: 'admin', targetRole: 'owner', ownerCount: 3, next: 'member' }),
    ).toEqual({ ok: false, reason: 'owner_protected' });
  });

  it('nunca se baja al último fundador', () => {
    expect(change({ targetRole: 'owner', ownerCount: 1, next: 'org_admin' })).toEqual({
      ok: false,
      reason: 'last_owner',
    });
  });

  it('un fundador puede bajar a otro cuando queda al menos uno', () => {
    expect(change({ targetRole: 'owner', ownerCount: 2, next: 'org_admin' })).toEqual({ ok: true });
  });

  it('nadie se cambia el rol a sí mismo desde aquí', () => {
    expect(change({ actorIsTarget: true })).toEqual({ ok: false, reason: 'self' });
  });

  it('un colaborador no administra', () => {
    expect(change({ actorRole: 'member' })).toEqual({ ok: false, reason: 'not_manager' });
  });

  it('en un espacio personal no hay equipo que cambiar', () => {
    expect(change({ workspaceKind: 'personal' })).toEqual({ ok: false, reason: 'personal' });
  });

  it('pasar de miembro a admin de equipo sí es un cambio, aunque la membresía no cambie', () => {
    expect(change({ next: 'team_admin' })).toEqual({ ok: true });
    expect(change({ currentDirectoryRole: 'team_admin', next: 'team_admin' })).toEqual({
      ok: false,
      reason: 'unchanged',
    });
  });
});

describe('retirar a alguien', () => {
  it('un fundador retira a un miembro o a un admin', () => {
    expect(decideRemoval(base)).toEqual({ ok: true });
    expect(decideRemoval({ ...base, targetRole: 'admin' })).toEqual({ ok: true });
  });

  it('un admin no retira a un fundador', () => {
    expect(
      decideRemoval({ ...base, actorRole: 'admin', targetRole: 'owner', ownerCount: 2 }),
    ).toEqual({ ok: false, reason: 'owner_protected' });
  });

  it('el último fundador no puede salir, ni por sí mismo ni por otro', () => {
    expect(
      decideRemoval({ ...base, actorIsTarget: true, targetRole: 'owner', ownerCount: 1 }),
    ).toEqual({ ok: false, reason: 'last_owner' });
  });

  it('un fundador puede salir si queda otro', () => {
    expect(
      decideRemoval({ ...base, actorIsTarget: true, targetRole: 'owner', ownerCount: 2 }),
    ).toEqual({ ok: true });
  });

  it('los espacios personales no tienen miembros que retirar', () => {
    expect(decideRemoval({ ...base, workspaceKind: 'personal' })).toEqual({
      ok: false,
      reason: 'personal',
    });
  });
});

describe('qué empresas pedidas son de verdad de esta cuenta', () => {
  it('separa las propias de las ajenas, deduplica y no distingue por qué se niega', () => {
    const owned = new Set(['acme', 'beta']);
    expect(partitionOwned(['acme', 'rival', 'acme', 'personal:u1', 'beta'], owned)).toEqual({
      allowed: ['acme', 'beta'],
      denied: ['rival', 'personal:u1'],
    });
  });

  it('una lista vacía no autoriza nada', () => {
    expect(partitionOwned([], new Set(['acme']))).toEqual({ allowed: [], denied: [] });
  });
});

describe('la tabla de personas', () => {
  const rows: MembershipRow[] = [
    {
      memberId: 'm1',
      organizationId: 'beta',
      organizationName: 'Beta',
      accountId: 'ana',
      name: 'Ana',
      email: 'ana@x.co',
      role: 'member',
      directoryRole: 'team_admin',
      joinedAt: '2026-03-01',
    },
    {
      memberId: 'm2',
      organizationId: 'acme',
      organizationName: 'Acme',
      accountId: 'ana',
      name: 'Ana',
      email: 'ana@x.co',
      role: 'admin',
      directoryRole: null,
      joinedAt: '2026-01-01',
    },
    {
      memberId: 'm3',
      organizationId: 'acme',
      organizationName: 'Acme',
      accountId: 'yo',
      name: null,
      email: 'yo@x.co',
      role: 'owner',
      directoryRole: 'org_admin',
      joinedAt: '2025-12-01',
    },
  ];

  it('una persona con dos empresas es una fila con dos membresías, ordenadas por empresa', () => {
    const people = groupPeople(rows);
    expect(people.map((p) => p.accountId)).toEqual(['ana', 'yo']);
    const ana = people[0];
    expect(ana?.memberships.map((m) => m.organizationName)).toEqual(['Acme', 'Beta']);
    expect(ana?.firstJoinedAt).toBe('2026-01-01');
  });

  it('el rol del directorio se deriva de la membresía, no se copia a ciegas', () => {
    const ana = groupPeople(rows)[0];
    expect(ana?.memberships.find((m) => m.organizationId === 'acme')?.directoryRole).toBe(
      'org_admin',
    );
    expect(ana?.memberships.find((m) => m.organizationId === 'beta')?.directoryRole).toBe(
      'team_admin',
    );
  });

  it('cuenta fundadores por empresa', () => {
    expect(Object.fromEntries(ownerCounts(rows))).toEqual({ acme: 1 });
  });
});

describe('resultados por empresa', () => {
  const r = (ok: boolean) => ({ organizationId: 'x', organizationName: 'X', ok, message: '' });
  it('dice cuántas salieron en vez de un sí o no', () => {
    expect(summarizeResults([r(true), r(true)])).toEqual({
      tone: 'emerald',
      text: 'Listo en las 2 empresas.',
    });
    expect(summarizeResults([r(true), r(false), r(true)])).toEqual({
      tone: 'amber',
      text: 'Listo en 2 de 3 empresas.',
    });
    expect(summarizeResults([r(false)]).tone).toBe('rose');
    expect(summarizeResults([]).tone).toBe('rose');
  });
});

describe('la señal de salud', () => {
  const ok = {
    meterState: 'ok' as const,
    seatsFull: false,
    failedRuns7d: 0,
    blocked: 0,
    subscriptionStatus: 'active' as const,
  };
  it('verde cuando nada pide atención', () => {
    expect(healthOf(ok).tone).toBe('emerald');
  });
  it('lo que ya está parado gana a lo que va a estarlo', () => {
    expect(healthOf({ ...ok, subscriptionStatus: 'past_due', failedRuns7d: 3 }).tone).toBe('rose');
    expect(healthOf({ ...ok, meterState: 'blocked' }).label).toBe('Sin respuestas');
    expect(healthOf({ ...ok, failedRuns7d: 1, seatsFull: true }).label).toBe('Rutinas con fallos');
    expect(healthOf({ ...ok, seatsFull: true }).tone).toBe('amber');
  });
});
