import { describe, expect, it } from 'vitest';
import {
  areaPath,
  bandPath,
  dataState,
  deltaRatio,
  describeTrend,
  formatCompact,
  formatDelta,
  formatFull,
  labelIndexes,
  monotonePath,
  niceDomain,
  niceTicks,
  roundedBar,
  segmentShares,
  shortDay,
  toneOfClass,
} from './scales';

describe('niceTicks', () => {
  it('cubre el rango con marcas redondas', () => {
    const t = niceTicks(0, 87);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(87);
    expect(t.every((v) => v % 5 === 0 || v % 2.5 === 0)).toBe(true);
  });
  it('incluye negativos', () => {
    const t = niceTicks(-30, 100);
    expect(t[0]).toBeLessThanOrEqual(-30);
    expect(t).toContain(0);
  });
  it('rango plano o cero no revienta', () => {
    expect(niceTicks(0, 0)).toEqual([0, 1]);
    expect(niceTicks(5, 5).length).toBeGreaterThanOrEqual(2);
    expect(niceTicks(Number.NaN, 3)).toEqual([0, 1]);
  });
  it('niceDomain incluye el cero por defecto', () => {
    const d = niceDomain([40, 90]);
    expect(d.min).toBe(0);
    expect(d.max).toBeGreaterThanOrEqual(90);
    expect(niceDomain([40, 90], { includeZero: false }).min).toBeGreaterThan(0);
  });
});

describe('formatCompact (es-CO)', () => {
  it('cifras chicas con punto de miles', () => {
    expect(formatFull(1240)).toBe('1.240');
    expect(formatCompact(1240)).toBe('1.240');
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(12.5)).toBe('12,5');
  });
  it('miles, millones y miles de millones', () => {
    expect(formatCompact(48_000)).toBe('48 mil');
    expect(formatCompact(48_200_000)).toBe('48,2 M');
    expect(formatCompact(1_200_000_000)).toBe('1,2 mil M');
  });
  it('dinero, porcentaje y signo', () => {
    expect(formatCompact(48_200_000, { money: true })).toBe('$ 48,2 M');
    expect(formatCompact(-3_500_000, { money: true })).toBe('−$ 3,5 M');
    expect(formatCompact(12, { percent: true })).toBe('12 %');
    expect(formatCompact(-0.01)).toBe('0');
  });
});

describe('deltas', () => {
  it('calcula y escribe el cambio', () => {
    expect(deltaRatio(110, 100)).toBeCloseTo(0.1);
    expect(deltaRatio(5, 0)).toBeNull();
    expect(formatDelta(0.124)).toBe('+12 %');
    expect(formatDelta(-0.08)).toBe('−8 %');
    expect(formatDelta(0)).toBe('= 0 %');
    expect(formatDelta(null)).toBe('nuevo');
  });
});

describe('monotonePath', () => {
  const pts = [
    { x: 0, y: 10 },
    { x: 10, y: 10 },
    { x: 20, y: 0 },
    { x: 30, y: 0 },
  ];
  it('arma una cúbica por tramo', () => {
    const d = monotonePath(pts);
    expect(d.startsWith('M0,10')).toBe(true);
    expect((d.match(/C/g) ?? []).length).toBe(3);
  });
  it('no se pasa de los datos en un tramo plano', () => {
    // Entre dos puntos iguales los controles quedan a la misma altura.
    const d = monotonePath(pts);
    const first = d.split('C')[1] ?? '';
    const ys = first.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    expect(ys[1]).toBe(10);
    expect(ys[3]).toBe(10);
  });
  it('casos de 0, 1 y 2 puntos', () => {
    expect(monotonePath([])).toBe('');
    expect(monotonePath([{ x: 1, y: 2 }])).toBe('M1,2');
    expect(
      monotonePath([
        { x: 0, y: 0 },
        { x: 5, y: 5 },
      ]),
    ).toBe('M0,0L5,5');
  });
  it('área y banda se cierran', () => {
    expect(areaPath(pts, 40).endsWith('Z')).toBe(true);
    expect(areaPath([pts[0] as { x: number; y: number }], 40)).toBe('');
    const lo = pts.map((p) => ({ x: p.x, y: p.y + 5 }));
    expect(bandPath(pts, lo).endsWith('Z')).toBe(true);
  });
});

describe('roundedBar', () => {
  it('dibuja hacia arriba y hacia abajo', () => {
    expect(roundedBar(0, 100, 40, 10)).toContain('V44');
    expect(roundedBar(0, 100, 160, 10)).toContain('V156');
  });
  it('una barra invisible no dibuja nada', () => {
    expect(roundedBar(0, 100, 100.1, 10)).toBe('');
    expect(roundedBar(0, 100, 50, 0)).toBe('');
  });
});

describe('estado y descripción', () => {
  it('dataState', () => {
    expect(dataState([])).toBe('empty');
    expect(dataState([[null, null]])).toBe('empty');
    expect(dataState([[0, 0, 0]])).toBe('zero');
    expect(dataState([[null, 5]])).toBe('single');
    expect(dataState([[1, 2]])).toBe('ok');
  });
  it('describeTrend dice de dónde a dónde', () => {
    const s = describeTrend({
      name: 'Caja',
      labels: ['lun', 'mar', 'mié'],
      values: [10, 30, 20],
      format: (n) => `$${n}`,
    });
    expect(s).toContain('de $10 (lun) a $20 (mié)');
    expect(s).toContain('sube 100 %');
    expect(s).toContain('Máximo $30 (mar)');
  });
  it('labelIndexes y segmentShares', () => {
    expect(labelIndexes(5, 10)).toEqual([0, 1, 2, 3, 4]);
    const idx = labelIndexes(13, 4);
    expect(idx[0]).toBe(0);
    expect(idx.length).toBeLessThanOrEqual(5);
    const segs = segmentShares([
      { key: 'a', value: 30 },
      { key: 'b', value: 0 },
      { key: 'c', value: 70 },
    ]);
    expect(segs.map((s) => s.key)).toEqual(['a', 'c']);
    expect(segs[1]?.start).toBeCloseTo(0.3);
    expect(segmentShares([{ key: 'a', value: 0 }])).toEqual([]);
  });
});

describe('ayudas de rótulos', () => {
  it('shortDay y toneOfClass', () => {
    expect(shortDay('2026-09-30')).toBe('30 sep');
    expect(shortDay('2026-01-05T10:00:00Z')).toBe('5 ene');
    expect(shortDay('hoy')).toBe('hoy');
    expect(toneOfClass('bg-rose')).toBe('rose');
    expect(toneOfClass('bg-ink-faint/40')).toBe('ink');
  });
});
