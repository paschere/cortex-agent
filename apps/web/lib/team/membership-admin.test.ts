import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EL ARREGLO DEL ROL QUE NO DURABA, PROBADO EN EL ORDEN EN QUE IMPORTA.
 *
 * /admin/users escribía sólo `public.users.role` y `resolveSessionDirectory` lo
 * recalculaba desde `ba_member.role` en la siguiente petición. Lo que hay que
 * comprobar es entonces: ¿se le pide a better-auth que cambie la membresía?,
 * ¿el directorio se escribe DESPUÉS y sólo si better-auth aceptó?, y ¿las
 * reglas (último fundador, fundador protegido) cortan ANTES de escribir nada?
 *
 * better-auth y Postgres son dobles que registran llamadas; las filas de
 * `ba_member` salen de `state.members`, así que el conteo de fundadores es el
 * de la «base» en ese momento y no uno que la prueba le pase a la función.
 */

const ORG = 'acme';

const state = vi.hoisted(() => ({
  members: [] as Array<Record<string, unknown>>,
  calls: [] as string[],
  directoryWrites: [] as Array<{ org: string; email: string; role: string }>,
  failUpdate: false,
  seatsFull: false,
}));

vi.mock('../auth', () => ({
  pool: {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('update public.users')) {
        state.calls.push('directory');
        state.directoryWrites.push({
          org: params[0] as string,
          email: params[1] as string,
          role: params[2] as string,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('from public.ba_member m')) {
        const ids = params[0] as string[];
        return { rows: state.members.filter((row) => ids.includes(row.organizationId as string)) };
      }
      throw new Error(`consulta inesperada: ${sql}`);
    },
  },
  auth: {
    api: {
      updateMemberRole: async (input: { body: { memberId: string; role: string } }) => {
        state.calls.push(`ba:update:${input.body.memberId}:${input.body.role}`);
        if (state.failUpdate) throw new Error('FORBIDDEN');
        return {};
      },
      removeMember: async (input: { body: { memberIdOrEmail: string } }) => {
        state.calls.push(`ba:remove:${input.body.memberIdOrEmail}`);
        return {};
      },
      createInvitation: async (input: { body: { organizationId: string } }) => {
        state.calls.push(`ba:invite:${input.body.organizationId}`);
        return { id: 'inv-1' };
      },
    },
  },
}));

vi.mock('../supabase/service', () => ({ getOrgScopedClient: () => ({}) }));

vi.mock('@cortex/agent-tools', () => ({
  readWorkspacePlan: async () => ({ plan: { name: 'Gratis' }, contractedSeats: null }),
  readSeats: async () => ({
    full: state.seatsFull,
    maximum: 3,
    members: 3,
    pending: 0,
    used: 3,
  }),
}));

const { changeMemberRole, removeCompanyMember, inviteToCompany } = await import(
  './membership-admin'
);

function member(id: string, accountId: string, role: string, directoryRole: string | null = null) {
  return {
    memberId: id,
    organizationId: ORG,
    organizationName: 'Acme',
    accountId,
    name: accountId,
    email: `${accountId}@acme.co`,
    role,
    directoryRole,
    joinedAt: '2026-01-01',
  };
}

const scope = {
  organizationId: ORG,
  workspaceKind: 'company' as const,
  actorAccountId: 'fundadora',
  actorRole: 'owner' as const,
  requestHeaders: new Headers(),
};

beforeEach(() => {
  state.members = [
    member('m-owner', 'fundadora', 'owner', 'org_admin'),
    member('m-ana', 'ana', 'member', 'member'),
    member('m-luis', 'luis', 'admin', 'org_admin'),
  ];
  state.calls = [];
  state.directoryWrites = [];
  state.failUpdate = false;
  state.seatsFull = false;
});

