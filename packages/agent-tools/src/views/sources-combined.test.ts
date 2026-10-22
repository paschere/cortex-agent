import { describe, expect, it } from 'vitest';
import { type FakeRow, fakeDb } from '../accounting/sources/fake-db';
import { porPagarSource } from './module-sources';
import { platformSource } from './sources';

type Row = FakeRow;

const tracker = (id: string, slug: string, fields: string[]) => ({
  id,
  slug,
  name: slug,
  fields: fields.map((key) => ({ key })),
  origins: [
    { kind: 'sheet', label: 'h', ref: 'x', fields: [fields[0]], creates: true, writeBack: false },
  ],
});
const src = (id: string, trackerId: string, kind: string, mapping: Record<string, string>) => ({
  id,
  tracker_id: trackerId,
  kind,
  label: kind === 'ventas' ? 'Ventas Medellín' : kind === 'compras' ? 'Compras' : 'Pagos',
  mapping,
  precedence: 'program',
  options: { currency: 'COP' },
  enabled: true,
  created_at: 't',
  updated_at: 't',
});

const db = (extra: Record<string, Row[]> = {}) =>
  fakeDb({
    trackers: [
      tracker('t1', 'v', ['n', 'f', 'val', 'nit', 'c']),
      tracker('t2', 'c', ['n', 'f', 'val', 'nit', 'p']),
      tracker('t3', 'p', ['f', 'val', 'fac']),
    ],
    accounting_sources: [
      src('s1', 't1', 'ventas', { numero: 'n', fecha: 'f', total: 'val', nit: 'nit', nombre: 'c' }),
      src('s2', 't2', 'compras', {
        numero: 'n',
        fecha: 'f',
        total: 'val',
        nit: 'nit',
        nombre: 'p',
      }),
      src('s3', 't3', 'pagos_recibidos', { fecha: 'f', total: 'val', factura: 'fac' }),
    ],
    tracker_rows: [
      {
        id: 'a',
        tracker_id: 't1',
        values: { n: 'FV-1', f: '01/08/2026', val: '1.000', nit: '900123456', c: 'ACME' },
      },
      {
        id: 'b',
        tracker_id: 't1',
        values: { n: 'FV-2', f: '02/08/2026', val: '2.000', nit: '800200300', c: 'BETA' },
      },
      {
        id: 'c',
        tracker_id: 't2',
        values: { n: 'FC-1', f: '03/08/2026', val: '700', nit: '900111222', p: 'Prov' },
      },
      { id: 'd', tracker_id: 't3', values: { f: '05/08/2026', val: '500', fac: 'FV-2' } },
    ],
    ...extra,
  });

describe('cortex.ventas con hojas', () => {
  it('suma lo de la hoja con su origen, sin repetir lo de Siigo', async () => {
    const accounting = [
      {
        id: 'x1',
        source_system: 'siigo',
        doc_number: 'FV-1',
        client_id: null,
        client_nit: '900123456',
        counterparty_name: 'ACME',
        currency: 'COP',
        total: 1000,
        balance: 0,
        issued_on: '2026-08-01',
        due_on: null,
        created_at: 't',
        updated_at: 't',
        annulled: false,
      },
    ];
    const r = await platformSource('cortex.ventas')?.read(
      db({ accounting_invoices: accounting }),
      100,
      '2026-10-22',
      { viewerId: null },
    );
    expect(r?.rows.map((x) => [x.values.numero, x.values.origen])).toEqual([
      ['FV-1', 'Siigo'],
      ['FV-2', 'Hoja: Ventas Medellín'],
    ]);
    // FV-2 trae un pago de la hoja de pagos que la nombra: saldo 1.500.
    expect(r?.rows[1]?.values.saldo).toBe(1500);
    expect(r?.rows[1]?.values.pagado).toBe(500);
    expect(r?.rows[1]?.values.estado).toBe('Por cobrar');
  });

  it('declara el campo Origen', () => {
    expect(platformSource('cortex.ventas')?.fields.some((f) => f.key === 'origen')).toBe(true);
    expect(platformSource('cortex.pagos')?.fields.some((f) => f.key === 'origen')).toBe(true);
    expect(porPagarSource.fields.some((f) => f.key === 'fuente')).toBe(true);
  });
});

describe('cortex.pagos con hojas', () => {
  it('trae los pagos de la hoja con su factura y su origen', async () => {
    const r = await platformSource('cortex.pagos')?.read(db(), 100, '2026-10-22', {
      viewerId: null,
    });
    const row = r?.rows.find((x) => x.values.factura === 'FV-2');
    expect(row?.values).toMatchObject({ valor: 500, tipo: 'Abono', origen: 'Hoja: Pagos' });
  });
});

describe('cortex.por_pagar con hojas', () => {
  it('suma las compras de la hoja con su fuente y su saldo', async () => {
    const r = await porPagarSource.read(db({ payable_invoices: [] }), 100, '2026-10-22', {
      viewerId: null,
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.values).toMatchObject({
      numero: 'FC-1',
      fuente: 'Hoja: Compras',
      saldo: 700,
      total: 700,
    });
  });
});
