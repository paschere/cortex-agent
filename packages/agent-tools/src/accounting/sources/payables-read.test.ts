import { describe, expect, it } from 'vitest';
import { type FakeRow, fakeDb } from './fake-db';
import { readSheetPayables } from './payables-read';

type Row = FakeRow;

const tracker = {
  id: 't1',
  slug: 'compras_hoja',
  name: 'Compras y gastos',
  fields: [
    { key: 'n' },
    { key: 'f' },
    { key: 'v' },
    { key: 'val' },
    { key: 'nit' },
    { key: 'prov' },
  ],
  origins: [
    { kind: 'sheet', label: 'h', ref: 'x', fields: ['n'], creates: true, writeBack: false },
  ],
};
const source = {
  id: 's1',
  tracker_id: 't1',
  kind: 'compras',
  label: 'Compras',
  mapping: { numero: 'n', fecha: 'f', vencimiento: 'v', total: 'val', nit: 'nit', nombre: 'prov' },
  precedence: 'program',
  options: { currency: 'COP' },
  enabled: true,
  created_at: 't',
  updated_at: 't',
};
const rows = [
  {
    id: 'r1',
    tracker_id: 't1',
    values: {
      n: 'FC-9',
      f: '01/09/2026',
      v: '01/10/2026',
      val: '1.000.000',
      nit: '900123456',
      prov: 'Proveedor A',
    },
  },
  {
    id: 'r2',
    tracker_id: 't1',
    values: {
      n: 'FC-10',
      f: '02/09/2026',
      v: '30/12/2026',
      val: '500.000',
      nit: '800200300',
      prov: 'Proveedor B',
    },
  },
  {
    id: 'r3',
    tracker_id: 't1',
    values: { n: 'FC-11', f: '', v: '', val: '10', nit: '', prov: '' },
  },
];
const payable = (o: Row): Row => ({
  id: 'p1',
  supplier_nit: '900123456',
  supplier_name: 'Proveedor A',
  doc_number: 'FC-9',
  currency: 'COP',
  issue_date: '2026-09-01',
  due_date: '2026-10-01',
  total: 1000000,
  iva: 0,
  status: 'aprobada',
  source_system: null,
  ...o,
});

describe('readSheetPayables', () => {
  it('sin fuentes declaradas no devuelve nada', async () => {
    expect(
      await readSheetPayables(fakeDb({ payable_invoices: [payable({})] }), '2026-10-22'),
    ).toBeNull();
  });

  it('suma lo que sólo está en la hoja, sin repetir lo del libro, y dice la mezcla', async () => {
    const db = fakeDb({
      payable_invoices: [payable({})],
      trackers: [tracker],
      accounting_sources: [source],
      tracker_rows: rows,
    });
    const r = await readSheetPayables(db, '2026-10-22');
    expect(r?.open.map((o) => o.number)).toEqual(['FC-10']);
    expect(r?.openTotal).toBe(500000);
    expect(r?.items.map((i) => [i.origin, i.amount])).toEqual([
      ['Cortex', 1000000],
      ['Hoja: Compras', 500000],
    ]);
    expect(r?.summary.rejectedCount).toBe(1);
    expect(r?.summary.sheetCount).toBe(1);
    expect(() => structuredClone(r)).not.toThrow();
  });

  it('lo pagado en el libro no cuenta como deuda', async () => {
    const db = fakeDb({
      payable_invoices: [payable({ status: 'pagada' })],
      trackers: [tracker],
      accounting_sources: [source],
      tracker_rows: rows,
    });
    const r = await readSheetPayables(db, '2026-10-22');
    expect(r?.items.map((i) => i.origin)).toEqual(['Hoja: Compras']);
  });

  it('marca lo vencido', async () => {
    const db = fakeDb({
      payable_invoices: [],
      trackers: [tracker],
      accounting_sources: [source],
      tracker_rows: rows,
    });
    const r = await readSheetPayables(db, '2026-10-22');
    expect(r?.open[0]).toMatchObject({ number: 'FC-9', daysOverdue: 21 });
    expect(r?.overdueTotal).toBe(1000000);
  });
});
