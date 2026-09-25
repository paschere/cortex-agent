import { describe, expect, it, vi } from 'vitest';

/**
 * LA PUERTA DE CADA ACCIÓN DEL FUNDADOR: ¿ESTA EMPRESA ES TUYA AHORA?
 *
 * `requireFounderContext` lee las empresas propias de `ba_member`; lo que se
 * prueba aquí es lo que se hace después con un id que llega del navegador. Un
 * espacio personal (del que la cuenta SÍ es owner) no cuenta como empresa
 * propia: la consulta filtra `kind = 'company'`, y la prueba lo fija.
 */

const state = vi.hoisted(() => ({
  sql: '' as string,
  rows: [
    { id: 'acme', name: 'Acme', slug: 'acme', createdAt: '2026-01-01' },
    { id: 'beta', name: 'Beta', slug: 'beta', createdAt: '2026-02-01' },
  ],
}));

vi.mock('./auth', () => ({
  pool: {
    query: async (sql: string) => {
      state.sql = sql;
      return { rows: state.rows };
    },
  },
  auth: { api: { getSession: async () => ({ user: { id: 'cuenta-1' } }) } },
}));
vi.mock('./session', () => ({
  requireSession: async () => ({
    id: 'u-1',
    email: 'yo@acme.co',
    name: null,
    role: 'org_admin',
    organization: {
      id: 'personal:cuenta-1',
      name: 'Personal',
      slug: null,
      role: 'owner',
      kind: 'personal',
    },
  }),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

const { FounderAccessError, assertOwns, requireFounderContext, splitOwned } = await import(
  './founder-guard'
);

describe('propiedad por empresa', () => {
  it('sólo cuenta empresas donde la cuenta es owner, nunca el espacio personal', async () => {
    await requireFounderContext();
    expect(state.sql).toMatch(/m\.role = 'owner'/);
    expect(state.sql).toMatch(/o\.kind = 'company'/);
  });

  it('una empresa propia pasa; una ajena o el espacio personal lanzan', async () => {
    const context = await requireFounderContext();
    expect(assertOwns(context, 'acme').name).toBe('Acme');
    expect(() => assertOwns(context, 'rival')).toThrow(FounderAccessError);
    expect(() => assertOwns(context, 'personal:cuenta-1')).toThrow(FounderAccessError);
  });

  it('en una acción sobre varias empresas, cada una se decide por separado', async () => {
    const context = await requireFounderContext();
    const { allowed, denied } = splitOwned(context, ['beta', 'rival', 'acme', 'beta']);
    expect(allowed.map((company) => company.id)).toEqual(['beta', 'acme']);
    expect(denied).toEqual(['rival']);
  });

  it('perder la propiedad corta en la siguiente lectura, sin caché', async () => {
    state.rows = [{ id: 'beta', name: 'Beta', slug: 'beta', createdAt: '2026-02-01' }];
    const context = await requireFounderContext();
    expect(() => assertOwns(context, 'acme')).toThrow(FounderAccessError);
  });
});
