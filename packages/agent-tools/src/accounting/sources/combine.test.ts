import { describe, expect, it } from 'vitest';
import { type SourceBatch, combineRecords, resolveSheetBalances } from './combine';
import { monthlyFromRecords } from './monthly';
import { baseRecord } from './read';
import { type AccRecord, normalizeRows } from './shape';

const base = (o: Partial<Parameters<typeof baseRecord>[1]> & { number: string }) =>
  baseRecord('ventas', {
    rowId: `b-${o.number}`,
    origin: 'Siigo',
    date: '2026-03-01',
    nit: '900123456',
    party: 'ACME SAS',
    total: 1000,
    balance: 1000,
    currency: 'COP',
    ...o,
  });

const sheetRec = (o: Partial<AccRecord> & { number: string }): AccRecord => ({
  ...base({ number: o.number }),
  sourceId: 's1',
  origin: 'Hoja: Ventas Medellín',
  rowId: `s-${o.number}`,
  ...o,
});

const batch = (records: AccRecord[], precedence: 'program' | 'sheet' = 'program'): SourceBatch => ({
  sourceId: 's1',
  label: 'Hoja: Ventas Medellín',
  precedence,
  records,
  issues: [],
});

describe('combineRecords', () => {
  it('no suma dos veces la misma factura (número normalizado + NIT con DV)', () => {
    const r = combineRecords(
      'ventas',
      [base({ number: 'FV-102' })],
      [batch([sheetRec({ number: 'fv 102', nit: '9001234568' })])],
    );
    expect(r.records).toHaveLength(1);
    expect(r.records[0]?.origin).toBe('Siigo');
    expect(r.overlaps).toBe(1);
    expect(r.differences).toEqual([]);
  });

  it('el programa manda por defecto y la diferencia se avisa', () => {
    const r = combineRecords(
      'ventas',
      [base({ number: 'FV-102', total: 1000, balance: 400 })],
      [batch([sheetRec({ number: 'FV-102', total: 1200, balance: 400 })])],
    );
    expect(r.records[0]?.total).toBe(1000);
    expect(r.differences).toHaveLength(1);
    expect(r.differences[0]).toMatchObject({
      field: 'total',
      leftOrigin: 'Siigo',
      leftValue: 1000,
      rightOrigin: 'Hoja: Ventas Medellín',
      rightValue: 1200,
      keptOrigin: 'Siigo',
    });
    expect(r.differences[0]?.message).toContain('FV-102');
    expect(r.differences[0]?.message).toContain('Siigo');
  });

  it('con precedencia de hoja, la hoja reemplaza y también avisa', () => {
    const r = combineRecords(
      'ventas',
      [base({ number: 'FV-102', total: 1000 })],
      [batch([sheetRec({ number: 'FV-102', total: 1200 })], 'sheet')],
    );
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ total: 1200, origin: 'Hoja: Ventas Medellín' });
    expect(r.differences[0]?.keptOrigin).toBe('Hoja: Ventas Medellín');
    expect(r.origins.find((o) => o.origin === 'Siigo')?.dropped).toBe(1);
  });

  it('el mismo número con otro NIT es otra factura', () => {
    const r = combineRecords(
      'ventas',
      [base({ number: 'FV-1', nit: '900123456' })],
      [batch([sheetRec({ number: 'FV-1', nit: '800200300' })])],
    );
    expect(r.records).toHaveLength(2);
  });

  it('sin NIT en la hoja, el nombre decide', () => {
    const same = combineRecords(
      'ventas',
      [base({ number: 'FV-1' })],
      [batch([sheetRec({ number: 'FV-1', nit: '', party: 'Acme S.A.S.' })])],
    );
    expect(same.records).toHaveLength(1);
    const other = combineRecords(
      'ventas',
      [base({ number: 'FV-1' })],
      [batch([sheetRec({ number: 'FV-1', nit: '', party: 'Beta Ltda' })])],
    );
    expect(other.records).toHaveLength(2);
  });

  it('otra moneda no se mezcla', () => {
    const r = combineRecords(
      'ventas',
      [base({ number: 'FV-1' })],
      [batch([sheetRec({ number: 'FV-1', currency: 'USD' })])],
    );
    expect(r.records).toHaveLength(2);
  });

  it('dos hojas con la misma factura: gana la primera y se avisa', () => {
    const a = {
      ...batch([sheetRec({ number: 'FV-9', total: 10 })]),
      sourceId: 'a',
      label: 'Hoja: A',
    };
    const b = {
      ...batch([sheetRec({ number: 'FV-9', total: 20, origin: 'Hoja: B', sourceId: 'b' })]),
      sourceId: 'b',
      label: 'Hoja: B',
    };
    const r = combineRecords('ventas', [], [a, b]);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]?.total).toBe(10);
    expect(r.differences).toHaveLength(1);
  });

  it('resume por origen sin mezclar monedas', () => {
    const r = combineRecords(
      'ventas',
      [base({ number: 'A', total: 100, balance: 50 })],
      [
        batch([
          sheetRec({ number: 'B', total: 300, balance: 300 }),
          sheetRec({ number: 'C', total: 5, currency: 'USD' }),
        ]),
      ],
    );
    const sheet = r.origins.find((o) => o.origin === 'Hoja: Ventas Medellín');
    expect(sheet).toMatchObject({ count: 2, total: 300, balance: 300 });
    expect(r.origins.find((o) => o.origin === 'Siigo')).toMatchObject({ count: 1, total: 100 });
  });

  it('arrastra los avisos de cada hoja con su nombre', () => {
    const b = batch([]);
    b.issues = [{ rowId: 'x', code: 'sin_fecha', severity: 'rechazada', message: 'sin fecha' }];
    const r = combineRecords('ventas', [], [b]);
    expect(r.issues[0]?.sourceLabel).toBe('Hoja: Ventas Medellín');
  });

  it('pagos: mismo día, valor y factura = el mismo pago', () => {
    const p = (o: Partial<AccRecord>): AccRecord => ({
      ...base({ number: '' }),
      kind: 'pagos_recibidos',
      invoiceRef: 'FV-102',
      total: 800,
      date: '2026-03-10',
      ...o,
    });
    const r = combineRecords(
      'pagos_recibidos',
      [{ ...p({}), origin: 'Siigo' }],
      [
        batch([
          { ...p({ number: 'RC-7', nit: '' }), sourceId: 's1', origin: 'Hoja: Pagos' },
          { ...p({ total: 50, invoiceRef: 'FV-103' }), sourceId: 's1', origin: 'Hoja: Pagos' },
        ]),
      ],
    );
    expect(r.records).toHaveLength(2);
    expect(r.overlaps).toBe(1);
  });

  it('presupuesto: un renglón repetido en dos hojas cuenta una vez', () => {
    const b = (o: Partial<AccRecord>): AccRecord => ({
      ...base({ number: '' }),
      kind: 'presupuesto',
      account: '5105',
      date: '2026-04-01',
      total: 100,
      ...o,
    });
    const r = combineRecords(
      'presupuesto',
      [],
      [batch([b({}), b({ sourceId: 's2', origin: 'Hoja: Otra' })])],
    );
    expect(r.records).toHaveLength(1);
  });
});

