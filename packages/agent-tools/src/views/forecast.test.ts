import { describe, expect, it } from 'vitest';
import { forecastBasis, forecastSeries, shiftKey } from './forecast';

const months = (vals: number[], start = '2025-01') =>
  vals.map((value, i) => ({ key: shiftKey(start, 'month', i), value }));

describe('forecastSeries', () => {
  it('trend: continúa una recta y salta el mes en curso', () => {
    // 10 meses completos 100,200,… y el actual (parcial, bajo) en 2025-11
    const series = [...months([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]), { key: '2025-11', value: 5 }];
    const r = forecastSeries({ series, bucket: 'month', periods: 6, method: 'trend', currentKey: '2025-11' });
    expect(r?.method).toBe('trend');
    expect(r?.points.map((p) => p.key)).toEqual(['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05']);
    expect(r?.points[0]?.value).toBeCloseTo(1200, 0);
    expect(r?.points[5]?.value).toBeCloseTo(1700, 0);
    expect(r?.points[0]?.low).toBeCloseTo(1200, 0); // recta perfecta: banda de ancho cero
  });

  it('nunca baja de cero', () => {
    const r = forecastSeries({ series: months([50, 40, 30, 20, 10]), bucket: 'month', periods: 4, method: 'trend', currentKey: '2025-06' });
    expect(r?.points.every((p) => p.value >= 0 && p.low >= 0)).toBe(true);
    expect(r?.points[3]?.value).toBe(0);
  });

  it('average: media de los últimos 3 completos', () => {
    const r = forecastSeries({ series: months([1, 1, 1, 10, 20, 30]), bucket: 'month', periods: 2, method: 'average', currentKey: '2025-07' });
    expect(r?.points[0]?.value).toBe(20);
    expect(r?.basedOn).toBe(3);
    expect(r?.points[0]?.high).toBeGreaterThan(20);
  });

  it('seasonal sin 24 períodos cae a trend', () => {
    const r = forecastSeries({ series: months([1, 2, 3, 4, 5, 6]), bucket: 'month', periods: 2, method: 'seasonal', currentKey: '2025-07' });
    expect(r?.method).toBe('trend');
  });

  it('seasonal con 36 meses repite la temporada', () => {
    const vals = Array.from({ length: 36 }, (_, i) => 1000 + (i % 12 === 11 ? 500 : 0));
    const r = forecastSeries({ series: months(vals), bucket: 'month', periods: 12, method: 'seasonal', currentKey: '2028-01' });
    expect(r?.method).toBe('seasonal');
    expect(r?.points[11]?.value).toBeGreaterThan(r?.points[0]?.value ?? 0);
  });

  it('con menos de 3 períodos completos no proyecta', () => {
    expect(forecastSeries({ series: months([1, 2, 3]), bucket: 'month', periods: 6, method: 'trend', currentKey: '2025-03' })).toBeNull();
  });

  it('semanas: avanza de 7 en 7 días', () => {
    const series = [0, 1, 2, 3].map((i) => ({ key: shiftKey('2025-09-01', 'week', i), value: 10 + i }));
    const r = forecastSeries({ series, bucket: 'week', periods: 2, method: 'trend', currentKey: '2025-10-01' });
    expect(r?.points.map((p) => p.key)).toEqual(['2025-09-29', '2025-10-06']);
  });

  it('fillGaps cuenta los meses vacíos como cero', () => {
    const series = [{ key: '2025-01', value: 100 }, { key: '2025-02', value: 100 }, { key: '2025-05', value: 100 }, { key: '2025-06', value: 100 }];
    const withGaps = forecastSeries({ series, bucket: 'month', periods: 1, method: 'average', currentKey: '2025-08', fillGaps: true });
    expect(withGaps?.points[0]?.value).toBeCloseTo(66.67, 1);
  });
});

describe('forecastBasis', () => {
  it('lo dice en español', () => {
    expect(forecastBasis('trend', 'month', 12)).toBe('tendencia de los últimos 12 meses');
    expect(forecastBasis('average', 'week', 3)).toBe('promedio de las últimas 3 semanas');
  });
});
