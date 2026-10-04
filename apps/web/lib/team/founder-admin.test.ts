import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LOS MOVIMIENTOS DE PROPIEDAD, PROBADOS EN EL ORDEN EN QUE IMPORTA.
 *
 * Lo que se vigila: (1) las reglas cortan ANTES de escribir; (2) quien actúa se
 * lee de `ba_member` en la llamada, no de lo que mande la pantalla; (3) en una
 * transferencia se asciende primero y se baja después, de modo que un fallo a
 * medias deja DOS fundadores y nunca cero; (4) cada cambio deja intención y
 * resultado en la auditoría y avisa a todos los fundadores.
 */

const ORG = 'acme';

const state = vi.hoisted(() => ({
  members: [] as Array<Record<string, unknown>>,
  calls: [] as string[],
  audits: [] as Array<{ toolId: string; status: string }>,
  emails: [] as Array<{ to: string[]; subject: string }>,
  failRole: null as string | null,
  failLeave: false,
}));

vi.mock('../auth', () => ({
  pool: {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('update public.users')) {
        state.calls.push(`directory:${params[1]}`);
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
        const { memberId, role } = input.body;
        state.calls.push(`ba:${memberId}:${role}`);
        if (state.failRole === `${memberId}:${role}`) throw new Error('FORBIDDEN');
        const row = state.members.find((m) => m.memberId === memberId);
        if (row) row.role = role;
        return {};
      },
      leaveOrganization: async () => {
        state.calls.push('ba:leave');
        if (state.failLeave) throw new Error('nope');
        return {};
      },
    },
  },
}));

vi.mock('../email', () => ({
  sendEmail: async (input: { to: string[]; subject: string }) => {
    state.emails.push({ to: input.to, subject: input.subject });
    return { sent: true };
  },
}));

vi.mock('../supabase/service', () => ({ getOrgScopedClient: () => ({}) }));

vi.mock('@cortex/agent-tools', () => ({
  readWorkspacePlan: async () => ({ plan: {}, contractedSeats: null }),
  readSeats: async () => ({ full: false }),
  writeAuditEvent: async (input: { toolId: string; status: string }) => {
    state.audits.push({ toolId: input.toolId, status: input.status });
  },
}));

const { promoteToOwner, transferOwnership, stepDownAsOwner, leaveCompany } = await import(
  './founder-admin'
);

function member(id: string, accountId: string, role: string) {
  return {
    memberId: id,
    organizationId: ORG,
    organizationName: 'Acme',
    accountId,
    name: accountId,
    email: `${accountId}@acme.co`,
    role,
    directoryRole: role === 'member' ? 'member' : 'org_admin',
    joinedAt: '2026-01-01',
  };
}

const scope = {
  organizationId: ORG,
  organizationName: 'Acme',
  workspaceKind: 'company' as const,
  actorAccountId: 'fundadora',
  actorUserId: '00000000-0000-0000-0000-000000000001',
  requestHeaders: new Headers(),
};

beforeEach(() => {
  state.members = [
    member('m-fund', 'fundadora', 'owner'),
    member('m-ana', 'ana', 'member'),
    member('m-luis', 'luis', 'admin'),
  ];
  state.calls = [];
  state.audits = [];
  state.emails = [];
  state.failRole = null;
  state.failLeave = false;
});

