import { describe, expect, it } from 'vitest';
import {
  EditHistory,
  duplicateValues,
  fillSeries,
  ghostValues,
  groupByRow,
  groupProgress,
  isFinalStatus,
  looksLikeStatusColumn,
  matchExistingRelation,
  nitKeys,
  planFill,
  rangeStats,
  savedAgo,
  statusTone,
} from './sheet-edit';

describe('fillSeries', () => {
  it('copia una sola celda y repite en ciclo', () => {
    expect(fillSeries(['Sí'], 3)).toEqual(['Sí', 'Sí', 'Sí']);
    expect(fillSeries(['a', 'b'], 5, false)).toEqual(['a', 'b', 'a', 'b', 'a']);
  });
  it('continúa números con paso fijo, sin errores de decimales', () => {
    expect(fillSeries(['1', '2'], 3)).toEqual(['3', '4', '5']);
    expect(fillSeries(['10', '20', '30'], 2)).toEqual(['40', '50']);
    expect(fillSeries(['0.1', '0.2'], 3)).toEqual(['0.3', '0.4', '0.5']);
    expect(fillSeries(['5', '3'], 2)).toEqual(['1', '-1']);
  });
  it('sin patrón en los números, copia en ciclo', () => {
    expect(fillSeries(['1', '2', '4'], 3)).toEqual(['1', '2', '4']);
  });
  it('continúa fechas con paso fijo en días', () => {
    expect(fillSeries(['2026-10-05', '2026-10-06'], 3)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
    expect(fillSeries(['2026-10-01', '2026-10-08'], 2)).toEqual(['2026-10-15', '2026-10-22']);
    expect(fillSeries(['2026-10-05'], 2)).toEqual(['2026-10-05', '2026-10-05']);
  });
  it('continúa texto que termina en número', () => {
    expect(fillSeries(['FLEX 1', 'FLEX 2'], 2)).toEqual(['FLEX 3', 'FLEX 4']);
    expect(fillSeries(['G-009', 'G-010'], 2)).toEqual(['G-011', 'G-012']);
    expect(fillSeries(['A 1', 'B 2'], 2)).toEqual(['A 1', 'B 2']);
  });
  it('con una celda vacía en el origen, copia', () => {
    expect(fillSeries(['1', ''], 2)).toEqual(['1', '']);
  });
});

describe('planFill', () => {
  it('arma un solo lote con lo que cambia y lo que había', () => {
    const plan = planFill('kilos', ['1', '2'], [
      { id: 'a', before: '' },
      { id: 'b', before: '4' },
      { id: 'c', before: '9' },
    ]);
    expect(plan).toEqual([
      { rowId: 'a', key: 'kilos', before: '', after: '3' },
      { rowId: 'c', key: 'kilos', before: '9', after: '5' },
    ]);
  });
  it('relaciones y opciones sólo se copian', () => {
    const plan = planFill('estado', ['OK'], [{ id: 'a', before: 'Pendiente' }, { id: 'b', before: 'OK' }], false);
    expect(plan).toEqual([{ rowId: 'a', key: 'estado', before: 'Pendiente', after: 'OK' }]);
  });
});

describe('rangeStats', () => {
  it('suma, promedio, mínimo, máximo y cuenta de los numéricos', () => {
    const s = rangeStats([10, '20', null, '', 'x', '3,5']);
    expect(s.count).toBe(4);
    expect(s.numeric).toBe(3);
    expect(s.sum).toBeCloseTo(33.5);
    expect(s.avg).toBeCloseTo(11.1666, 3);
    expect(s.min).toBe(3.5);
    expect(s.max).toBe(20);
  });
  it('sin números no hay promedio', () => {
    const s = rangeStats(['a', 'b']);
    expect(s.avg).toBeNull();
    expect(s.count).toBe(2);
  });
});

describe('EditHistory (deshacer y rehacer)', () => {
  const e = { label: 'Kilos → 5', changes: [{ rowId: 'a', key: 'kilos', before: '1', after: '5' }] };
  it('deshacer devuelve el valor de antes con `expect` = lo de después', () => {
    const h = new EditHistory();
    h.push(e);
    const took = h.takeUndo();
    expect(took?.write).toEqual([{ rowId: 'a', key: 'kilos', before: '5', after: '1' }]);
    expect(groupByRow(took?.write ?? [])).toEqual([{ rowId: 'a', patch: { kilos: '1' }, expect: { kilos: '5' } }]);
    h.confirmUndo(took?.entry as typeof e);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(true);
    const again = h.takeRedo();
    expect(again?.write[0]?.after).toBe('5');
    h.confirmRedo(again?.entry as typeof e);
    expect(h.canUndo).toBe(true);
  });
  it('un cambio nuevo borra lo que se podía rehacer; si falla, se devuelve a su lugar', () => {
    const h = new EditHistory();
    h.push(e);
    const t = h.takeUndo();
    h.confirmUndo(t?.entry as typeof e);
    h.push({ label: 'otro', changes: [{ rowId: 'b', key: 'k', before: '', after: '1' }] });
    expect(h.canRedo).toBe(false);
    const t2 = h.takeUndo();
    h.restoreUndo(t2?.entry as typeof e);
    expect(h.nextUndo?.label).toBe('otro');
  });
  it('respeta el límite y no anota lotes vacíos', () => {
    const h = new EditHistory(2);
    h.push({ label: 'x', changes: [] });
    expect(h.canUndo).toBe(false);
    for (const n of ['1', '2', '3']) h.push({ label: n, changes: [{ rowId: n, key: 'k', before: '', after: n }] });
    h.takeUndo();
    h.takeUndo();
    expect(h.takeUndo()).toBeNull();
  });
});

describe('fila fantasma y duplicar', () => {
  it('la fila fantasma dentro de un grupo hereda el valor de agrupación', () => {
    expect(ghostValues({ draft: { guia: '172-1' }, groupField: 'manifiesto', groupKey: 'uuid-1' })).toEqual({
      guia: '172-1',
      manifiesto: 'uuid-1',
    });
  });
  it('lo elegido a mano en la fila manda sobre el grupo; sin grupo no inventa', () => {
    expect(ghostValues({ draft: { manifiesto: 'x' }, groupField: 'manifiesto', groupKey: 'g' })).toEqual({ manifiesto: 'x' });
    expect(ghostValues({ draft: { guia: ' a ' }, groupField: null, groupKey: null })).toEqual({ guia: 'a' });
    expect(ghostValues({ draft: { guia: '' }, groupField: 'm', groupKey: 'g' })).toEqual({ m: 'g' });
  });
  it('duplicar marca la clave como copia y omite vacíos', () => {
    const fields = [
      { key: 'guia', type: 'text' },
      { key: 'kilos', type: 'number' },
      { key: 'vuelo', type: 'text' },
    ];
    expect(duplicateValues(fields, { guia: 'G1', kilos: 12.5, vuelo: null }, 'guia')).toEqual({
      guia: 'G1 (copia)',
      kilos: '12.5',
    });
    expect(duplicateValues([{ key: 'n', type: 'number' }], { n: 4 }, 'n')).toEqual({});
  });
});

describe('relación que ya existe (crear sin duplicar)', () => {
  const existing = [
    { id: '1', label: 'Aeroexpress SAS', values: { nit: '900.123.456-7' } },
    { id: '2', label: 'Carga del Sur', values: { nit: '901222333' } },
  ];
  it('por nombre normalizado', () => {
    expect(matchExistingRelation(existing, '  aeroéxpress   sas ')?.id).toBe('1');
    expect(matchExistingRelation(existing, 'Otro Cliente')).toBeNull();
  });
  it('por NIT con o sin puntos y dígito de verificación', () => {
    expect(matchExistingRelation(existing, '900123456')?.id).toBe('1');
    expect(matchExistingRelation(existing, '900.123.456-7')?.id).toBe('1');
    expect(matchExistingRelation(existing, '901222333-4')?.id).toBe('2');
    expect(nitKeys('Aeroexpress')).toEqual([]);
  });
});

describe('estados', () => {
  it('tono y estado final', () => {
    expect(statusTone('Pendiente')).toBe('amber');
    expect(statusTone('OK')).toBe('emerald');
    expect(statusTone('OK-BBIC')).toBe('emerald');
    expect(statusTone('Rechazado')).toBe('rose');
    expect(statusTone('Enviado a Siigo')).toBe('sky');
    expect(statusTone('Algo raro')).toBeNull();
    expect(isFinalStatus('Enviado a Siigo')).toBe(true);
    expect(isFinalStatus('Pendiente')).toBe(false);
  });
  it('avance del grupo', () => {
    expect(groupProgress(['OK', 'Pendiente', 'Rechazado', 'Enviado a Siigo'])).toEqual({ done: 2, total: 4, rejected: 1 });
    expect(looksLikeStatusColumn(['Pendiente', 'OK', 'Rechazado'])).toBe(true);
    expect(looksLikeStatusColumn(['Sí', 'No'])).toBe(false);
  });
  it('hace cuánto se guardó', () => {
    expect(savedAgo(1000)).toBe('ahora mismo');
    expect(savedAgo(2000 + 8000)).toBe('hace 10 s');
    expect(savedAgo(125_000)).toBe('hace 2 min');
  });
});
