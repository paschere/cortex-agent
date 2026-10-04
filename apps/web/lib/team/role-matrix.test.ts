import { describe, expect, it } from 'vitest';
import { decideInvitationRole, decidePromoteToOwner, decideRemoval } from '../founder-rules';
import {
  CAPABILITIES,
  ROLES_INFO,
  ROLE_KEYS,
  founderOnlyCapabilities,
  roleKeyOf,
  sharedWithAdmins,
} from './role-matrix';

/**
 * La matriz que se le enseña a la gente tiene que decir lo mismo que las
 * reglas que aplica el servidor; si una cambia sin la otra, esta prueba falla.
 */
describe('la matriz de roles', () => {
  it('cada fila tiene un nivel para los cuatro roles y un id único', () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const capability of CAPABILITIES) {
      for (const role of ROLE_KEYS)
        expect(capability.levels[role], `${capability.id}/${role}`).toBeDefined();
    }
  });

  it('un cofundador puede todo lo que puede un administrador', () => {
    for (const capability of CAPABILITIES) {
      const rank = { no: 0, partial: 1, yes: 2 } as const;
      expect(rank[capability.levels.owner]).toBeGreaterThanOrEqual(rank[capability.levels.admin]);
    }
  });

  it('lo exclusivo de fundadores es justo lo que las reglas niegan a un administrador', () => {
    expect(founderOnlyCapabilities().map((c) => c.id)).toEqual(['founders', 'delete-company']);
    // «Nombrar cofundadores»: la regla lo niega a un administrador…
    expect(
      decidePromoteToOwner({
        workspaceKind: 'company',
        actorRole: 'admin',
        actorIsTarget: false,
        targetRole: 'member',
      }),
    ).toEqual({ ok: false, reason: 'not_owner' });
    // …y «retirar cofundadores» también.
    expect(
      decideRemoval({
        workspaceKind: 'company',
        actorRole: 'admin',
        actorIsTarget: false,
        targetRole: 'owner',
        ownerCount: 2,
      }),
    ).toEqual({ ok: false, reason: 'owner_protected' });
    // En cambio «invitar y retirar personas» sí es de administradores.
    expect(
      decideRemoval({
        workspaceKind: 'company',
        actorRole: 'admin',
        actorIsTarget: false,
        targetRole: 'member',
        ownerCount: 1,
      }).ok,
    ).toBe(true);
    expect(
      decideInvitationRole({ workspaceKind: 'company', actorRole: 'admin', role: 'member' }).ok,
    ).toBe(true);
  });

  it('el diálogo de cofundador lista lo que se suma y lo que ya podía un administrador', () => {
    expect(sharedWithAdmins().length).toBeGreaterThan(0);
    for (const capability of sharedWithAdmins()) expect(capability.founderOnly).toBeFalsy();
  });

  it('el rol visible sale de la membresía primero y del directorio después', () => {
    expect(roleKeyOf('owner', 'member')).toBe('owner');
    expect(roleKeyOf('admin', 'org_admin')).toBe('admin');
    expect(roleKeyOf('member', 'team_admin')).toBe('team_admin');
    expect(roleKeyOf('member', null)).toBe('member');
    expect(ROLES_INFO.owner.label).toBe('Cofundador');
  });
});
