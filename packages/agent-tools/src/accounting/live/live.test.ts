import { describe, expect, it } from 'vitest';
import { applyPartyNames, belongsToResource, normalizeSiigoLiveDoc, siigoLive } from './siigo-live';
import { type LiveRequest, docMatches, groupDocs, maskPayroll, renderLive } from './shape';
import { trialRows } from './tools';

const invoice = (n: number, date: string, nit: string, total: number, balance: number, extra = {}) => ({
  id: `inv-${n}`,
  name: `FV-1-${n}`,
  date,
  customer: { identification: nit },
  total,
  balance,
  items: [
    { code: 'P1', description: 'Flete Bogotá–Cali', quantity: 2, price: total / 2, total },
  ],
  ...extra,
});

const req = (over: Partial<LiveRequest> = {}): LiveRequest => ({
  resource: 'facturas_venta',
  canSeePayroll: false,
  ...over,
});

const journal = {
  id: 'j1',
  name: 'CC-1-5',
  date: '2026-08-31',
  observations: 'Nómina agosto Ana Pérez',
  items: [
    { account: { code: '51050601', movement: 'Debit' }, customer: { identification: '1012345678' }, description: 'Sueldo Ana', value: 3_000_000 },
    { account: { code: '25050101', movement: 'Credit' }, customer: { identification: '1012345678' }, description: 'Neto Ana', value: 3_000_000 },
    { account: { code: '13050501', movement: 'Credit' }, customer: { identification: '900111222' }, description: 'Ajuste', value: 100 },
    { account: { code: '41350501', movement: 'Debit' }, customer: { identification: '900111222' }, value: 100 },
  ],
};

describe('normalización de Siigo', () => {
  it('factura: total, saldo, estado y líneas', () => {
    const d = normalizeSiigoLiveDoc('facturas_venta', invoice(1, '2026-01-15', '900123456', 1_000_000, 400_000));
    expect(d).toMatchObject({ number: 'FV-1-1', total: 1_000_000, balance: 400_000, status: 'open', partyId: '900123456' });
    expect(d?.lines?.[0]).toMatchObject({ quantity: 2, value: 1_000_000 });
    const paid = normalizeSiigoLiveDoc('facturas_venta', invoice(2, '2026-01-16', '1', 5, 0));
    expect(paid?.status).toBe('paid');
    const ann = normalizeSiigoLiveDoc('facturas_venta', invoice(3, '2026-01-17', '1', 5, 5, { annulled: true }));
    expect(ann?.status).toBe('annulled');
  });
  it('comprobante: líneas por cuenta y total de débitos', () => {
    const d = normalizeSiigoLiveDoc('comprobantes', journal);
    expect(d?.lines).toHaveLength(4);
    expect(d?.total).toBe(3_000_100);
    expect(d?.lines?.[1]).toMatchObject({ account: '25050101', movement: 'credit' });
  });
  it('sin id o fecha no entra', () => {
    expect(normalizeSiigoLiveDoc('facturas_venta', { name: 'x', total: 1 })).toBeNull();
  });
  it('separa compras de documento soporte y recibos de egresos', () => {
    const ds = normalizeSiigoLiveDoc('compras', { id: 'a', name: 'DS-1-9', date: '2026-02-01', total: 10 });
    const fc = normalizeSiigoLiveDoc('compras', { id: 'b', name: 'FC-1-3', date: '2026-02-01', total: 10 });
    expect(belongsToResource('documento_soporte', ds!)).toBe(true);
    expect(belongsToResource('compras', ds!)).toBe(false);
    expect(belongsToResource('compras', fc!)).toBe(true);
    const ce = normalizeSiigoLiveDoc('pagos', { id: 'c', name: 'CE-1-2', date: '2026-02-01', payment: { value: 50 } });
    expect(ce?.total).toBe(50);
    expect(belongsToResource('pagos', ce!)).toBe(true);
    expect(belongsToResource('recibos_caja', ce!)).toBe(false);
  });
});

describe('filtros y agrupación', () => {
  const docs = [
    normalizeSiigoLiveDoc('facturas_venta', invoice(1, '2026-01-15', '900123456', 1_000_000, 400_000))!,
    normalizeSiigoLiveDoc('facturas_venta', invoice(2, '2026-01-20', '900123456', 500_000, 0))!,
    normalizeSiigoLiveDoc('facturas_venta', invoice(3, '2026-02-02', '800555000', 2_000_000, 2_000_000))!,
  ];
  it('filtra por estado, tercero y número', () => {
    expect(docs.filter((d) => docMatches(d, req({ status: 'con_saldo' })))).toHaveLength(2);
    expect(docs.filter((d) => docMatches(d, req({ party: '900123456' })))).toHaveLength(2);
    expect(docs.filter((d) => docMatches(d, req({ number: 'fv-1-3' })))).toHaveLength(1);
    expect(docs.filter((d) => docMatches(d, req({ from: '2026-02-01' })))).toHaveLength(1);
  });
  it('agrupa por mes y por tercero con totales', () => {
    const m = groupDocs(docs, 'mes', { canSeePayroll: false });
    expect(m.map((g) => [g.key, g.count, g.total, g.balance])).toEqual([
      ['2026-01', 2, 1_500_000, 400_000],
      ['2026-02', 1, 2_000_000, 2_000_000],
    ]);
    const t = groupDocs(docs, 'tercero', { canSeePayroll: false });
    expect(t[0]).toMatchObject({ key: '800555000', total: 2_000_000 });
    const p = groupDocs(docs, 'producto', { canSeePayroll: false });
    expect(p[0]).toMatchObject({ count: 3, total: 3_500_000 });
  });
  it('agrupa comprobantes por cuenta con prefijo y nivel', () => {
    const j = normalizeSiigoLiveDoc('comprobantes', journal)!;
    const g = groupDocs([j], 'cuenta', { account: '5105', level: 4, canSeePayroll: true });
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ key: '5105', debit: 3_000_000, credit: 0, total: 3_000_000 });
  });
});

