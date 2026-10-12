import { describe, expect, it } from 'vitest';
import { type UsageInput, computeUsage, medianOf } from './usage';

const now = new Date('2026-10-12T15:00:00Z');
const iso = (daysAgo: number, minutes = 0) =>
  new Date(now.getTime() - daysAgo * 86_400_000 + minutes * 60_000).toISOString();
const base = (over: Partial<UsageInput> = {}): UsageInput => ({
  now,
  events: [],
  submissions: [],
  edits: [],
  externalSeen: [],
  roleOf: new Map([
    ['a', 'operario'],
    ['b', 'operario'],
    ['c', 'gerencia'],
  ]),
  roleNames: new Map([
    ['operario', 'Operario'],
    ['gerencia', 'Gerencia'],
  ]),
  screens: [{ slug: 'registrar', title: 'Registrar', viewId: 'v1' }],
  ...over,
});

describe('uso', () => {
  it('cuenta activos a 7 y 30 días y por rol', () => {
    const u = computeUsage(
      base({
        events: [
          {
            kind: 'screen_open',
            screen: 'registrar',
            blockId: null,
            actorId: 'a',
            roleKey: null,
            ref: null,
            at: iso(1),
          },
          {
            kind: 'screen_open',
            screen: 'registrar',
            blockId: null,
            actorId: 'b',
            roleKey: null,
            ref: null,
            at: iso(20),
          },
          {
            kind: 'screen_open',
            screen: 'registrar',
            blockId: null,
            actorId: 'x',
            roleKey: null,
            ref: null,
            at: iso(45),
          },
        ],
        externalSeen: [{ actorId: 'c', at: iso(3) }],
      }),
    );
    expect(u.active).toEqual({ d7: 2, d30: 3 });
    expect(u.byRole.find((r) => r.roleKey === 'operario')).toMatchObject({
      active7: 1,
      active30: 2,
    });
    expect(u.topScreens[0]).toMatchObject({ slug: 'registrar', opens: 2, people: 2 });
  });
  it('registros por día, con ceros y sólo la ventana', () => {
    const u = computeUsage(
      base({
        submissions: [
          { viewId: 'v1', actorId: 'a', at: iso(0, -10) },
          { viewId: 'v1', actorId: 'a', at: iso(0, -20) },
          { viewId: 'v1', actorId: 'a', at: iso(40) },
        ],
      }),
    );
    expect(u.created.total).toBe(2);
    expect(u.created.daily).toHaveLength(30);
    expect(u.created.daily.at(-1)?.value).toBe(2);
    expect(u.created.daily[0]?.value).toBe(0);
  });
  it('mediana y abandonos sólo si se mide el «empezó»', () => {
    const ev = (kind: 'form_start' | 'form_submit', ref: string, at: string) => ({
      kind,
      screen: 'registrar',
      blockId: 'f',
      actorId: 'a',
      roleKey: null,
      ref,
      at,
    });
    const none = computeUsage(base());
    expect(none.dropoffs).toBeNull();
    expect(none.medianSeconds).toBeNull();
    const u = computeUsage(
      base({
        events: [
          ev('form_start', 'r1', iso(1)),
          ev('form_submit', 'r1', iso(1, 1)),
          ev('form_start', 'r2', iso(1)),
          ev('form_submit', 'r2', iso(1, 3)),
          ev('form_start', 'r3', iso(2)),
          ev('form_start', 'r4', iso(0, -5)),
        ],
      }),
    );
    expect(u.medianSeconds).toBe(120);
    expect(u.measured).toBe(2);
    expect(u.dropoffs).toMatchObject({ started: 4, sent: 2, abandoned: 1, inProgress: 1 });
    expect(u.dropoffs?.rate).toBeCloseTo(1 / 3);
  });
  it('mediana', () => {
    expect(medianOf([])).toBeNull();
    expect(medianOf([5, 1, 3])).toBe(3);
    expect(medianOf([1, 3])).toBe(2);
  });
});
