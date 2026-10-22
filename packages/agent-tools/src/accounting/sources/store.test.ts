import { describe, expect, it } from 'vitest';
import { type FakeRow, fakeDb } from './fake-db';
import { combineKind } from './read';
import { baseRecord } from './read';
import { listAccountingSources, loadSourceBatches, saveAccountingSource } from './store';

type Row = FakeRow;

const tracker = {
  id: 't1',
  slug: 'ventas_medellin',
  name: 'Ventas Medellín',
  fields: [
    { key: 'factura' },
    { key: 'fecha' },
    { key: 'valor' },
    { key: 'nit' },
    { key: 'cliente' },
  ],
  origins: [
    {
      kind: 'sheet',
      label: 'la hoja «Ventas»',
      ref: 'x',
      fields: ['factura'],
      creates: true,
      writeBack: false,
    },
  ],
};

const mapping = {
  numero: 'factura',
  fecha: 'fecha',
  total: 'valor',
  nit: 'nit',
  nombre: 'cliente',
};

describe('fuentes contables (almacén)', () => {
  const rows = [
    {
      id: 'r1',
      tracker_id: 't1',
      values: {
        factura: 'FV-1',
        fecha: '01/03/2026',
        valor: '$ 1.000',
        nit: '900123456-8',
        cliente: 'ACME',
      },
    },
    {
      id: 'r2',
      tracker_id: 't1',
      values: { factura: 'FV-2', fecha: '02/03/2026', valor: '2.000', nit: '', cliente: 'BETA' },
    },
    {
      id: 'r3',
      tracker_id: 't1',
      values: { factura: '', fecha: '02/03/2026', valor: '5', nit: '', cliente: '' },
    },
  ];
  const source = {
    id: 's1',
    tracker_id: 't1',
    kind: 'ventas',
    label: 'Ventas Medellín',
    mapping,
    precedence: 'program',
    options: { currency: 'COP' },
    enabled: true,
    created_at: 't',
    updated_at: 't',
  };

  it('el origen de una hoja se rotula «Hoja: …»', async () => {
    const db = fakeDb({ trackers: [tracker], accounting_sources: [source], tracker_rows: rows });
    const list = await listAccountingSources(db);
    expect(list[0]).toMatchObject({ origin: 'Hoja: Ventas Medellín', tableOrigin: 'sheet' });
  });

  it('lee, normaliza y reporta lo que no entra', async () => {
    const db = fakeDb({ trackers: [tracker], accounting_sources: [source], tracker_rows: rows });
    const [b] = await loadSourceBatches(db, 'ventas');
    expect(b?.records.map((r) => r.number)).toEqual(['FV-1', 'FV-2']);
    expect(b?.issues.filter((i) => i.severity === 'rechazada').map((i) => i.code)).toEqual([
      'sin_numero',
    ]);
  });

  it('combina con lo del programa sin repetir y resuelve saldos sin columna', async () => {
    const db = fakeDb({ trackers: [tracker], accounting_sources: [source], tracker_rows: rows });
    const base = [
      baseRecord('ventas', {
        rowId: 'a1',
        origin: 'Siigo',
        number: 'FV-1',
        date: '2026-03-01',
        nit: '900123456',
        party: 'ACME',
        total: 1100,
        balance: 0,
        currency: 'COP',
      }),
    ];
    const c = await combineKind(db, 'ventas', base);
    expect(c.result.records.map((r) => [r.number, r.origin, r.balance])).toEqual([
      ['FV-1', 'Siigo', 0],
      ['FV-2', 'Hoja: Ventas Medellín', null],
    ]);
    expect(c.summary.differenceCount).toBe(1);
    expect(c.summary.differences[0]?.message).toContain('FV-1');
    expect(c.summary.rejectedCount).toBe(1);
    expect(c.summary.sheetCount).toBe(1);
  });

  it('sin la tabla de fuentes (migración pendiente) todo sigue como antes', async () => {
    const broken = fakeDb(
      {},
      {
        accounting_sources: {
          code: '42P01',
          message: 'relation "accounting_sources" does not exist',
        },
      },
    );
    expect(await listAccountingSources(broken)).toEqual([]);
    const c = await combineKind(broken, 'ventas', []);
    expect(c.result.records).toEqual([]);
  });

  it('no deja declarar una tabla que llena el programa contable', async () => {
    const siigo = {
      ...tracker,
      slug: 'siigo_facturas',
      origins: [
        {
          kind: 'accounting',
          provider: 'siigo',
          label: 'Siigo',
          ref: 'c',
          fields: ['numero'],
          creates: true,
          writeBack: false,
        },
      ],
    };
    const db = fakeDb({ trackers: [siigo], accounting_sources: [] });
    await expect(
      saveAccountingSource(db, {
        tracker: 'siigo_facturas',
        kind: 'ventas',
        mapping: { numero: 'factura', fecha: 'fecha', total: 'valor' },
      }),
    ).rejects.toThrow(/programa contable/);
  });

  it('rechaza un mapeo con columnas que no existen', async () => {
    const db = fakeDb({ trackers: [tracker], accounting_sources: [] });
    await expect(
      saveAccountingSource(db, {
        tracker: 'ventas_medellin',
        kind: 'ventas',
        mapping: { numero: 'zzz', fecha: 'fecha', total: 'valor' },
      }),
    ).rejects.toThrow(/zzz/);
  });

  it('guarda y vuelve a leer la fuente', async () => {
    const db = fakeDb({ trackers: [tracker], accounting_sources: [] });
    const saved = await saveAccountingSource(db, {
      tracker: 'ventas_medellin',
      kind: 'ventas',
      mapping,
      precedence: 'sheet',
    });
    expect(saved).toMatchObject({
      kind: 'ventas',
      precedence: 'sheet',
      origin: 'Hoja: Ventas Medellín',
    });
  });
});
