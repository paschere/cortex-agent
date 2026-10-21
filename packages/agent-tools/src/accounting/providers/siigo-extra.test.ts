import { describe, expect, it } from 'vitest';
import { normalizeSiigoPurchase } from './purchases';
import { JOURNAL_HISTORY_MONTHS, journalWindows, siigoQueries } from './siigo';
import {
  MAX_LINES_PER_JOURNAL,
  catalogRows,
  isEgressName,
  normalizeSiigoCatalogItem,
  normalizeSiigoJournalLines,
  normalizeSiigoQuotation,
  normalizeSiigoSupplierPayment,
} from './siigo-extra';

/**
 * Lo de Siigo que llena las tablas nuevas (0234). Los registros de ejemplo
 * siguen la forma de las escrituras verificadas de close/writeback/siigo.ts.
 */

const NOW = new Date('2026-10-21T15:00:00Z');

describe('compras de Siigo para la tabla', () => {
  it('trae el documento, el tipo, el tercero y el saldo', () => {
    const p = normalizeSiigoPurchase({
      id: 'p1',
      name: 'FC-2-22',
      date: '2026-09-28',
      supplier: { id: 's-9', identification: '900373115', branch_office: 0 },
      provider_invoice: { prefix: 'FEPA', number: '451' },
      currency: { code: 'COP' },
      total: 2_380_000,
      balance: 1_000_000,
      payments: [{ value: 2_380_000, due_date: '2026-10-28' }],
      observations: 'Fletes de septiembre',
    });
    expect(p).toMatchObject({
      number: 'FEPA451',
      documentNumber: 'FC-2-22',
      kind: 'Compra',
      supplierExternalId: 's-9',
      balance: 1_000_000,
      status: 'open',
      notes: 'Fletes de septiembre',
    });
  });
  it('un documento soporte se separa por el prefijo DS', () => {
    const p = normalizeSiigoPurchase({ id: 'p2', name: 'DS-1-7', date: '2026-09-28', total: 50_000, balance: 0 });
    expect(p?.kind).toBe('Documento soporte');
    expect(p?.status).toBe('paid');
  });
});

describe('pagos a proveedores (egresos)', () => {
  const raw = {
    id: 'e1',
    name: 'RP-1-15',
    date: '2026-10-02',
    type: 'DebtPayment',
    supplier: { id: 's-9', identification: '900373115', branch_office: 0 },
    items: [
      { due: { prefix: 'FC', consecutive: 22, quote: 1, date: '2026-10-28' }, value: 1_000_000 },
      { due: { prefix: 'FC', consecutive: 25, quote: 1 }, value: 380_000 },
    ],
    payment: { id: 5, name: 'Transferencia', value: 1_380_000 },
    observations: 'Pago septiembre',
  };
  it('una línea por compra que cubre, con referencia estable', () => {
    const p = normalizeSiigoSupplierPayment(raw);
    expect(p).toMatchObject({
      externalId: 'e1',
      number: 'RP-1-15',
      supplierExternalId: 's-9',
      supplierTaxId: '900373115',
      amount: 1_380_000,
      method: 'Transferencia',
      annulled: false,
    });
    expect(p?.applications).toEqual([
      { ref: 'e1:0', purchaseNumber: 'FC-22', amount: 1_000_000 },
      { ref: 'e1:1', purchaseNumber: 'FC-25', amount: 380_000 },
    ]);
  });
  it('sin compras es un anticipo; sin valor o fecha no se lee', () => {
    const anticipo = normalizeSiigoSupplierPayment({
      id: 'e2',
      date: '2026-10-03',
      supplier: { identification: '1' },
      payment: { value: 90_000 },
    });
    expect(anticipo?.applications).toEqual([{ ref: 'e2', purchaseNumber: null, amount: 90_000 }]);
    expect(normalizeSiigoSupplierPayment({ id: 'e3', date: '2026-10-03' })).toBeNull();
    expect(normalizeSiigoSupplierPayment({ id: 'e4', payment: { value: 1 } })).toBeNull();
  });
  it('los CE se reconocen cuando se leen del listado de recibos', () => {
    expect(isEgressName('CE-1-4')).toBe(true);
    expect(isEgressName('RC-1-4')).toBe(false);
  });
});

