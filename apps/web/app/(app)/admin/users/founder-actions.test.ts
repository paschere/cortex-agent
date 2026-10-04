import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LAS PUERTAS DE LAS ACCIONES DE PROPIEDAD, EN SU ORDEN.
 *
 * Una acción de servidor tiene URL propia, así que la prueba invoca las
 * funciones directamente, sin pantalla: ¿se niega a quien no es fundador ANTES
 * de pedir nada?, ¿exige que lo escrito coincida?, ¿una prueba de identidad
 * fallida impide que se escriba? Y la excepción: dejar la empresa sin ser
 * fundador no pide re-autenticación.
 */

const state = vi.hoisted(() => ({
  role: 'owner' as 'owner' | 'admin' | 'member',
  stepUpOk: true,
  writes: [] as string[],
  stepUps: 0,
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: async () => ({ user: { id: 'cuenta-1' } }) } },
}));
vi.mock('@/lib/session', () => ({
  requireSession: async () => ({
    id: 'u-1',
    role: 'org_admin',
    organization: { id: 'acme', name: 'Acme SAS', kind: 'company', role: state.role },
  }),
}));
vi.mock('@/lib/team/membership-admin', () => ({
  memberIdForDirectoryUser: async (_org: string, id: string) => (id === 'u-ana' ? 'm-ana' : null),
  listCompanyMembers: async () => [
    { memberId: 'm-ana', name: 'Ana Pérez', email: 'ana@acme.co', role: 'member' },
  ],
}));
vi.mock('@/lib/team/step-up', () => ({
  verifyStepUp: async () => {
    state.stepUps += 1;
    return state.stepUpOk
      ? { ok: true }
      : { ok: false, requirement: 'password', message: 'Esa contraseña no es correcta.' };
  },
}));
vi.mock('@/lib/team/founder-admin', () => ({
  promoteToOwner: async () => {
    state.writes.push('promote');
    return { ok: true, status: 200, message: 'listo' };
  },
  transferOwnership: async () => {
    state.writes.push('transfer');
    return { ok: true, status: 200, message: 'listo' };
  },
  stepDownAsOwner: async () => {
    state.writes.push('step_down');
    return { ok: true, status: 200, message: 'listo' };
  },
  leaveCompany: async () => {
    state.writes.push('leave');
    return { ok: true, status: 200, message: 'listo' };
  },
}));

const { promoteToOwnerAction, transferOwnershipAction, stepDownAction, leaveCompanyAction } =
  await import('./founder-actions');

beforeEach(() => {
  state.role = 'owner';
  state.stepUpOk = true;
  state.writes = [];
  state.stepUps = 0;
});

describe('hacer cofundador', () => {
  it('un administrador se queda en la puerta: ni confirmación ni identidad se piden', async () => {
    state.role = 'admin';
    const result = await promoteToOwnerAction({
      directoryUserId: 'u-ana',
      confirmation: 'Ana Pérez',
    });
    expect(result.ok).toBe(false);
    expect(state.stepUps).toBe(0);
    expect(state.writes).toEqual([]);
  });

  it('una persona que no es de esta empresa no se encuentra', async () => {
    const result = await promoteToOwnerAction({ directoryUserId: 'u-otra', confirmation: 'x' });
    expect(result.ok).toBe(false);
    expect(state.writes).toEqual([]);
  });

  it('lo escrito debe coincidir con la persona o la empresa', async () => {
    const wrong = await promoteToOwnerAction({ directoryUserId: 'u-ana', confirmation: 'Beto' });
    expect(wrong.ok).toBe(false);
    expect(state.stepUps).toBe(0);
    const byCompany = await promoteToOwnerAction({
      directoryUserId: 'u-ana',
      confirmation: 'acme sas',
      password: 'x',
    });
    expect(byCompany.ok).toBe(true);
  });

  it('con la identidad rechazada no se escribe nada y se devuelve el factor pedido', async () => {
    state.stepUpOk = false;
    const result = await promoteToOwnerAction({
      directoryUserId: 'u-ana',
      confirmation: 'Ana Pérez',
      password: 'mala',
    });
    expect(result).toMatchObject({ ok: false, requirement: 'password' });
    expect(state.writes).toEqual([]);
  });

  it('con todo en orden escribe una vez', async () => {
    const result = await promoteToOwnerAction({
      directoryUserId: 'u-ana',
      confirmation: 'Ana Pérez',
      password: 'buena',
    });
    expect(result.ok).toBe(true);
    expect(state.writes).toEqual(['promote']);
  });
});

describe('transferir y dejar de ser fundador', () => {
  it('transferir pasa por las mismas puertas', async () => {
    state.stepUpOk = false;
    expect(
      (
        await transferOwnershipAction({
          directoryUserId: 'u-ana',
          confirmation: 'Ana Pérez',
          stepDown: true,
        })
      ).ok,
    ).toBe(false);
    expect(state.writes).toEqual([]);
    state.stepUpOk = true;
    await transferOwnershipAction({
      directoryUserId: 'u-ana',
      confirmation: 'Ana Pérez',
      stepDown: true,
    });
    expect(state.writes).toEqual(['transfer']);
  });

  it('dejar de ser fundador se confirma con el nombre de la empresa', async () => {
    expect((await stepDownAction({ confirmation: 'Ana' })).ok).toBe(false);
    expect((await stepDownAction({ confirmation: 'Acme SAS' })).ok).toBe(true);
    expect(state.writes).toEqual(['step_down']);
  });
});

describe('dejar la empresa', () => {
  it('un miembro se va sin re-autenticar', async () => {
    state.role = 'member';
    const result = await leaveCompanyAction({ confirmation: 'Acme SAS' });
    expect(result.ok).toBe(true);
    expect(state.stepUps).toBe(0);
    expect(state.writes).toEqual(['leave']);
  });

  it('un fundador que se va sí prueba quién es', async () => {
    state.stepUpOk = false;
    const refused = await leaveCompanyAction({ confirmation: 'Acme SAS' });
    expect(refused.ok).toBe(false);
    expect(state.writes).toEqual([]);
    state.stepUpOk = true;
    await leaveCompanyAction({ confirmation: 'Acme SAS' });
    expect(state.writes).toEqual(['leave']);
  });
});