describe('resolveSheetBalances', () => {
  const inv = (number: string, total: number, balance: number | null): AccRecord =>
    sheetRec({ number, total, balance });
  const pay = (invoiceRef: string, total: number): AccRecord => ({
    ...base({ number: '' }),
    kind: 'pagos_recibidos',
    invoiceRef,
    total,
  });

  it('usa el saldo de la hoja si lo trae', () => {
    const r = resolveSheetBalances([inv('A', 100, 30)], []);
    expect(r.records[0]?.balance).toBe(30);
    expect(r.issues).toEqual([]);
  });
  it('resta los pagos que nombran la factura', () => {
    const r = resolveSheetBalances([inv('FV-1', 100, null)], [pay('fv1', 40), pay('FV-1', 10)]);
    expect(r.records[0]?.balance).toBe(50);
  });
  it('sin saldo ni pagos: queda sin decir (se toma el total), y un solo aviso por hoja', () => {
    const r = resolveSheetBalances([inv('A', 100, null), inv('B', 50, null)], []);
    expect(r.records.map((x) => x.balance)).toEqual([null, null]);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.message).toContain('2 factura');
  });
  it('nunca deja un saldo negativo', () => {
    const r = resolveSheetBalances([inv('A', 100, null)], [pay('A', 300)]);
    expect(r.records[0]?.balance).toBe(0);
  });
});