describe('movimientos de comprobantes contables', () => {
  const journal = {
    id: 'j1',
    name: 'CC-1-33',
    date: '2026-09-30',
    observations: 'Causación fletes',
    items: [
      {
        account: { code: '5135050101', movement: 'Debit' },
        customer: { id: 'c-1', identification: '900123456', branch_office: 0 },
        cost_center: 12,
        description: 'Flete Bogotá',
        value: 500_000,
      },
      { account: { code: '2205050101', movement: 'Credit' }, customer: { identification: '900123456' }, value: 500_000 },
      { account: { code: '51050601', movement: 'Debit' }, customer: { identification: '1012345678' }, description: 'Sueldo de Ana', value: 3_000_000 },
      { account: { code: '' }, value: 10 },
    ],
  };
  it('una línea por movimiento con cuenta, sentido, tercero y centro de costo', () => {
    const lines = normalizeSiigoJournalLines(journal);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      externalId: 'j1:0',
      journalNumber: 'CC-1-33',
      account: '5135050101',
      movement: 'debit',
      value: 500_000,
      partyExternalId: 'c-1',
      partyTaxId: '900123456',
      costCenter: '12',
      description: 'Flete Bogotá',
    });
    expect(lines[1]).toMatchObject({ externalId: 'j1:1', movement: 'credit' });
  });
  it('las cuentas de nómina quedan confidenciales (sin tercero ni descripción en la tabla)', () => {
    const payroll = normalizeSiigoJournalLines(journal)[2];
    expect(payroll?.confidential).toBe(true);
  });
  it('un comprobante enorme se corta al tope', () => {
    const items = Array.from({ length: MAX_LINES_PER_JOURNAL + 50 }, () => ({
      account: { code: '110505', movement: 'Debit' },
      value: 1,
    }));
    expect(normalizeSiigoJournalLines({ id: 'big', date: '2026-01-01', items })).toHaveLength(
      MAX_LINES_PER_JOURNAL,
    );
  });
  it('sin id o fecha no hay líneas', () => {
    expect(normalizeSiigoJournalLines({ date: '2026-01-01', items: [] })).toEqual([]);
  });
});

describe('cotizaciones', () => {
  it('lee número, cliente, total y vigencia', () => {
    expect(
      normalizeSiigoQuotation({
        id: 'q1',
        name: 'CO-1-5',
        date: '2026-10-10',
        due_date: '2026-10-25',
        customer: { id: 'c-2', identification: '800.555.111' },
        total: 1_190_000,
        observations: 'Fletes a Cali',
      }),
    ).toMatchObject({
      externalId: 'q1',
      number: 'CO-1-5',
      validUntil: '2026-10-25',
      customerExternalId: 'c-2',
      customerTaxId: '800555111',
      total: 1_190_000,
      currency: 'COP',
    });
    expect(normalizeSiigoQuotation({ id: 'q2', date: '2026-10-10', total: 1 })).toBeNull();
  });
});

describe('catálogos', () => {
  it('centros de costo, impuestos, formas de pago, bodegas, tipos y vendedores', () => {
    expect(normalizeSiigoCatalogItem('cost_centers', { id: 12, code: 'CC1', name: 'Operación' })).toMatchObject({
      externalId: '12',
      name: 'Operación',
      code: 'CC1',
      active: true,
    });
    expect(
      normalizeSiigoCatalogItem('taxes', { id: 7, name: 'IVA 19%', type: 'IVA', percentage: 19, active: true }),
    ).toMatchObject({ kind: 'IVA', percentage: 19 });
    expect(
      normalizeSiigoCatalogItem('payment_methods', { id: 3, name: 'Crédito 30 días', type: 'Credit', due_date: true }, 'FV'),
    ).toMatchObject({ kind: 'Crédito', code: 'FV' });
    expect(normalizeSiigoCatalogItem('warehouses', { id: 1, name: 'Principal', active: false })).toMatchObject({
      active: false,
    });
    expect(
      normalizeSiigoCatalogItem('document_types', { id: 24446, code: 'FV-1', name: 'Factura de venta' }, 'FV'),
    ).toMatchObject({ kind: 'FV', name: 'Factura de venta' });
  });
  it('un vendedor guarda sólo el nombre, nunca el correo ni la identificación', () => {
    const seller = normalizeSiigoCatalogItem('sellers', {
      id: 629,
      username: 'ana@empresa.com',
      first_name: 'Ana',
      last_name: 'Pérez',
      email: 'ana@empresa.com',
      identification: '1012345678',
    });
    expect(seller).toEqual({ externalId: '629', catalog: 'sellers', name: 'Ana Pérez', active: true });
  });
  it('una respuesta puede ser lista o resultados; sin id o nombre no entra', () => {
    expect(catalogRows([{ id: 1 }])).toHaveLength(1);
    expect(catalogRows({ results: [{ id: 1 }, { id: 2 }] })).toHaveLength(2);
    expect(catalogRows(null)).toEqual([]);
    expect(normalizeSiigoCatalogItem('taxes', { id: 1 })).toBeNull();
    expect(normalizeSiigoCatalogItem('warehouses', { name: 'Sin id' })).toBeNull();
  });
});