describe('confidencialidad de nómina', () => {
  const j = normalizeSiigoLiveDoc('comprobantes', journal)!;
  it('quien no administra no ve personas ni descripciones de nómina', () => {
    const m = maskPayroll(j, false);
    expect(m.note).toBeUndefined();
    const payroll = m.lines!.filter((l) => l.account!.startsWith('5105') || l.account!.startsWith('2505'));
    expect(payroll.every((l) => l.party === 'Nómina (confidencial)' && !l.description)).toBe(true);
    // las cifras por cuenta se conservan
    expect(payroll[0]?.value).toBe(3_000_000);
    // la línea que no es de nómina no se toca
    expect(m.lines!.find((l) => l.account === '13050501')?.party).toBe('900111222');
  });
  it('el administrador ve todo', () => {
    expect(maskPayroll(j, true)).toBe(j);
  });
  it('buscar por la cédula de una persona no encuentra su nómina si no administra', () => {
    expect(docMatches(j, req({ resource: 'comprobantes', party: '1012345678', canSeePayroll: false }))).toBe(false);
    expect(docMatches(j, req({ resource: 'comprobantes', party: '1012345678', canSeePayroll: true }))).toBe(true);
  });
  it('agrupar por tercero no revela personas', () => {
    const g = groupDocs([j], 'tercero', { canSeePayroll: false });
    expect(g[0]?.label).toBe('Nómina (confidencial)');
  });
});

describe('siigoLive con páginas de ejemplo (sin red)', () => {
  const page = (rows: unknown[], total = rows.length) => ({ page: 1, pageSize: 100, total, results: rows });
  it('lee, filtra, agrupa y resuelve nombres', async () => {
    const calls: string[] = [];
    const client = {
      page: async (path: string, query: Record<string, unknown>) => {
        calls.push(`${path}?${new URLSearchParams(query as Record<string, string>)}`);
        if (path === '/v1/customers') return page([{ id: 'c', name: ['Nexa', 'SAS'], identification: '900123456' }]);
        return page([
          invoice(1, '2026-01-15', '900123456', 1_000_000, 0),
          invoice(2, '2026-02-15', '900123456', 500_000, 500_000),
        ]);
      },
      get: async () => [],
    };
    const r = await siigoLive(client as never, req({ from: '2026-01-01', to: '2026-09-30', groupBy: 'mes', party: '900123456' }));
    expect(r.totals).toEqual({ count: 2, total: 1_500_000, balance: 500_000 });
    expect(r.groups.map((g) => g.key)).toEqual(['2026-01', '2026-02']);
    expect(calls[0]).toContain('date_start=2026-01-01');
    expect(calls[0]).toContain('customer_identification=900123456');
    expect(r.docs[0]?.partyName).toBe('Nexa SAS');
    expect(renderLive(r, req({ from: '2026-01-01', to: '2026-09-30', groupBy: 'mes' }))).toContain('2 documento(s)');
  });
  it('avisa cuando se queda corto', async () => {
    let n = 0;
    const client = {
      page: async () => {
        n += 1;
        return { page: n, pageSize: 100, total: 10_000, results: Array.from({ length: 100 }, (_, i) => invoice(n * 1000 + i, '2026-03-01', '1', 1, 0)) };
      },
      get: async () => [],
    };
    const r = await siigoLive(client as never, req({ maxDocuments: 200 }));
    expect(r.partial).toBe(true);
    expect(r.scanned).toBe(200);
    expect(renderLive(r, req())).toContain('sólo alcancé a revisar 200 de 10000');
  });
  it('impuestos: lista simple', async () => {
    const client = { page: async () => page([]), get: async () => [{ id: 1, name: 'IVA 19%', type: 'IVA', percentage: 19 }] };
    const r = await siigoLive(client as never, req({ resource: 'impuestos' }));
    expect(r.records[0]).toMatchObject({ title: 'IVA 19%', detail: 'IVA · 19%' });
  });
  it('terceros: sólo proveedores', async () => {
    const client = {
      page: async () =>
        page([
          { id: '1', type: 'Customer', name: ['A'], identification: '1' },
          { id: '2', type: 'Supplier', name: ['Proveedor Uno'], identification: '22222' },
        ]),
      get: async () => [],
    };
    const r = await siigoLive(client as never, req({ resource: 'terceros', relationship: 'proveedor' }));
    expect(r.records.map((x) => x.title)).toEqual(['Proveedor Uno']);
  });
  it('applyPartyNames no rompe si falla', async () => {
    const r = { docs: [{ partyId: '12345' }], groups: [] } as never;
    await applyPartyNames({ page: async () => { throw new Error('x'); } } as never, r, {});
    expect((r as { docs: Array<{ partyName?: string }> }).docs[0]?.partyName).toBeUndefined();
  });
});

describe('balance de prueba', () => {
  const rows = ['1', '11', '1105', '110505', '5105', '510506'].map((code) => ({ code, name: code, initial: 0, debit: 10, credit: 0, final: 10 }));
  it('por nivel y por cuenta', () => {
    expect(trialRows(rows, { level: 4 }).map((r) => r.code)).toEqual(['1105', '5105']);
    expect(trialRows(rows, { account: '5105' }).map((r) => r.code)).toEqual(['5105', '510506']);
    expect(trialRows(rows, {}).map((r) => r.code)).toEqual(['11']);
  });
});
