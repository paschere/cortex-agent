import { describe, expect, it } from 'vitest';
import {
  normalizeRows,
  parseCurrency,
  parseDateCO,
  parseMoneyCO,
  parseNit,
  previewNormalized,
  proposeMapping,
  validateMapping,
} from './shape';

describe('parseMoneyCO', () => {
  it.each([
    ['$ 1.234.567,89', 1234567.89],
    ['1.234.567', 1234567],
    ['1.234', 1234],
    ['12.5', 12.5],
    ['12,5', 12.5],
    ['1,234', 1234],
    ['1,234,567.50', 1234567.5],
    ['(1.200.000)', -1200000],
    ['-1.200.000', -1200000],
    ['1.200.000-', -1200000],
    ['COP 950.000', 950000],
    ['1234567', 1234567],
    ['0,5', 0.5],
    [4500, 4500],
  ])('%s -> %s', (raw, want) => {
    expect(parseMoneyCO(raw)).toBe(want);
  });
  it.each(['', 'abc', '12abc', '1.2.3,4,5.6', null, undefined, '$'])(
    'no es un monto: %s',
    (raw) => {
      expect(parseMoneyCO(raw)).toBeNull();
    },
  );
});

describe('parseDateCO', () => {
  it.each([
    ['2026-03-04', '2026-03-04'],
    ['2026-03-04T00:00:00Z', '2026-03-04'],
    ['04/03/2026', '2026-03-04'],
    ['4-3-26', '2026-03-04'],
    ['25/12/2025', '2025-12-25'],
    ['12/25/2025', '2025-12-25'],
    ['4 de marzo de 2026', '2026-03-04'],
    ['4-mar-2026', '2026-03-04'],
    [45000, '2023-03-15'],
  ])('%s -> %s', (raw, want) => {
    expect(parseDateCO(raw)).toBe(want);
  });
  it.each(['', 'ayer', '31/02/2026', '99/99/2026', null])('no es fecha: %s', (raw) => {
    expect(parseDateCO(raw)).toBeNull();
  });
});

describe('parseNit', () => {
  it('con DV con guion', () => {
    expect(parseNit('830.025.281-2')).toEqual({ core: '830025281', dv: 2, dvOk: true });
  });
  it('con DV que no coincide', () => {
    expect(parseNit('830.025.281-9')?.dvOk).toBe(false);
  });
  it('con DV pegado y válido', () => {
    expect(parseNit('8300252812')).toEqual({ core: '830025281', dv: 2, dvOk: true });
  });
  it('sin DV', () => {
    expect(parseNit('830025281')).toEqual({ core: '830025281', dv: null, dvOk: null });
  });
  it('basura', () => {
    expect(parseNit('N/A')).toBeNull();
    expect(parseNit('12')).toBeNull();
  });
});

describe('parseCurrency', () => {
  it('lee códigos y alias', () => {
    expect(parseCurrency('usd', 'COP')).toBe('USD');
    expect(parseCurrency('Pesos', 'USD')).toBe('COP');
    expect(parseCurrency('', 'COP')).toBe('COP');
  });
});

const ventasMap = {
  numero: 'factura',
  fecha: 'fecha',
  vencimiento: 'vence',
  nit: 'nit',
  nombre: 'cliente',
  total: 'valor',
  iva: 'iva',
  moneda: 'moneda',
  trm: 'trm',
} as const;
const opts = { sourceId: 's1', origin: 'Hoja: Ventas Medellín' };
const row = (id: string, values: Record<string, unknown>) => ({ id, values });

