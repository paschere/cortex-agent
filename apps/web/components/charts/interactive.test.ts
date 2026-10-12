import { describe, expect, it } from 'vitest';
import {
  RANGES,
  addDaysIso,
  alignProjection,
  askHref,
  askPrompt,
  brushIndexes,
  brushToZoom,
  bucketIndexOf,
  bucketize,
  comparisonValues,
  indexFromPx,
  isZoomed,
  periodSummary,
  rangeById,
  rangeWindow,
  recordsForBucket,
  seriesCsv,
  sliceZoom,
  toCsv,
  zoomAround,
} from './interactive';

const TODAY = '2026-10-10';
const daily = (from: string, n: number, f: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => ({ date: addDaysIso(from, i), value: f(i) }));

describe('rangeWindow', () => {
  it('7 d y 30 d terminan hoy y la anterior queda pegada atrás', () => {
    const r = rangeById('30d');
    expect(rangeWindow(TODAY, r)).toEqual({ from: '2026-09-11', to: TODAY });
    expect(rangeWindow(TODAY, r, 1)).toEqual({ from: '2026-08-12', to: '2026-09-10' });
  });
  it('12 m son meses calendario completos hasta el de hoy', () => {
    const w = rangeWindow(TODAY, rangeById('12m'));
    expect(w).toEqual({ from: '2025-11-01', to: TODAY });
    expect(rangeWindow(TODAY, rangeById('12m'), 1)).toEqual({
      from: '2024-11-01',
      to: '2025-10-31',
    });
  });
});

describe('bucketize', () => {
  const r30 = rangeById('30d');
  it('saldo: arrastra el último valor y suma el horizonte como futuro', () => {
    const pts = [
      { date: '2026-09-01', value: 100 },
      { date: '2026-09-20', value: 150 },
    ];
    const b = bucketize(pts, rangeWindow(TODAY, r30), r30, {
      mode: 'last',
      horizon: 5,
      today: TODAY,
    });
    expect(b).toHaveLength(35);
    expect(b[0]?.value).toBe(100);
    expect(b[9]?.value).toBe(150);
    expect(b[29]?.isNow).toBe(true);
    expect(b[30]?.future).toBe(true);
  });
  it('ventas: suma por semana y deja null antes de que existiera la serie', () => {
    const r = rangeById('90d');
    const pts = daily('2026-08-01', 71, () => 10);
    const b = bucketize(pts, rangeWindow(TODAY, r), r, { mode: 'sum', today: TODAY });
    expect(b).toHaveLength(13);
    expect(b[0]?.value).toBeNull();
    // La serie arranca el 1 ago: las cubetas anteriores no existían (null), no son cero.
    expect(b.find((x) => x.end < '2026-08-01')?.value).toBeNull();
    expect(b[12]?.value).toBe(70);
  });
  it('12 m: doce meses con su etiqueta y título', () => {
    const r = rangeById('12m');
    const b = bucketize([], rangeWindow(TODAY, r), r, { mode: 'sum', today: TODAY });
    expect(b).toHaveLength(12);
    expect(b[0]?.title).toBe('noviembre 2025');
    expect(b.at(-1)?.isNow).toBe(true);
  });
  it('bucketIndexOf encuentra la cubeta de un día', () => {
    const r = rangeById('90d');
    const b = bucketize([], rangeWindow(TODAY, r), r, { mode: 'sum', today: TODAY });
    expect(bucketIndexOf(b, TODAY)).toBe(12);
    expect(bucketIndexOf(b, '2020-01-01')).toBe(-1);
  });
});

describe('comparación y resumen', () => {
  it('alinea la ventana anterior por posición', () => {
    const r = rangeById('7d');
    const pts = daily('2026-09-20', 21, (i) => i);
    const c = comparisonValues(pts, TODAY, r, 'last', 7);
    expect(c).toHaveLength(7);
    // La ventana anterior va del 27 de sep al 3 de oct; su primer día es el índice 7 de la serie.
    expect(rangeWindow(TODAY, r, 1).from).toBe('2026-09-27');
    expect(c[0]).toBe(7);
  });
  it('saldo: cambia contra el inicio; flujo: contra la suma anterior', () => {
    const r = rangeById('7d');
    const b = bucketize(
      daily('2026-10-04', 7, (i) => 100 + i * 10),
      rangeWindow(TODAY, r),
      r,
      {
        mode: 'last',
        today: TODAY,
      },
    );
    const s = periodSummary(b, [], 'last');
    expect(s.current).toBe(160);
    expect(s.previous).toBe(100);
    expect(s.ratio).toBeCloseTo(0.6);
    const f = periodSummary(b, [50, 50, 50, 50, 50, 50, 50], 'sum');
    expect(f.previous).toBe(350);
  });
  it('sin base no inventa porcentaje', () => {
    const r = rangeById('7d');
    const b = bucketize([], rangeWindow(TODAY, r), r, { mode: 'sum', today: TODAY });
    expect(periodSummary(b, [], 'sum').ratio).toBeNull();
  });
});

