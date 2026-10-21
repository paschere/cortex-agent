import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * trackers.define sobre una tabla que existe NUNCA quita campos por omisión
 * (2026-10-16, GROUNDFLEX: agregar un autofill borró estado, hora_real y observaciones).
 */

const f = (key: string, type = 'text', extra: object = {}) => ({
  key,
  label: key,
  type,
  required: false,
  ...extra,
});

const state = vi.hoisted(() => ({
  existing: null as null | { id: string; fields: unknown[] },
  defined: [] as Array<Record<string, unknown>>,
  usesCalled: 0,
}));

vi.mock('./store', async (orig) => {
  const real = await orig<typeof import('./store')>();
  return {
    ...real,
    getTrackerBySlug: vi.fn(async () => state.existing),
    defineTracker: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
      state.defined.push(input);
      return {
        created: !state.existing,
        tracker: {
          id: 't1',
          slug: input.slug,
          name: input.name,
          description: '',
          fields: input.fields,
        },
      };
    }),
  };
});
vi.mock('./duplicates', async (orig) => ({
  ...(await orig<typeof import('./duplicates')>()),
  getDuplicateRule: vi.fn(async () => null),
}));
vi.mock('./field-usage', async (orig) => ({
  ...(await orig<typeof import('./field-usage')>()),
  findFieldUses: vi.fn(async () => {
    state.usesCalled += 1;
    return [
      {
        viewId: 'v',
        viewTitle: 'Detalle de vuelo',
        screens: [{ appName: 'Control', screenTitle: 'Vuelo' }],
        blocks: [{ id: 'b', title: 'Vuelo', fields: ['hora_real'] }],
      },
    ];
  }),
  countFieldValues: vi.fn(async () => ({ hora_real: 4 })),
}));

import { trackersDefine } from './tools';

const ctx = {
  db: {},
  userId: 'u1',
  organizationId: 'o1',
  integrations: {},
  signal: undefined,
} as never;
const call = (extra: Record<string, unknown>) =>
  trackersDefine.handler(
    trackersDefine.inputSchema.parse({ slug: 'vuelos', name: 'Vuelos', description: '', ...extra }),
    ctx,
  );

beforeEach(() => {
  state.existing = {
    id: 't1',
    fields: [
      f('numero_vuelo'),
      f('estado', 'select', { options: ['A', 'B'] }),
      f('hora_real', 'time'),
      f('observaciones', 'longtext'),
    ],
  };
  state.defined.length = 0;
  state.usesCalled = 0;
});

describe('trackers.define fusiona', () => {
  it('agregar un autofill conserva estado, hora_real y observaciones', async () => {
    await call({
      fields: [
        f('numero_vuelo', 'text', {
          autofill: {
            instruction: 'Con el número identifica la aerolínea',
            from: ['numero_vuelo'],
            fills: ['aerolinea'],
          },
        }),
        f('aerolinea'),
      ],
    });
    const keys = (state.defined[0]?.fields as Array<{ key: string }>).map((x) => x.key);
    expect(keys).toEqual(['numero_vuelo', 'estado', 'hora_real', 'observaciones', 'aerolinea']);
  });

  it('el autofill puede llenar un campo que ya existía y no viene en la llamada', async () => {
    await call({
      fields: [
        f('numero_vuelo', 'text', {
          autofill: {
            instruction: 'Con el número identifica el estado',
            from: ['numero_vuelo'],
            fills: ['estado'],
          },
        }),
      ],
    });
    expect(state.defined).toHaveLength(1);
  });

  it('quitar exige removeFields, y avisa qué pantallas se rompen y cuántos valores', async () => {
    const out = (await call({ fields: [f('numero_vuelo')], removeFields: ['hora_real'] })) as {
      markdown: string;
    };
    const keys = (state.defined[0]?.fields as Array<{ key: string }>).map((x) => x.key);
    expect(keys).toEqual(['numero_vuelo', 'estado', 'observaciones']);
    expect(out.markdown).toContain('hora_real (4 valores guardados)');
    expect(out.markdown).toContain('Detalle de vuelo');
    expect(state.usesCalled).toBe(1);
  });

  it('un campo en fields y en removeFields se rechaza', async () => {
    await expect(call({ fields: [f('estado')], removeFields: ['estado'] })).rejects.toThrow(
      /removeFields/,
    );
    expect(state.defined).toHaveLength(0);
  });

  it('una tabla nueva queda como viene', async () => {
    state.existing = null;
    await call({ fields: [f('a'), f('b')] });
    expect((state.defined[0]?.fields as unknown[]).length).toBe(2);
  });
});
