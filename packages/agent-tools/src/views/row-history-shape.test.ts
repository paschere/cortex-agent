import { describe, expect, it } from 'vitest';
import { trackerFieldSchema } from '../trackers/schema';
import {
  auditEventChanges,
  auditOrigin,
  planUndo,
  undoableKeys,
} from './row-history-shape';

const f = (x: Record<string, unknown>) => trackerFieldSchema.parse(x);
const fields = [
  f({ key: 'estado', label: 'Estado', type: 'select', options: ['Nueva', 'En ruta', 'Entregada'] }),
  f({ key: 'kilos', label: 'Kilos', type: 'number' }),
  f({ key: 'tarifa', label: 'Tarifa', type: 'money' }),
  f({ key: 'total', label: 'Total', type: 'money', formula: '[kilos] * [tarifa]' }),
  f({ key: 'foto', label: 'Foto', type: 'file', accept: 'image' }),
];
const ROW = '11111111-1111-4111-8111-111111111111';

const audit = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  tool_id: 'trackers.upsert',
  status: 'ok',
  decision: 'allowed',
  surface: 'chat',
  mandate_id: null,
  metadata: {
    detail: {
      input: { tracker: 'guias', rowId: ROW, values: { estado: 'En ruta', kilos: 12 } },
      result: { created: false, row: { id: ROW } },
      before: { estado: 'Nueva', kilos: 10 },
    },
  },
  ...over,
});

describe('auditEventChanges', () => {
  it('saca el antes → después de una edición hecha desde el chat', () => {
    expect(auditEventChanges(audit(), ROW)).toEqual({
      estado: { from: 'Nueva', to: 'En ruta' },
      kilos: { from: 10, to: 12 },
    });
  });
  it('ignora creaciones, otras filas y otras herramientas', () => {
    const created = audit({
      metadata: { detail: { input: { values: { a: 1 } }, result: { created: true, row: { id: ROW } } } },
    });
    expect(auditEventChanges(created, ROW)).toBeNull();
    expect(auditEventChanges(audit(), '22222222-2222-4222-8222-222222222222')).toBeNull();
    expect(auditEventChanges(audit({ tool_id: 'trackers.remove' }), ROW)).toBeNull();
  });
  it('sin valores de antes: el campo aparece pero no se sabe de dónde venía', () => {
    const noBefore = audit({
      metadata: {
        detail: {
          input: { values: { kilos: 12 } },
          result: { created: false, row: { id: ROW } },
        },
      },
    });
    expect(auditEventChanges(noBefore, ROW)).toEqual({ kilos: { from: undefined, to: 12 } });
  });
  it('el origen: pedido directo = chat; rutina o permiso delegado = automatización', () => {
    expect(auditOrigin({ decision: 'allowed', surface: 'chat', mandate_id: null })).toBe('chat');
    expect(auditOrigin({ decision: 'allowed', surface: 'schedule', mandate_id: null })).toBe(
      'automation',
    );
    expect(auditOrigin({ decision: 'delegated', surface: 'chat', mandate_id: 'm1' })).toBe(
      'automation',
    );
  });
});

describe('deshacer un cambio', () => {
  const changes = {
    estado: { from: 'Nueva', to: 'En ruta' },
    kilos: { from: 10, to: 12 },
    total: { from: 100, to: 120 },
    foto: { from: null, to: '{"url":"/x"}' },
  };
  it('sólo campos que se pueden devolver a mano y que la pantalla muestra', () => {
    expect(undoableKeys(changes, fields, new Set(['estado', 'kilos', 'total', 'foto']))).toEqual([
      'estado',
      'kilos',
    ]);
    expect(undoableKeys(changes, fields, new Set(['kilos']))).toEqual(['kilos']);
    expect(undoableKeys({ kilos: { from: undefined, to: 5 } }, fields, new Set(['kilos']))).toEqual(
      [],
    );
  });
  it('vuelve cada campo a su valor de antes si hoy sigue valiendo lo que dejó el cambio', () => {
    const plan = planUndo(changes, { estado: 'En ruta', kilos: 12 }, fields, null);
    expect(plan.patch).toEqual({ estado: 'Nueva', kilos: 10 });
    expect(plan.conflicts).toEqual([]);
  });
  it('no pisa lo que alguien cambió después, y no repite lo ya devuelto', () => {
    const plan = planUndo(changes, { estado: 'Entregada', kilos: 10 }, fields, null);
    expect(plan.patch).toEqual({});
    expect(plan.conflicts).toEqual(['estado']);
    expect(plan.already).toEqual(['kilos']);
  });
  it('respeta los campos que el rol puede escribir y deja en blanco lo que antes estaba vacío', () => {
    const plan = planUndo(
      { kilos: { from: null, to: 12 }, estado: { from: 'Nueva', to: 'En ruta' } },
      { kilos: 12, estado: 'En ruta' },
      fields,
      new Set(['kilos']),
    );
    expect(plan.patch).toEqual({ kilos: '' });
  });
});