describe('proyección', () => {
  it('ancla en hoy y toma el último punto de cada cubeta futura', () => {
    const r = rangeById('30d');
    const b = bucketize([], rangeWindow(TODAY, r), r, { mode: 'last', horizon: 3, today: TODAY });
    const proj = [
      { date: '2026-10-11', value: 90, lo: 80, hi: 100 },
      { date: '2026-10-12', value: 70, lo: 60, hi: 85 },
    ];
    const a = alignProjection(b, proj, { index: 29, value: 100 });
    expect(a.values[28]).toBeNull();
    expect(a.values[29]).toBe(100);
    expect(a.values[30]).toBe(90);
    expect(a.values[31]).toBe(70);
    expect(a.lo[31]).toBe(60);
    expect(a.from).toBe(29);
  });
});

describe('pincel y zoom', () => {
  const geo = { n: 10, plotW: 500, hasBars: true };
  it('indexFromPx recorre barras y puntos igual que el gráfico', () => {
    expect(indexFromPx(0, geo)).toBe(0);
    expect(indexFromPx(499, geo)).toBe(9);
    expect(indexFromPx(-20, geo)).toBe(0);
    expect(indexFromPx(250, { ...geo, hasBars: false })).toBeGreaterThan(3);
  });
  it('un arrastre en cualquier sentido da el mismo par; un clic no es pincel', () => {
    expect(brushIndexes(120, 320, geo)).toEqual(brushIndexes(320, 120, geo));
    expect(brushIndexes(120, 320, geo)).toEqual([2, 6]);
    expect(brushIndexes(101, 120, geo)).toBeNull();
  });
  it('el pincel sobre lo visible se vuelve rango del total', () => {
    expect(brushToZoom([10, 30], [2, 6])).toEqual([12, 16]);
  });
  it('acercar respeta el mínimo y alejar vuelve al total', () => {
    expect(zoomAround([0, 29], 30, 0.5, 15)).toEqual([8, 22]);
    const tiny = zoomAround([0, 29], 30, 0.01);
    expect(tiny[1] - tiny[0] + 1).toBe(4);
    expect(zoomAround([8, 22], 30, 4)).toEqual([0, 29]);
    expect(zoomAround([0, 29], 30, 0.5, 0)[0]).toBe(0);
    expect(zoomAround([0, 29], 30, 0.5, 29)[1]).toBe(29);
  });
  it('isZoomed y sliceZoom', () => {
    expect(isZoomed(null, 10)).toBe(false);
    expect(isZoomed([0, 9], 10)).toBe(false);
    expect(isZoomed([2, 9], 10)).toBe(true);
    expect(sliceZoom([0, 1, 2, 3, 4], [1, 3])).toEqual([1, 2, 3]);
  });
});

describe('CSV', () => {
  it('cita comas, comillas y saltos, y deja vacío lo que falta', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['x,y', 'di "hola"'],
          [1.234, null],
          ['l1\nl2', 3],
        ],
      ),
    ).toBe('a,b\r\n"x,y","di ""hola"""\r\n1.23,\r\n"l1\nl2",3');
  });
  it('neutraliza fórmulas', () => {
    expect(toCsv(['n'], [['=SUM(A1)'], ['-5x']])).toContain("'=SUM(A1)");
  });
  it('seriesCsv arma una columna por serie', () => {
    const csv = seriesCsv(
      ['1 oct', '2 oct'],
      [
        { label: 'Caja', values: [10, 20] },
        { label: 'Anterior', values: [5, null] },
      ],
    );
    expect(csv).toBe('Fecha,Caja,Anterior\r\n1 oct,10,5\r\n2 oct,20,');
  });
});

describe('registros detrás de un punto', () => {
  const recs = [
    { id: 'a', date: '2026-10-05', title: 'A', amount: 100 },
    { id: 'b', date: '2026-10-07', title: 'B', amount: -300 },
    { id: 'c', date: '2026-09-01', until: '2026-10-06', title: 'C', amount: 50 },
    { id: 'd', date: '2026-09-01', until: null, title: 'D', amount: 80 },
  ];
  it('flujo: por fecha, el más grande primero', () => {
    const r = recordsForBucket(recs, { start: '2026-10-01', end: '2026-10-10' }, 'flow');
    expect(r.rows.map((x) => x.id)).toEqual(['b', 'a']);
    expect(r.sum).toBe(-200);
  });
  it('saldo: lo que seguía activo al cierre', () => {
    const r = recordsForBucket(recs, { start: '2026-10-01', end: '2026-10-05' }, 'stock');
    expect(r.rows.map((x) => x.id).sort()).toEqual(['a', 'c', 'd']);
    const later = recordsForBucket(recs, { start: '2026-10-01', end: '2026-10-10' }, 'stock');
    expect(later.rows.map((x) => x.id).sort()).toEqual(['a', 'b', 'd']);
  });
  it('limita pero cuenta el total', () => {
    const r = recordsForBucket(recs, { start: '2026-09-01', end: '2026-10-10' }, 'flow', 1);
    expect(r.rows).toHaveLength(1);
    expect(r.total).toBe(4);
  });
});

describe('pregúntale a Cortex', () => {
  it('escribe la pregunta con la métrica y el rango, y la codifica en el enlace', () => {
    const p = askPrompt({
      metric: 'Caja',
      rangePhrase: RANGES[1]?.phrase ?? '',
      from: '2026-09-11',
      to: '2026-10-10',
      headline: '$ 48.200.000',
    });
    expect(p).toContain('«Caja»');
    expect(p).toContain('11 sep al 10 oct');
    expect(askHref(p).startsWith('/chat?prompt=')).toBe(true);
    expect(decodeURIComponent(askHref(p).slice('/chat?prompt='.length))).toBe(p);
  });
});