describe('normalizeRows (ventas)', () => {
  it('normaliza una fila limpia', () => {
    const r = normalizeRows(
      'ventas',
      ventasMap,
      [
        row('1', {
          factura: 'FV-102',
          fecha: '04/03/2026',
          vence: '03/04/2026',
          nit: '900.123.456-8',
          cliente: 'ACME SAS',
          valor: '$ 1.190.000,00',
          iva: '190.000',
        }),
      ],
      opts,
    );
    expect(r.issues.filter((i) => i.severity === 'rechazada')).toEqual([]);
    expect(r.records[0]).toMatchObject({
      number: 'FV-102',
      date: '2026-03-04',
      due: '2026-04-03',
      nit: '900123456',
      total: 1190000,
      tax: 190000,
      currency: 'COP',
      origin: 'Hoja: Ventas Medellín',
    });
  });

  it('reporta las filas sin número, fecha o valor', () => {
    const r = normalizeRows(
      'ventas',
      ventasMap,
      [
        row('a', { factura: '', fecha: '2026-01-01', valor: 100 }),
        row('b', { factura: 'FV-1', fecha: '', valor: 100 }),
        row('c', { factura: 'FV-2', fecha: '2026-01-01', valor: '' }),
        row('d', { factura: 'FV-3', fecha: 'pronto', valor: 5 }),
        row('e', { factura: 'FV-4', fecha: '2026-01-01', valor: 'muchos' }),
        row('f', { factura: '', fecha: '', valor: '' }),
        row('g', { factura: 'FV-5', fecha: '2026-01-02', valor: 10 }),
      ],
      opts,
    );
    expect(r.records.map((x) => x.number)).toEqual(['FV-5']);
    expect(r.issues.map((i) => [i.rowId, i.code])).toEqual([
      ['a', 'sin_numero'],
      ['b', 'sin_fecha'],
      ['c', 'sin_valor'],
      ['d', 'fecha_invalida'],
      ['e', 'valor_invalido'],
    ]);
    expect(r.stats).toMatchObject({ rows: 7, used: 1, rejected: 5, blank: 1 });
  });

  it('un monto negativo es nota crédito y avisa', () => {
    const r = normalizeRows(
      'ventas',
      ventasMap,
      [row('1', { factura: 'NC-1', fecha: '2026-02-01', valor: '(500.000)' })],
      opts,
    );
    expect(r.records[0]).toMatchObject({ total: -500000, creditNote: true });
    expect(r.issues[0]).toMatchObject({ code: 'monto_negativo', severity: 'aviso' });
  });

  it('moneda distinta: con TRM convierte, sin TRM avisa', () => {
    const r = normalizeRows(
      'ventas',
      ventasMap,
      [
        row('1', {
          factura: 'FV-9',
          fecha: '2026-02-01',
          valor: 1000,
          moneda: 'USD',
          trm: '4.000,50',
        }),
        row('2', { factura: 'FV-10', fecha: '2026-02-01', valor: 1000, moneda: 'USD' }),
      ],
      opts,
    );
    expect(r.records[0]?.totalCop).toBe(4000500);
    expect(r.records[1]?.totalCop).toBeNull();
    expect(r.issues.map((i) => i.code)).toEqual(['moneda_sin_trm']);
  });

  it('moneda distinta sin TRM en la fila: usa la TRM oficial del día (también domingo)', () => {
    const trmTable = [{ from: '2026-01-30', to: '2026-02-02', value: 4100 }];
    const r = normalizeRows(
      'ventas',
      ventasMap,
      [
        row('1', { factura: 'FV-11', fecha: '2026-02-01', valor: 1000, moneda: 'USD' }),
        row('2', { factura: 'FV-12', fecha: '2026-03-01', valor: 1000, moneda: 'USD' }),
        row('3', { factura: 'FV-13', fecha: '2026-02-01', valor: 1000, moneda: 'USD', trm: '4.000' }),
      ],
      { ...opts, trmTable },
    );
    expect(r.records[0]).toMatchObject({ totalCop: 4_100_000, trm: 4100 });
    expect(r.records[1]?.totalCop).toBeNull();
    expect(r.records[2]?.totalCop).toBe(4_000_000);
    expect(r.issues.map((i) => i.code)).toEqual(['moneda_sin_trm']);
  });

  it('repetida en la hoja: una vez, o se suman las líneas', () => {
    const rows = [
      row('1', { factura: 'FV-7', fecha: '2026-02-01', nit: '900123456', valor: 100 }),
      row('2', { factura: 'fv 7', fecha: '2026-02-01', nit: '900123456', valor: 50 }),
    ];
    const once = normalizeRows('ventas', ventasMap, rows, opts);
    expect(once.records).toHaveLength(1);
    expect(once.records[0]?.total).toBe(100);
    expect(once.issues[0]?.code).toBe('repetida_en_hoja');
    const sum = normalizeRows('ventas', ventasMap, rows, { ...opts, sumRepeated: true });
    expect(sum.records[0]?.total).toBe(150);
    expect(sum.issues).toEqual([]);
  });

  it('avisa del NIT raro pero deja la fila', () => {
    const r = normalizeRows(
      'ventas',
      ventasMap,
      [row('1', { factura: 'FV-1', fecha: '2026-02-01', nit: 'N/A', valor: 1 })],
      opts,
    );
    expect(r.records).toHaveLength(1);
    expect(r.issues[0]?.code).toBe('nit_invalido');
  });
});

