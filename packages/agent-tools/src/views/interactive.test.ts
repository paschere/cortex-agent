import { describe, expect, it } from 'vitest';
import { type ViewSource, computeView } from './compute';
import { type CatalogTracker, checkSpecAgainst, viewSpecSchema } from './spec';
import { canWriteView } from './store';

const pagos: CatalogTracker = {
  slug: 'facturas',
  name: 'Facturas',
  fields: [
    { key: 'cliente', label: 'Cliente', type: 'text', required: true },
    { key: 'valor', label: 'Valor', type: 'money', required: false },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: false,
      options: ['Pendiente', 'Pagada'],
    },
  ],
};

const row = (id: string, created: string, values: Record<string, string | number>) => ({
  id,
  label: String(values.cliente),
  values,
  created_at: created,
  updated_at: created,
});

const sources = new Map<string, ViewSource>([
  [
    'facturas',
    {
      tracker: pagos,
      truncated: false,
      rows: [
        row('1', '2026-09-20T10:00:00Z', { cliente: 'Acme', valor: 100, estado: 'Pendiente' }),
        row('2', '2026-09-24T10:00:00Z', { cliente: 'Nexa', valor: 900, estado: 'Pendiente' }),
      ],
    },
  ],
]);

const spec = viewSpecSchema.parse({
  version: 1,
  editing: 'team',
  refreshSeconds: 10,
  alerts: [
    { id: 'nuevas', source: 'facturas', filters: [{ field: 'valor', op: 'gte', value: 500 }] },
  ],
  blocks: [
    {
      id: 't',
      type: 'table',
      title: 'Facturas',
      tracker: 'facturas',
      columns: ['cliente', 'valor', 'estado'],
      editable: ['estado'],
      actions: [
        {
          id: 'pagar',
          label: 'Marcar pagada',
          kind: 'set_field',
          field: 'estado',
          value: 'Pagada',
        },
      ],
    },
    {
      id: 'b',
      type: 'board',
      title: 'Estados',
      tracker: 'facturas',
      groupBy: 'estado',
      draggable: true,
    },
  ],
});

describe('vistas que se editan y tienen botones', () => {
  it('el contrato acepta una vista interactiva sobre una tabla propia', () => {
    expect(checkSpecAgainst(spec, [pagos])).toEqual([]);
  });

  it('pide editing ≠ off y rechaza botones con valores que no son opciones', () => {
    const off = viewSpecSchema.parse({ ...spec, editing: 'off' });
    expect(checkSpecAgainst(off, [pagos]).join(' ')).toContain('editing');
    const bad = viewSpecSchema.parse({
      ...spec,
      blocks: [
        {
          id: 't',
          type: 'table',
          title: 'x',
          tracker: 'facturas',
          actions: [
            { id: 'a', label: 'Anular', kind: 'set_field', field: 'estado', value: 'Anulada' },
          ],
        },
      ],
    });
    expect(checkSpecAgainst(bad, [pagos]).join(' ')).toContain('no es una opción');
  });

  it('las fuentes de la plataforma no se editan ni llevan botones', () => {
    const plat = viewSpecSchema.parse({
      version: 1,
      editing: 'team',
      blocks: [
        { id: 't', type: 'table', title: 'Ventas', tracker: 'cortex.ventas', editable: ['estado'] },
      ],
    });
    const catalog = [{ slug: 'cortex.ventas', name: 'Ventas', fields: pagos.fields }];
    expect(checkSpecAgainst(plat, catalog).join(' ')).toContain('sólo lectura');
  });

  it('quién escribe: nadie, el equipo, o también el enlace', () => {
    expect(canWriteView({ spec: { ...spec, editing: 'off' } }, 'member')).toBe(false);
    expect(canWriteView({ spec }, 'member')).toBe(true);
    expect(canWriteView({ spec }, 'public')).toBe(false);
    expect(canWriteView({ spec: { ...spec, editing: 'public' } }, 'public')).toBe(true);
  });

  it('sin permiso de escribir, el cálculo no entrega ni celdas editables ni botones', () => {
    const readOnly = computeView(spec, sources, new Date('2026-09-25T12:00:00Z'));
    const table = readOnly.blocks[0];
    if (table?.type !== 'table') throw new Error('tabla');
    expect(table.columns.some((c) => c.edit)).toBe(false);
    expect(table.actions).toEqual([]);
    const board = readOnly.blocks[1];
    expect(board?.type === 'board' && board.dragField).toBe(null);

    const writable = computeView(spec, sources, new Date('2026-09-25T12:00:00Z'), {
      writable: true,
    });
    const t2 = writable.blocks[0];
    if (t2?.type !== 'table') throw new Error('tabla');
    expect(t2.columns.find((c) => c.key === 'estado')?.edit?.options).toEqual([
      'Pendiente',
      'Pagada',
    ]);
    expect(t2.actions.map((a) => a.id)).toEqual(['pagar']);
    // El botón no viaja con el valor que escribe: ése lo pone el servidor.
    expect(JSON.stringify(t2.actions)).not.toContain('Pagada');
  });

  it('la alerta trae las filas recientes que cumplen sus filtros', () => {
    const v = computeView(spec, sources, new Date('2026-09-25T12:00:00Z'));
    expect(v.refreshSeconds).toBe(10);
    expect(v.alerts[0]?.rows.map((r) => r.label)).toEqual(['Nexa']);
  });
});
