import { describe, expect, it } from 'vitest';
import type { SheetData } from '../kb/spreadsheets';
import {
  type Lookups,
  applyOp,
  colIndex,
  diffRow,
  keyPrefix,
  parseSheetSpec,
  planGrouped,
} from './sheet-spec';

const spec = parseSheetSpec({
  version: 1,
  tab: { name: '2026', index: 0 },
  vars: {
    fva: {
      from: 'A',
      ops: [
        { op: 'text' },
        { op: 'replace', pattern: '(?:FLEX|FELX|FLE)[\\s-]*(\\d+)', flags: 'gi', with: 'FLEX $1' },
      ],
    },
    cliente_raw: { from: 'B', ops: [{ op: 'text' }] },
    cliente: {
      from: '$cliente_raw',
      ops: [
        { op: 'replace', pattern: '^BBIC\\s*\\/.*$', flags: 'i', with: 'BBIC' },
        { op: 'map', table: { COLOCAR: 'Colocar Cargo' } },
      ],
    },
    aliado: {
      from: '$cliente_raw',
      ops: [{ op: 'extract', pattern: '^BBIC\\s*\\/+\\s*(.+)$', flags: 'i' }, { op: 'upper' }],
    },
    guia: { from: 'D', ops: [{ op: 'text' }] },
    cargo: {
      from: 'D',
      ops: [{ op: 'upper' }, { op: 'map', table: { ADUANERO: 'cargo' }, unmapped: 'empty' }],
    },
    parcial: {
      from: 'E',
      ops: [{ op: 'upper' }, { op: 'replace', pattern: '\\s+', flags: 'g', with: '' }, { op: 'default', value: 'No' }],
    },
    traslado: { from: 'G', ops: [{ op: 'date', formats: ['M/D/Y'] }] },
    kilos: { from: 'I', ops: [{ op: 'number' }] },
    tarifa: { from: 'J', ops: [{ op: 'number' }] },
    monto: { from: 'K', ops: [{ op: 'number' }] },
    n: { from: 'O', ops: [{ op: 'digits' }] },
    estado: { from: 'P', ops: [{ op: 'test', pattern: 'ok', flags: 'i', then: 'OK', else: 'Pendiente' }] },
  },
  chargeWhen: [{ var: 'cargo', equals: 'cargo' }],
  rowWhen: [
    { var: 'guia', empty: false },
    { var: 'kilos', empty: false },
  ],
  child: {
    tracker: 'guias',
    key: 'imp:{guia}|{n}',
    fields: {
      guia: { var: 'guia' },
      fva: { var: 'fva' },
      aliado: { var: 'aliado' },
      parciales: { var: 'parcial' },
      fecha_traslado: { var: 'traslado' },
      kilos: { var: 'kilos' },
      estado: { var: 'estado', keepIf: ['Enviado a Siigo'] },
      origen: { const: 'Importado', on: 'insert' },
    },
    relations: {
      cliente: { tracker: 'clientes', by: 'label', var: 'cliente' },
      tarifa: { tracker: 'tarifas', by: 'usd_kg', var: 'tarifa', numeric: true },
    },
    parentField: 'manifiesto',
  },
  parent: {
    tracker: 'manifiestos',
    groupVar: 'n',
    key: 'imp:m:{n}',
    fields: {
      n_manifiesto: { agg: 'first', var: 'n' },
      fva: { agg: 'distinct', var: 'fva' },
      cobro: { agg: 'sum', var: 'monto', rows: 'charge' },
      estado: { agg: 'allEqual', var: 'estado', equals: 'OK', else: 'Pendiente', on: 'insert' },
      nombre: {
        on: 'insert',
        derive: [
          { when: [{ field: 'fva', empty: true }], value: 'Sin FVA · {key}' },
          { value: '{fva}' },
        ],
      },
    },
  },
});

const lookups: Lookups = {
  clientes: [
    { id: '11111111-1111-1111-1111-111111111111', label: 'BBIC', values: {} },
    { id: '22222222-2222-2222-2222-222222222222', label: 'Colocar Cargo', values: {} },
  ],
  tarifas: [{ id: '33333333-3333-3333-3333-333333333333', label: '0,09', values: { usd_kg: 0.09 } }],
};