describe('cambiar el rol persiste en la membresía, no sólo en el directorio', () => {
  it('ascender a admin de la organización cambia ba_member a admin y después el directorio', async () => {
    const result = await changeMemberRole({ ...scope, memberId: 'm-ana', next: 'org_admin' });
    expect(result.ok).toBe(true);
    expect(state.calls).toEqual(['ba:update:m-ana:admin', 'directory']);
    expect(state.directoryWrites).toEqual([{ org: ORG, email: 'ana@acme.co', role: 'org_admin' }]);
  });

  it('bajar a admin de equipo deja la membresía en member y el directorio en team_admin', async () => {
    const result = await changeMemberRole({ ...scope, memberId: 'm-luis', next: 'team_admin' });
    expect(result.ok).toBe(true);
    expect(state.calls).toEqual(['ba:update:m-luis:member', 'directory']);
    expect(state.directoryWrites[0]?.role).toBe('team_admin');
  });

  it('de miembro a admin de equipo no toca better-auth: la membresía ya es member', async () => {
    const result = await changeMemberRole({ ...scope, memberId: 'm-ana', next: 'team_admin' });
    expect(result.ok).toBe(true);
    expect(state.calls).toEqual(['directory']);
  });

  it('si better-auth se niega, el directorio no se escribe', async () => {
    state.failUpdate = true;
    const result = await changeMemberRole({ ...scope, memberId: 'm-ana', next: 'org_admin' });
    expect(result.ok).toBe(false);
    expect(state.directoryWrites).toEqual([]);
  });

  it('un admin no puede bajar a la fundadora, y no se llama a nadie', async () => {
    const result = await changeMemberRole({
      ...scope,
      actorAccountId: 'luis',
      actorRole: 'admin',
      memberId: 'm-owner',
      next: 'member',
    });
    expect(result).toMatchObject({ ok: false, reason: 'owner_protected', status: 403 });
    expect(state.calls).toEqual([]);
  });

  it('la única fundadora no se puede bajar a sí misma ni la puede bajar otra', async () => {
    const self = await changeMemberRole({ ...scope, memberId: 'm-owner', next: 'org_admin' });
    expect(self.ok).toBe(false);
    state.members.push(member('m-otra', 'otra', 'owner'));
    // Con dos fundadoras, una puede bajar a la otra.
    const other = await changeMemberRole({
      ...scope,
      actorAccountId: 'otra',
      memberId: 'm-owner',
      next: 'org_admin',
    });
    expect(other.ok).toBe(true);
  });

  it('un id de membresía de otra empresa no encuentra a nadie', async () => {
    state.members.push({ ...member('m-ajena', 'x', 'member'), organizationId: 'rival' });
    const result = await changeMemberRole({ ...scope, memberId: 'm-ajena', next: 'org_admin' });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(state.calls).toEqual([]);
  });
});

describe('retirar a alguien', () => {
  it('pasa por better-auth, que es lo que dispara la salida segura de la 0138', async () => {
    const result = await removeCompanyMember({ ...scope, memberId: 'm-ana' });
    expect(result.ok).toBe(true);
    expect(state.calls).toEqual(['ba:remove:m-ana']);
  });

  it('la última fundadora no puede retirarse', async () => {
    const result = await removeCompanyMember({ ...scope, memberId: 'm-owner' });
    expect(result).toMatchObject({ ok: false, reason: 'last_owner' });
    expect(state.calls).toEqual([]);
  });

  it('en un espacio personal no hay a quién retirar', async () => {
    const result = await removeCompanyMember({
      ...scope,
      workspaceKind: 'personal',
      memberId: 'm-ana',
    });
    expect(result).toMatchObject({ ok: false, reason: 'personal' });
  });
});

describe('invitar respeta el tope de asientos antes de llamar a better-auth', () => {
  it('con asientos libres, invita nombrando la empresa', async () => {
    const result = await inviteToCompany({
      organizationId: ORG,
      email: 'nueva@acme.co',
      role: 'member',
      requestHeaders: new Headers(),
    });
    expect(result).toMatchObject({ ok: true, id: 'inv-1' });
    expect(state.calls).toEqual([`ba:invite:${ORG}`]);
  });

  it('con el plan lleno, responde 402 y no invita', async () => {
    state.seatsFull = true;
    const result = await inviteToCompany({
      organizationId: ORG,
      email: 'nueva@acme.co',
      role: 'member',
      requestHeaders: new Headers(),
    });
    expect(result).toMatchObject({ ok: false, status: 402, reason: 'plan_limit' });
    expect(state.calls).toEqual([]);
  });
});