describe('de la hoja al saldo (de punta a punta)', () => {
  it('normaliza, resuelve y combina con el programa', () => {
    const map = { numero: 'n', fecha: 'f', total: 'v', nit: 'nit', nombre: 'c' };
    const rows = [
      {
        id: '1',
        values: { n: 'FV-102', f: '01/03/2026', v: '1.000', nit: '900123456-8', c: 'ACME' },
      },
      {
        id: '2',
        values: { n: 'FV-200', f: '02/03/2026', v: '2.000', nit: '800200300', c: 'BETA' },
      },
      { id: '3', values: { n: '', f: '02/03/2026', v: '9', nit: '', c: '' } },
    ];
    const n = normalizeRows('ventas', map, rows, { sourceId: 's1', origin: 'Hoja: X' });
    const withBal = resolveSheetBalances(n.records, []);
    const r = combineRecords(
      'ventas',
      [base({ number: 'FV-102' })],
      [
        {
          sourceId: 's1',
          label: 'Hoja: X',
          precedence: 'program',
          records: withBal.records,
          issues: [...n.issues, ...withBal.issues],
        },
      ],
    );
    expect(r.records.map((x) => [x.number, x.origin])).toEqual([
      ['FV-102', 'Siigo'],
      ['FV-200', 'Hoja: X'],
    ]);
    expect(r.issues.map((i) => i.code).sort()).toEqual(['sin_numero', 'sin_saldo']);
  });
});

describe('monthlyFromRecords', () => {
  const v = (date: string, total: number, o: Partial<AccRecord> = {}) =>
    sheetRec({ number: `V${date}${total}`, date, total, tax: null, ...o });
  it('suma por mes, sin IVA cuando la hoja lo trae', () => {
    const m = monthlyFromRecords(
      [v('2026-03-02', 1190, { tax: 190 }), v('2026-03-20', 500, { tax: 0 }), v('2026-04-01', 100)],
      [v('2026-03-05', 300, { tax: 0 })],
    );
    expect(m.months).toEqual([
      {
        month: '2026-03',
        sales: 1500,
        purchases: 300,
        result: 1200,
        salesCount: 2,
        purchaseCount: 1,
      },
      { month: '2026-04', sales: 100, purchases: 0, result: 100, salesCount: 1, purchaseCount: 0 },
    ]);
    expect(m.taxUnknown.sales).toBe(true);
    expect(m.taxUnknown.purchases).toBe(false);
  });
  it('las notas crédito restan y la moneda sin TRM se cuenta aparte', () => {
    const m = monthlyFromRecords(
      [
        v('2026-03-02', 1000, { tax: 0 }),
        v('2026-03-03', -200, { tax: 0, creditNote: true }),
        v('2026-03-04', 50, { currency: 'USD', totalCop: null }),
        v('2026-03-05', 10, { currency: 'USD', totalCop: 40000, trm: 4000, tax: 0 }),
      ],
      [],
    );
    expect(m.months[0]?.sales).toBe(40800);
    expect(m.skippedForeign).toBe(1);
  });
  it('respeta el rango', () => {
    const m = monthlyFromRecords([v('2026-01-02', 5), v('2026-03-02', 7)], [], {
      from: '2026-02-01',
      to: '2026-12-31',
    });
    expect(m.months.map((x) => x.month)).toEqual(['2026-03']);
  });
});
