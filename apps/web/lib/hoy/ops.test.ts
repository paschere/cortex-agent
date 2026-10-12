import { describe, expect, it } from 'vitest';
import { activityRows, buildOps, changeVsAverage, whenLabel, whoPhrase } from './ops';

const runs = (n: number, done: (i: number) => number, failed: (i: number) => number = () => 0) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date('2026-10-10T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - i);
    return { day: d.toISOString().slice(0, 10), done: done(i), failed: failed(i) };
  });

describe('buildOps', () => {
  it('arma los cuatro con historia donde la hay', () => {
    const kpis = buildOps({
      today: '2026-10-10',
      runs: runs(
        10,
        (i) => (i === 0 ? 8 : 4),
        (i) => (i === 0 ? 1 : 0),
      ),
      approvals: { count: 3, oldestDays: 4 },
      commitments: { overdue: 2, oldestDays: 6 },
    });
    expect(kpis.map((k) => k.id)).toEqual(['hecho', 'errores', 'aprobaciones', 'compromisos']);
    expect(kpis[0]?.value).toBe('8');
    expect(kpis[0]?.spark).toHaveLength(14);
    expect(kpis[0]?.ratio).toBeGreaterThan(0);
    expect(kpis[1]?.alert).toBe(true);
    expect(kpis[2]?.alert).toBe(true);
    expect(kpis[2]?.hint).toBe('la más vieja lleva 4 días');
    expect(kpis[3]?.spark).toEqual([]);
  });
  it('no inventa lo que no se lee', () => {
    expect(
      buildOps({ today: '2026-10-10', runs: null, approvals: null, commitments: null }),
    ).toEqual([]);
  });
});

describe('changeVsAverage', () => {
  it('sin base no hay cambio', () => {
    expect(changeVsAverage([0, 0, 0, 5])).toBeNull();
    expect(changeVsAverage([4, 4, 4, 6])).toBeCloseTo(0.5);
  });
});

describe('activityRows', () => {
  it('dice quién y sobre qué', () => {
    expect(whoPhrase('auto', null)).toBe('Solo, con permiso');
    expect(whoPhrase('approved', null)).toBe('Aprobado por ti');
    expect(whoPhrase('direct', 'Ana')).toBe('Pedido por Ana');
    const rows = activityRows(
      [
        {
          key: 'a',
          eventIds: ['a'],
          at: '2026-10-10T19:32:00Z',
          day: '2026-10-10',
          text: 'Envié un correo',
          group: 'email',
          how: 'approved',
          failed: false,
          userId: 'me',
          undoLabel: null,
        },
      ],
      { meId: 'me', now: new Date('2026-10-10T20:00:00Z') },
    );
    expect(rows[0]).toMatchObject({ on: 'Correo', who: 'Aprobado por ti', when: 'Hoy 14:32' });
    expect(whenLabel('2026-10-03T21:10:00Z', new Date('2026-10-10T20:00:00Z'))).toContain('16:10');
  });
});