const HEADER = ['FVA', 'CLIENTE', 'VUELO', 'GUIA', 'PARCIALES', 'ARRIBO', 'TRASLADO', 'PIEZAS', 'KILOS', 'TARIFA', 'TOTAL', 'TRM', 'COP', '', 'MANIFIESTO', 'ESTADO'];
const row = (o: Record<number, string | number | null>) =>
  Array.from({ length: 16 }, (_, i) => (i in o ? (o[i] as string | number | null) : null));

const sheet: SheetData = {
  name: '2026',
  rows: [
    HEADER,
    row({ 0: 'FELX -148', 1: 'BBIC // colocar', 3: '196-1', 4: 'P . a', 6: '10/15/2026', 8: 100, 9: 0.09, 14: 'N° 555', 15: 'OK- BBIC' }),
    row({ 0: 'FLEX 148', 1: 'COLOCAR', 3: '196-1', 8: 50, 9: 0.09, 14: 'N° 555', 15: null }),
    row({ 0: 'FLEX 148', 1: 'COLOCAR', 3: '196-1', 8: 20, 9: 0.09, 14: 'N° 555', 15: 'OK' }),
    row({ 1: 'BBIC', 3: 'Aduanero', 8: 1, 9: 600, 10: 600, 14: 'N° 555' }),
    row({ 1: 'NUEVO CLIENTE', 3: '196-9', 8: 5, 9: 0.5, 14: 'N° 777', 15: 'OK' }),
    row({}),
    row({ 1: 'BBIC', 3: '196-8', 8: 7, 9: 0.09 }),
  ],
};

describe('applyOp', () => {
  it('limpia números y fechas de la hoja', () => {
    expect(applyOp('1.234,5', { op: 'number' })).toBe(1234.5);
    expect(applyOp('#REF!', { op: 'number' })).toBeUndefined();
    expect(applyOp('10/15/2026', { op: 'date', formats: ['M/D/Y'] })).toBe('2026-10-15');
    expect(applyOp('15/10/2026', { op: 'date', formats: ['D/M/Y'] })).toBe('2026-10-15');
    expect(applyOp('2026-06-25T00:00:00.000Z', { op: 'date' })).toBe('2026-06-25');
    expect(applyOp(91.935, { op: 'round', digits: 2 })).toBe(91.94);
    expect(applyOp('N° 1165-7', { op: 'digits' })).toBe('11657');
  });
  it('map compara sin tildes ni mayúsculas y puede vaciar lo no mapeado', () => {
    const op = { op: 'map', table: { Aduanero: 'cargo' }, normalize: true, unmapped: 'empty' } as const;
    expect(applyOp('  ADUANERO ', op)).toBe('cargo');
    expect(applyOp('otra', op)).toBeUndefined();
  });
  it('columna por letra o por encabezado', () => {
    expect(colIndex('D', HEADER)).toBe(3);
    expect(colIndex('guia', HEADER)).toBe(3);
    expect(colIndex('ZZ', HEADER)).toBe(-1 + 26 * 26 + 26);
  });
});

describe('planGrouped', () => {
  const plan = planGrouped(sheet, spec, lookups);
  it('arma filas, clave compuesta con sufijo para repetidas y salta lo que no es fila', () => {
    expect(plan.children.map((c) => c.key)).toEqual([
      'imp:196-1|555',
      'imp:196-1|555#2',
      'imp:196-1|555#3',
      'imp:196-9|777',
    ]);
    expect(plan.children.map((c) => c.parentKey)).toEqual(['imp:m:555', 'imp:m:555', 'imp:m:555', 'imp:m:777']);
    // 196-8 no trae manifiesto: sin valor de grupo
    expect(plan.skipped).toEqual({ 'sin valor de grupo': 1 });
  });
  it('limpia valores y separa cliente / aliado', () => {
    const c = plan.children[0];
    expect(c?.values).toMatchObject({
      fva: 'FLEX 148',
      aliado: 'COLOCAR',
      parciales: 'P.A',
      fecha_traslado: '2026-10-15',
      kilos: 100,
      estado: 'OK',
      origen: 'Importado',
    });
    expect(JSON.parse(String(c?.values.cliente)).label).toBe('BBIC');
    expect(JSON.parse(String(plan.children[1]?.values.cliente)).label).toBe('Colocar Cargo');
    expect(plan.children[1]?.values.parciales).toBe('No');
    expect(c?.insertOnly).toEqual(['origen']);
    expect(c?.keepIf.estado).toEqual(['Enviado a Siigo']);
  });
  it('lo que no tiene fila relacionada se reporta y no se inventa', () => {
    expect(plan.unresolved.cliente).toEqual({ 'NUEVO CLIENTE': 1 });
    expect(plan.unresolved.tarifa).toEqual({ '0.5': 1 });
    expect(plan.children[3]?.values.cliente).toBeUndefined();
  });
  it('el cargo no es fila: se suma al manifiesto', () => {
    const m555 = plan.parents.find((p) => p.key === 'imp:m:555');
    expect(m555?.values).toMatchObject({ n_manifiesto: '555', fva: 'FLEX 148', cobro: 600, estado: 'Pendiente', nombre: 'FLEX 148' });
    expect(m555?.childCount).toBe(3);
    expect(m555?.chargeCount).toBe(1);
    expect(m555?.insertOnly.sort()).toEqual(['estado', 'nombre']);
    expect(plan.parents.find((p) => p.key === 'imp:m:777')?.values.nombre).toBe('Sin FVA · 777');
  });
  it('avisa de una columna que ya no está', () => {
    const bad = planGrouped({ name: 'x', rows: [['A']] }, parseSheetSpec({ ...spec, vars: { ...spec.vars, guia: { from: 'Inexistente', ops: [] } } }), lookups);
    expect(bad.missingColumns).toContain('Inexistente');
  });
});

