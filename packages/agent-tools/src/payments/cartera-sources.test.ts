import { describe, expect, it } from 'vitest';
import { type FakeRow, fakeDb } from '../accounting/sources/fake-db';
import { buildCartera } from './cartera';
import { readCartera } from './cartera-read';

type Row = FakeRow;

const sheetTracker = {
  id: 't1',
  slug: 'ventas_hoja',
  name: 'Ventas Medellín',
  fields: [
    { key: 'factura' },
    { key: 'fecha' },
    { key: 'vence' },
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
const source = {
  id: 's1',
  tracker_id: 't1',
  kind: 'ventas',
  label: 'Ventas Medellín',
  mapping: {
    numero: 'factura',
    fecha: 'fecha',
    vencimiento: 'vence',
    total: 'valor',
    nit: 'nit',
    nombre: 'cliente',
    saldo: 'saldo',
  },
  precedence: 'program',
  options: { currency: 'COP' },
  enabled: true,
  created_at: 't',
  updated_at: 't',
};
const siigoInvoice = {
  id: 'a1',
  source_system: 'siigo',
  doc_number: 'FV-1',
  client_id: null,
  client_nit: '900123456',
  counterparty_name: 'ACME SAS',
  currency: 'COP',
  total: 1000,
  balance: 1000,
  issued_on: '2026-08-01',
  due_on: '2026-09-01',
  public_url: null,
  annulled: false,
};
const sheetRows = [
  // La misma que Siigo, con otro valor: se avisa y no se suma otra vez.
  {
    id: 'r1',
    tracker_id: 't1',
    values: {
      factura: 'FV-1',
      fecha: '01/08/2026',
      vence: '01/09/2026',
      valor: '1.200',
      nit: '900.123.456-8',
      cliente: 'ACME SAS',
      saldo: '1.200',
    },
  },
  // Sólo de la hoja.
  {
    id: 'r2',
    tracker_id: 't1',
    values: {
      factura: 'FV-77',
      fecha: '10/08/2026',
      vence: '10/09/2026',
      valor: '5.000',
      nit: '800200300',
      cliente: 'BETA LTDA',
      saldo: '5.000',
    },
  },
  // Nota crédito.
  {
    id: 'r3',
    tracker_id: 't1',
    values: {
      factura: 'NC-3',
      fecha: '12/08/2026',
      valor: '(300)',
      nit: '800200300',
      cliente: 'BETA LTDA',
      saldo: '',
    },
  },
  // Sin fecha: se reporta.
  {
    id: 'r4',
    tracker_id: 't1',
    values: {
      factura: 'FV-90',
      fecha: '',
      valor: '10',
      nit: '800200300',
      cliente: 'BETA LTDA',
      saldo: '10',
    },
  },
];

describe('readCartera con fuentes combinadas', () => {
  it('suma lo de la hoja sin repetir lo de Siigo, y dice la mezcla', async () => {
    const db = fakeDb({
      accounting_invoices: [siigoInvoice],
      trackers: [sheetTracker],
      accounting_sources: [source],
      tracker_rows: sheetRows,
    });
    const m = await readCartera(db, { today: '2026-10-01' });
    expect(m.invoices.map((i) => i.docNumber).sort()).toEqual(['FV-1', 'FV-77']);
    expect(m.kpis.outstanding.value).toBe(6000);
    expect(m.byOrigin.map((o) => [o.origin, o.open])).toEqual([
      ['Hoja: Ventas Medellín', 5000],
      ['Siigo', 1000],
    ]);
    expect(m.creditNotes.map((c) => [c.number, c.amount])).toEqual([['NC-3', 300]]);
    expect(m.sources?.differenceCount).toBeGreaterThan(0);
    expect(m.sources?.differences[0]?.message).toContain('FV-1');
    expect(m.sources?.rejectedCount).toBe(1);
    expect(m.sources?.sheetCount).toBe(1);
    // Cruza de servidor a cliente: nada de funciones ni instancias.
    expect(() => structuredClone(m)).not.toThrow();
  });

  it('con precedencia de hoja, el valor de la hoja reemplaza al del programa', async () => {
    const db = fakeDb({
      accounting_invoices: [siigoInvoice],
      trackers: [sheetTracker],
      accounting_sources: [{ ...source, precedence: 'sheet' }],
      tracker_rows: sheetRows,
    });
    const m = await readCartera(db, { today: '2026-10-01' });
    expect(m.kpis.outstanding.value).toBe(6200);
    expect(m.invoices.find((i) => i.docNumber === 'FV-1')?.origin).toBe('Hoja: Ventas Medellín');
  });

  it('sin fuentes declaradas, la cartera es la de siempre', async () => {
    const db = fakeDb({ accounting_invoices: [siigoInvoice] });
    const m = await readCartera(db, { today: '2026-10-01' });
    expect(m.kpis.outstanding.value).toBe(1000);
    expect(m.sources).toBeNull();
    expect(m.byOrigin).toEqual([expect.objectContaining({ origin: 'Siigo', open: 1000 })]);
  });
});

describe('buildCartera: origen', () => {
  it('agrupa lo que se debe por origen', () => {
    const inv = (id: string, origin: string | null, balance: number) => ({
      id,
      kind: 'sheet' as const,
      origin,
      docNumber: id,
      clientKey: 'c',
      clientId: null,
      clientName: 'C',
      currency: 'COP',
      total: balance,
      balance,
      issuedOn: '2026-08-01',
      dueOn: '2026-08-10',
    });
    const m = buildCartera({
      today: '2026-10-01',
      invoices: [inv('A', 'Hoja: X', 100), inv('B', 'Hoja: X', 50), inv('C', null, 7)],
      payments: [],
    });
    expect(m.byOrigin).toEqual([
      { origin: 'Hoja: X', open: 150, count: 2, overdue: 150 },
      { origin: 'Hoja de cálculo', open: 7, count: 1, overdue: 7 },
    ]);
  });
});