describe('hacer cofundador', () => {
  it('escribe la membresía, luego el directorio, deja intención y resultado y avisa a los fundadores', async () => {
    const result = await promoteToOwner({ ...scope, memberId: 'm-ana' });
    expect(result.ok).toBe(true);
    expect(state.calls).toEqual(['ba:m-ana:owner', 'directory:ana@acme.co']);
    expect(state.audits).toEqual([
      { toolId: 'team_founder_promote', status: 'attempted' },
      { toolId: 'team_founder_promote', status: 'ok' },
    ]);
    // Avisa a los fundadores de DESPUÉS del cambio: la fundadora y Ana.
    expect(state.emails).toHaveLength(1);
    expect(state.emails[0]?.to.sort()).toEqual(['ana@acme.co', 'fundadora@acme.co']);
    expect(state.emails[0]?.subject).toContain('cofundador');
  });

  it('un administrador no puede, aunque la pantalla se lo hubiera ofrecido', async () => {
    const result = await promoteToOwner({
      ...scope,
      actorAccountId: 'luis',
      memberId: 'm-ana',
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_owner' });
    expect(state.calls).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it('si better-auth se niega no se toca el directorio y el error queda auditado', async () => {
    state.failRole = 'm-ana:owner';
    const result = await promoteToOwner({ ...scope, memberId: 'm-ana' });
    expect(result.ok).toBe(false);
    expect(state.calls).toEqual(['ba:m-ana:owner']);
    expect(state.audits.map((a) => a.status)).toEqual(['attempted', 'error']);
    expect(state.emails).toEqual([]);
  });

  it('no se nombra dos veces a quien ya es fundador ni a uno mismo', async () => {
    state.members.push(member('m-co', 'cofundador', 'owner'));
    expect(await promoteToOwner({ ...scope, memberId: 'm-co' })).toMatchObject({
      reason: 'already_owner',
    });
    expect(await promoteToOwner({ ...scope, memberId: 'm-fund' })).toMatchObject({
      reason: 'self',
    });
  });
});

describe('transferir la propiedad', () => {
  it('asciende primero al otro y baja después a quien actúa', async () => {
    const result = await transferOwnership({ ...scope, memberId: 'm-ana', stepDown: true });
    expect(result.ok).toBe(true);
    expect(state.calls).toEqual([
      'ba:m-ana:owner',
      'directory:ana@acme.co',
      'ba:m-fund:admin',
      'directory:fundadora@acme.co',
    ]);
    // Quien soltó la propiedad también recibe el aviso.
    expect(state.emails[0]?.to).toContain('fundadora@acme.co');
  });

  it('si falla bajar a quien actúa quedan DOS fundadores, no cero', async () => {
    state.failRole = 'm-fund:admin';
    const result = await transferOwnership({ ...scope, memberId: 'm-ana', stepDown: true });
    expect(result.ok).toBe(false);
    const owners = state.members.filter((m) => m.role === 'owner');
    expect(owners.map((m) => m.memberId).sort()).toEqual(['m-ana', 'm-fund']);
    expect(state.audits.map((a) => a.status)).toEqual(['attempted', 'error']);
  });

  it('sin soltar, los dos quedan fundadores', async () => {
    await transferOwnership({ ...scope, memberId: 'm-ana', stepDown: false });
    expect(state.calls).not.toContain('ba:m-fund:admin');
  });
});

describe('dejar de ser fundador', () => {
  it('con un solo fundador se niega antes de escribir nada', async () => {
    const result = await stepDownAsOwner(scope);
    expect(result).toMatchObject({ ok: false, reason: 'last_owner' });
    expect(state.calls).toEqual([]);
  });

  it('con otro fundador baja a administrador y avisa', async () => {
    state.members.push(member('m-co', 'cofundador', 'owner'));
    const result = await stepDownAsOwner(scope);
    expect(result.ok).toBe(true);
    expect(state.calls[0]).toBe('ba:m-fund:admin');
    expect(state.emails[0]?.to.sort()).toEqual(['cofundador@acme.co', 'fundadora@acme.co']);
  });
});

describe('dejar la empresa', () => {
  it('un miembro raso puede irse y no dispara aviso de fundadores', async () => {
    const result = await leaveCompany({ ...scope, actorAccountId: 'ana' });
    expect(result.ok).toBe(true);
    expect(state.calls).toEqual(['ba:leave']);
    expect(state.audits.map((a) => a.status)).toEqual(['attempted', 'ok']);
    expect(state.emails).toEqual([]);
  });

  it('el último fundador no puede irse', async () => {
    const result = await leaveCompany(scope);
    expect(result).toMatchObject({ ok: false, reason: 'last_owner' });
    expect(state.calls).toEqual([]);
  });

  it('un fundador que se va con otro presente sí avisa a los fundadores', async () => {
    state.members.push(member('m-co', 'cofundador', 'owner'));
    const result = await leaveCompany(scope);
    expect(result.ok).toBe(true);
    expect(state.emails).toHaveLength(1);
  });
});