describe('normalizeRows (otros tipos)', () => {
  it('pagos sin número se aceptan, con la factura que pagan', () => {
    const r = normalizeRows(
      'pagos_recibidos',
      { fecha: 'f', total: 'v', factura: 'fac' },
      [row('1', { f: '2026-02-03', v: '800.000', fac: 'FV-102' })],
      opts,
    );
    expect(r.records[0]).toMatchObject({ number: '', invoiceRef: 'FV-102', total: 800000 });
  });

  it('movimientos: débito menos crédito', () => {
    const r = normalizeRows(
      'movimientos',
      { fecha: 'f', cuenta: 'c', debito: 'd', credito: 'k' },
      [row('1', { f: '2026-02-03', c: '130505', d: '', k: '200.000' })],
      opts,
    );
    expect(r.records[0]).toMatchObject({ total: -200000, credit: 200000, debit: null });
  });
});

describe('validateMapping', () => {
  it('pide lo que falta y rechaza columnas inexistentes', () => {
    const v = validateMapping('ventas', { numero: 'a', total: 'zzz' }, ['a', 'b']);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toContain('Fecha');
    expect(v.problems.join(' ')).toContain('zzz');
  });
  it('movimientos necesitan débito, crédito o valor', () => {
    expect(validateMapping('movimientos', { fecha: 'a', cuenta: 'b' }).ok).toBe(false);
    expect(validateMapping('movimientos', { fecha: 'a', cuenta: 'b', debito: 'c' }).ok).toBe(true);
  });
});

describe('proposeMapping', () => {
  const columns = [
    { key: 'n_factura', label: 'N° Factura', type: 'text' },
    { key: 'fecha_emision', label: 'Fecha emisión', type: 'date' },
    { key: 'fecha_vence', label: 'Vence', type: 'date' },
    { key: 'cliente', label: 'Cliente', type: 'text' },
    { key: 'nit', label: 'NIT', type: 'text' },
    { key: 'valor_total', label: 'Valor total', type: 'money' },
    { key: 'iva', label: 'IVA', type: 'money' },
    { key: 'pendiente', label: 'Saldo pendiente', type: 'money' },
    { key: 'notas', label: 'Notas', type: 'text' },
  ];
  const samples = [
    {
      n_factura: 'FV-102',
      fecha_emision: '04/03/2026',
      fecha_vence: '03/04/2026',
      cliente: 'ACME SAS',
      nit: '900.123.456-8',
      valor_total: '$ 1.190.000',
      iva: '190.000',
      pendiente: '1.190.000',
      notas: 'ok',
    },
    {
      n_factura: 'FV-103',
      fecha_emision: '05/03/2026',
      fecha_vence: '04/04/2026',
      cliente: 'BETA LTDA',
      nit: '800.200.300',
      valor_total: '$ 595.000',
      iva: '95.000',
      pendiente: '0',
      notas: '',
    },
  ];

  it('mapea ventas por nombre y contenido', () => {
    const p = proposeMapping('ventas', columns, samples);
    expect(p.mapping).toMatchObject({
      numero: 'n_factura',
      fecha: 'fecha_emision',
      vencimiento: 'fecha_vence',
      nombre: 'cliente',
      nit: 'nit',
      total: 'valor_total',
      iva: 'iva',
      saldo: 'pendiente',
    });
    expect(p.missing).toEqual([]);
    expect(
      validateMapping(
        'ventas',
        p.mapping,
        columns.map((c) => c.key),
      ).ok,
    ).toBe(true);
  });

  it('una columna que dice «fecha» pero trae texto no se usa', () => {
    const p = proposeMapping(
      'ventas',
      [{ key: 'fecha', label: 'Fecha', type: 'text' }],
      [{ fecha: 'pronto' }, { fecha: 'luego' }],
    );
    expect(p.mapping.fecha).toBeUndefined();
    expect(p.missing).toContain('fecha');
  });

  it('en pagos, «Factura» dice qué factura paga, no el recibo', () => {
    const p = proposeMapping(
      'pagos_recibidos',
      [
        { key: 'fecha', label: 'Fecha' },
        { key: 'valor', label: 'Valor' },
        { key: 'factura', label: 'Factura' },
      ],
      [{ fecha: '01/02/2026', valor: '100.000', factura: 'FV-1' }],
    );
    expect(p.mapping.factura).toBe('factura');
    expect(p.mapping.numero).toBeUndefined();
  });

  it('la vista previa trae cinco filas normalizadas', () => {
    const p = proposeMapping('ventas', columns, samples);
    const prev = previewNormalized(
      'ventas',
      p.mapping,
      samples.map((v, i) => row(String(i), v)),
      opts,
    );
    expect(prev.preview).toHaveLength(2);
    expect(prev.preview[1]?.balance).toBe(0);
  });
});
