import { describe, expect, it } from 'vitest';
import { type ViewSource, computeView, matches } from './compute';
import { type CatalogTracker, checkSpecAgainst, slugify, viewSpecSchema } from './spec';
import { hashViewPassword, verifyViewPassword } from './store';

const remates: CatalogTracker = {
  slug: 'remates',
  name: 'Remates',
  fields: [
    { key: 'nombre', label: 'Nombre', type: 'text', required: true },
    { key: 'ciudad', label: 'Ciudad', type: 'text', required: false },
    { key: 'valor', label: 'Valor', type: 'money', required: false },
    { key: 'fecha', label: 'Fecha', type: 'date', required: false },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: false,
      options: ['Nuevo', 'En curso', 'Cerrado'],
    },
  ],
};

const row = (id: string, values: Record<string, string | number>) => ({
  id,
  label: String(values.nombre ?? id),
  values,
  created_at: '2026-09-01T15:00:00Z',
  updated_at: '2026-09-20T15:00:00Z',
});

const sources = new Map<string, ViewSource>([
  [
    'remates',
    {
      tracker: remates,
      truncated: false,
      rows: [
        row('1', {
          nombre: 'Lote A',
          ciudad: 'Medellín',
          valor: 100,
          fecha: '2026-09-25',
          estado: 'Nuevo',
        }),
        row('2', {
          nombre: 'Lote B',
          ciudad: 'Bogotá',
          valor: 300,
          fecha: '2026-09-30',
          estado: 'En curso',
        }),
        row('3', {
          nombre: 'Lote C',
          ciudad: 'Medellín',
          valor: 50,
          fecha: '2026-08-01',
          estado: 'Cerrado',
        }),
        row('4', { nombre: 'Lote D', valor: 10 }),
      ],
    },
  ],
]);

const NOW = new Date('2026-09-24T17:00:00Z');

describe('el contrato de una vista', () => {
  it('rechaza ids de bloque repetidos y filtros sin valor', () => {
    const bad = viewSpecSchema.safeParse({
      version: 1,
      blocks: [
        { id: 'a', type: 'text', markdown: 'hola' },
        {
          id: 'a',
          type: 'metric',
          title: 'X',
          tracker: 'remates',
          filters: [{ field: 'valor', op: 'gt' }],
        },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it('comprueba tablas y campos contra el catálogo real', () => {
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [
        {
          id: 'm',
          type: 'metric',
          title: 'Total',
          tracker: 'remates',
          aggregate: 'sum',
          field: 'ciudad',
        },
        { id: 'b', type: 'board', title: 'Tablero', tracker: 'remates', groupBy: 'ciudad' },
        { id: 'x', type: 'table', title: 'Otra', tracker: 'no_existe' },
        { id: 'f', type: 'form', title: 'Nuevo', tracker: 'remates', fields: ['label'] },
      ],
    });
    const problems = checkSpecAgainst(spec, [remates]).join(' ');
    expect(problems).toContain('«ciudad» no es numérico');
    expect(problems).toContain('agrupa por un campo de opciones');
    expect(problems).toContain('«no_existe» no existe');
    expect(problems).toContain('no «label»');
  });

  it('slug legible desde el nombre', () => {
    expect(slugify('Remates de Medellín 2026')).toBe('remates_de_medellin_2026');
    expect(slugify('2026')).toBe('v_2026');
  });
});

describe('de spec a pantalla', () => {
  it('cifras con filtros de fecha en Bogotá y formato de dinero', () => {
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [
        {
          id: 'total',
          type: 'metric',
          title: 'Valor',
          tracker: 'remates',
          aggregate: 'sum',
          field: 'valor',
        },
        {
          id: 'semana',
          type: 'metric',
          title: 'Esta semana',
          tracker: 'remates',
          filters: [{ field: 'fecha', op: 'next_days', value: 7 }],
        },
      ],
    });
    const [total, semana] = computeView(spec, sources, NOW).blocks;
    expect(total).toMatchObject({ type: 'metric', value: 460 });
    expect(total?.type === 'metric' && total.display).toMatch(/460/);
    expect(semana).toMatchObject({ type: 'metric', value: 2 });
  });

  it('gráfico por texto agrupa, ordena y junta el resto en «Otros»', () => {
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [
        {
          id: 'c',
          type: 'chart',
          title: 'Por ciudad',
          tracker: 'remates',
          groupBy: 'ciudad',
          aggregate: 'sum',
          field: 'valor',
          limit: 2,
        },
      ],
    });
    const [chart] = computeView(spec, sources, NOW).blocks;
    expect(chart?.type === 'chart' && chart.points.map((p) => [p.label, p.value])).toEqual([
      ['Bogotá', 300],
      ['Otros', 160],
    ]);
  });

  it('tablero en el orden de las opciones, con los sueltos aparte', () => {
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [{ id: 'b', type: 'board', title: 'Estado', tracker: 'remates', groupBy: 'estado' }],
    });
    const [board] = computeView(spec, sources, NOW).blocks;
    expect(board?.type === 'board' && board.columns.map((c) => [c.label, c.count])).toEqual([
      ['Nuevo', 1],
      ['En curso', 1],
      ['Cerrado', 1],
      ['Sin estado', 1],
    ]);
  });

  it('una tabla entrega sólo las columnas que pidió', () => {
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [
        {
          id: 't',
          type: 'table',
          title: 'Lista',
          tracker: 'remates',
          columns: ['label', 'valor'],
          sort: { field: 'valor', dir: 'desc' },
        },
      ],
    });
    const [table] = computeView(spec, sources, NOW).blocks;
    if (table?.type !== 'table') throw new Error('esperaba tabla');
    expect(table.columns.map((c) => c.key)).toEqual(['label', 'valor']);
    expect(table.rows[0]?.cells[0]).toBe('Lote B');
    expect(table.rows.every((r) => r.cells.length === 2)).toBe(true);
  });

  it('un campo que desapareció se pinta como aviso, no rompe la vista', () => {
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [
        { id: 't', type: 'table', title: 'Lista', tracker: 'remates', columns: ['borrado'] },
        { id: 'ok', type: 'text', markdown: 'sigue' },
      ],
    });
    const [gone, ok] = computeView(spec, sources, NOW).blocks;
    expect(gone?.type).toBe('problem');
    expect(ok?.type).toBe('text');
  });

  it('filtros de fecha comparan contra hoy en Bogotá', () => {
    const r = row('x', { fecha: '2026-09-24' });
    expect(matches(remates, r, { field: 'fecha', op: 'before_today' }, '2026-09-24')).toBe(false);
    expect(matches(remates, r, { field: 'fecha', op: 'last_days', value: 3 }, '2026-09-24')).toBe(
      true,
    );
  });
});

describe('contraseñas', () => {
  it('scrypt con sal: verifica la buena, rechaza la mala', async () => {
    const hash = await hashViewPassword('cortex-2026');
    expect(hash).toMatch(/^scrypt\$[A-Za-z0-9_-]{16,64}\$[A-Za-z0-9_-]{64,128}$/);
    expect(await verifyViewPassword('cortex-2026', hash)).toBe(true);
    expect(await verifyViewPassword('cortex-2025', hash)).toBe(false);
    expect(await hashViewPassword('cortex-2026')).not.toBe(hash);
  });
});