describe('qué se le pide a Siigo de cada cosa nueva', () => {
  const base = { now: NOW };
  it('movimientos: la primera vez, doce ventanas mensuales; después, lo creado o cambiado', () => {
    const initial = siigoQueries('journal_lines', { ...base, mode: 'initial' });
    expect(initial).toHaveLength(JOURNAL_HISTORY_MONTHS);
    expect(initial[0]).toEqual({ date_start: '2025-11-01', date_end: '2025-11-30' });
    expect(initial[initial.length - 1]).toEqual({ date_start: '2026-10-01', date_end: '2026-10-31' });
    expect(journalWindows(NOW, 2)).toEqual([
      { date_start: '2026-09-01', date_end: '2026-09-30' },
      { date_start: '2026-10-01', date_end: '2026-10-31' },
    ]);
    const inc = siigoQueries('journal_lines', { ...base, mode: 'incremental', since: '2026-10-21T14:00:00.000Z' });
    expect(inc).toEqual([
      { created_start: '2026-10-21T14:00:00Z' },
      { updated_start: '2026-10-21T14:00:00Z' },
    ]);
  });
  it('compras y cotizaciones: todo la primera vez; incremental creado/cambiado; repaso por fecha', () => {
    expect(siigoQueries('purchases', { ...base, mode: 'initial' })).toEqual([{}]);
    expect(siigoQueries('quotations', { ...base, mode: 'initial' })).toEqual([{}]);
    expect(
      siigoQueries('purchases', { ...base, mode: 'incremental', since: '2026-10-21T14:00:00.000Z' }),
    ).toEqual([{ created_start: '2026-10-21T14:00:00Z' }, { updated_start: '2026-10-21T14:00:00Z' }]);
    expect(siigoQueries('purchases', { ...base, mode: 'sweep' })).toEqual([{ date_start: '2026-04-21' }]);
  });
  it('egresos: como los recibos, con una ventana por fecha del documento', () => {
    const inc = siigoQueries('supplier_payments', {
      ...base,
      mode: 'incremental',
      since: '2026-10-21T14:00:00.000Z',
    });
    expect(inc).toContainEqual({ date_start: '2026-07-21' });
    expect(siigoQueries('supplier_payments', { ...base, mode: 'sweep' })).toEqual([{ date_start: '2025-10-21' }]);
  });
  it('catálogos: una consulta, o una por clase de documento', () => {
    expect(siigoQueries('cost_centers', { ...base, mode: 'initial' })).toEqual([{}]);
    expect(siigoQueries('payment_methods', { ...base, mode: 'initial' }).map((q) => q.document_type)).toEqual([
      'FV',
      'FC',
      'RC',
    ]);
    expect(siigoQueries('document_types', { ...base, mode: 'initial' }).map((q) => q.type)).toContain('NC');
  });
  it('lo que se arma de otras lecturas no se pide en listado propio', () => {
    for (const e of ['stock', 'statements', 'payroll_costs'] as const)
      expect(siigoQueries(e, { ...base, mode: 'initial' })).toEqual([]);
  });
});