describe('diffRow', () => {
  const planned = {
    key: 'k',
    values: { kilos: 100, estado: 'OK', origen: 'Importado', cliente: JSON.stringify({ id: 'a', label: 'BBIC' }) } as Record<string, string | number>,
    insertOnly: ['origen'],
    keepIf: { estado: ['Enviado a Siigo'] },
  };
  const existing = (values: Record<string, unknown>, updated_at = '2026-10-28T18:00:00Z') => ({
    id: 'r1',
    external_key: 'k',
    values,
    updated_at,
  });
  it('fila nueva: inserta todo', () => {
    const d = diffRow(planned, undefined, null);
    expect(d.action).toBe('insert');
    expect(d.write.origen).toBe('Importado');
  });
  it('sin diferencias y sin tocar lo insert-only', () => {
    const d = diffRow(planned, existing({ kilos: '100', estado: 'OK', origen: 'Nuevo', cliente: { id: 'a', label: 'otro nombre' } }), null);
    expect(d.action).toBe('unchanged');
  });
  it('la hoja gana: cambia sólo lo distinto', () => {
    const d = diffRow(planned, existing({ kilos: 90, estado: 'OK', cliente: JSON.stringify({ id: 'a', label: 'BBIC' }) }), null);
    expect(d.action).toBe('update');
    expect(d.write).toEqual({ kilos: 100 });
    expect(d.changes).toEqual([{ field: 'kilos', before: '90', after: '100' }]);
    expect(d.conflict).toBe(false);
  });
  it('respeta el estado que la app ya avanzó', () => {
    const d = diffRow(planned, existing({ kilos: 100, estado: 'Enviado a Siigo', cliente: JSON.stringify({ id: 'a', label: 'BBIC' }) }), null);
    expect(d.action).toBe('unchanged');
  });
  it('conflicto: editada en la app después de la fecha y distinta de la hoja', () => {
    const base = { kilos: 90, estado: 'OK', cliente: JSON.stringify({ id: 'a', label: 'BBIC' }) };
    expect(diffRow(planned, existing(base, '2026-11-02T10:00:00Z'), '2026-10-28T23:59:59Z').conflict).toBe(true);
    expect(diffRow(planned, existing(base, '2026-10-20T10:00:00Z'), '2026-10-28T23:59:59Z').conflict).toBe(false);
    // editada después pero igual a la hoja: no es conflicto
    expect(diffRow(planned, existing({ ...base, kilos: 100 }, '2026-11-02T10:00:00Z'), '2026-10-28T23:59:59Z').conflict).toBe(false);
  });
  it('idempotente: aplicar lo escrito no cambia nada la segunda vez', () => {
    const first = diffRow(planned, existing({ kilos: 90, estado: 'OK' }), null);
    const second = diffRow(planned, existing({ kilos: 90, estado: 'OK', ...first.write }), null);
    expect(second.action).toBe('unchanged');
  });
});

describe('keyPrefix', () => {
  it('prefijo fijo de la plantilla', () => {
    expect(keyPrefix('import2026:m:{n}')).toBe('import2026:m:');
    expect(keyPrefix('{a}')).toBe('');
  });
});
