import { describe, expect, it } from 'vitest';
import { type FakeRow, fakeDb } from '../accounting/sources/fake-db';
import { sheetReceivables } from './sheet-receivables';
import { describeReceivables } from './store';

type Row = FakeRow;

const tracker = {
  id: 't1',
  slug: 'ventas_hoja',
  name: 'Ventas Medellín',
  fields: [
    { key: 'factura' },
    { key: 'fecha' },
    { key: 'valor' },
    { key: 'nit' },
    { key: 'cliente' },
    { key: 'saldo' },
  ],
  origins: [
    {
      kind: 'sheet',
      label: 'hoja',
      ref: 'x',
      fields: ['factura'],
      creates: true,
      writeBack: false,
    },
  ],
};
const source = (precedence: string) => ({
  id: 's1',
  tracker_id: 't1',
  kind: 'ventas',
  label: 'Ventas Medellín',
  mapping: {
    numero: 'factura',
    fecha: 'fecha',
    total: 'valor',
    nit: 'nit',
    nombre: 'cliente',
    saldo: 'saldo',
  },
  precedence,
  options: { currency: 'COP' },
  enabled: true,
  created_at: 't',
  updated_at: 't',
});
const rows = [
  {
    id: 'r1',
    tracker_id: 't1',
    values: {
      factura: 'FV-1',
      fecha: '01/08/2026',
      valor: '1.200',
      nit: '900123456',
      cliente: 'ACME',
      saldo: '1.200',
    },
  },
  {
    id: 'r2',
    tracker_id: 't1',
    values: {
      factura: 'FV-77',
      fecha: '10/08/2026',
      valor: '5.000',
      nit: '800200300',
      cliente: 'BETA',
      saldo: '0',
    },
  },
  {
    id: 'r3',
    tracker_id: 't1',
    values: {
      factura: 'FV-78',
      fecha: '11/08/2026',
      valor: '700',
      nit: '800200300',
      cliente: 'BETA',
      saldo: '700',
    },
  },
];
const input = {
  today: '2026-10-01',
  documents: [],
  accounting: [
    {
      id: 'a1',
      source_system: 'siigo',
      doc_number: 'FV-1',
      client_nit: '900123456',
      counterparty_name: 'ACME',
      currency: 'COP',
      total: 1000,
      balance: 1000,
      issued_on: '2026-08-01',
      due_on: null,
    },
  ],
};

describe('sheetReceivables', () => {
  it('suma sólo lo abierto que no estaba, y cuenta las diferencias', async () => {
    const db = fakeDb({
      trackers: [tracker],
      accounting_sources: [source('program')],
      tracker_rows: rows,
    });
    const r = await sheetReceivables(db, input);
    expect(r.invoices.map((i) => i.number)).toEqual(['FV-78']);
    expect(r.differences).toBe(1);
    expect(r.dropIds.size).toBe(0);
    expect(r.origins).toEqual(['Hoja: Ventas Medellín']);
  });

  it('con precedencia de hoja, reemplaza la del programa', async () => {
    const db = fakeDb({
      trackers: [tracker],
      accounting_sources: [source('sheet')],
      tracker_rows: rows,
    });
    const r = await sheetReceivables(db, input);
    expect(r.invoices.map((i) => i.number).sort()).toEqual(['FV-1', 'FV-78']);
    expect([...r.dropIds]).toEqual(['a1']);
  });

  it('en la ficha de un cliente sólo entra lo de ese cliente', async () => {
    const db = fakeDb({
      trackers: [tracker],
      accounting_sources: [source('program')],
      tracker_rows: rows,
      clients: [{ id: 'c9', name: 'Beta Ltda', tax_id: '800200300' }],
    });
    const r = await sheetReceivables(db, { ...input, clientId: 'c9' });
    expect(r.invoices.map((i) => i.number)).toEqual(['FV-78']);
    const other = fakeDb({
      trackers: [tracker],
      accounting_sources: [source('program')],
      tracker_rows: rows,
      clients: [{ id: 'c8', name: 'Gamma SAS', tax_id: '111222333' }],
    });
    expect((await sheetReceivables(other, { ...input, clientId: 'c8' })).invoices).toEqual([]);
  });

  it('sin fuentes no cambia nada', async () => {
    const r = await sheetReceivables(fakeDb({}), input);
    expect(r.invoices).toEqual([]);
    expect(r.dropIds.size).toBe(0);
  });
});

describe('describeReceivables con hojas', () => {
  const byCurrency = [
    {
      currency: 'COP',
      openInvoices: 3,
      invoiced: 10,
      paid: 0,
      outstanding: 6700,
      ageDays: 30,
      overdue: 0,
      overdueInvoices: 0,
      creditInvoices: 0,
      creditBalance: 0,
    },
  ];
  it('dice de qué hojas sale y avisa de las diferencias', () => {
    const s = describeReceivables({
      byCurrency,
      confirmedInvoices: 0,
      accountingInvoices: 1,
      accountingSystems: ['siigo'],
      sheetInvoices: 2,
      sheetOrigins: ['Hoja: Ventas Medellín'],
      sheetDifferences: 1,
      pendingExcluded: 0,
      withoutCurrency: 0,
      disputedPayments: 0,
      unappliedPayments: 0,
    });
    expect(s).toContain('2 abierta(s) de Hoja: Ventas Medellín');
    expect(s).toContain('valen distinto');
  });
  it('sin hojas la frase es la de siempre', () => {
    const s = describeReceivables({
      byCurrency,
      confirmedInvoices: 3,
      pendingExcluded: 0,
      withoutCurrency: 0,
      disputedPayments: 0,
      unappliedPayments: 0,
    });
    expect(s).not.toContain('Hoja');
  });
});
