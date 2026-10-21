import { describe, expect, it } from 'vitest';
import {
  einvoiceStateOf,
  normalizeSiigoAccountPayable,
  parsePartyBalanceRows,
  partyBalanceLines,
  productPriceLines,
  siigoDocuments,
  stampErrorMessages,
  stampInfo,
} from './siigo-more';
import { normalizeSiigoCreditNote, normalizeSiigoInvoice, normalizeSiigoProduct } from './siigo';
import { normalizeSiigoCatalogItem } from './siigo-extra';

describe('estado DIAN (stamp)', () => {
  it('traduce el estado, el CUFE y el mensaje de rechazo', () => {
    expect(stampInfo({ status: 'Accepted', cufe: 'abc', observations: '', errors: '' })).toEqual({
      status: 'Aceptada',
      cufe: 'abc',
      message: undefined,
    });
    const rejected = stampInfo({
      status: 'Rejected',
      errors: [{ message: 'NIT del adquirente inválido' }, 'Otro error'],
      observations: 'Revise',
    });
    expect(rejected.status).toBe('Rechazada');
    expect(rejected.message).toBe('NIT del adquirente inválido; Otro error · Revise');
    expect(stampInfo(null)).toEqual({});
    expect(einvoiceStateOf('Draft')).toBe('Sin enviar');
    expect(einvoiceStateOf('InProcess')).toBe('Pendiente');
  });

  it('la factura rechazada guarda el motivo; la aceptada guarda el CUFE y no el motivo', () => {
    const base = { id: 'f1', name: 'FV-1-5', date: '2026-10-01', total: 100, balance: 100 };
    const rej = normalizeSiigoInvoice({ ...base, stamp: { status: 'Rejected', errors: [{ message: 'Falla' }] } });
    expect(rej).toMatchObject({ einvoiceStatus: 'Rechazada', dianMessage: 'Falla' });
    const ok = normalizeSiigoInvoice({ ...base, stamp: { status: 'Accepted', cufe: 'xyz', observations: 'ok' } });
    expect(ok).toMatchObject({ einvoiceStatus: 'Aceptada', cufe: 'xyz', dianMessage: undefined });
  });

  it('la nota crédito trae su CUDE y estado', () => {
    const n = normalizeSiigoCreditNote({
      id: 'n1',
      name: 'NC-1-2',
      date: '2026-10-02',
      total: 50,
      stamp: { status: 'Accepted', cude: 'cude-1' },
    });
    expect(n).toMatchObject({ einvoiceStatus: 'Aceptada', cufe: 'cude-1' });
  });

  it('los mensajes de /stamp/errors', () => {
    expect(stampErrorMessages({ id: 'x', errors: [{ message: 'Error1' }, { message: 'Error2' }] })).toEqual([
      'Error1',
      'Error2',
    ]);
    expect(stampErrorMessages(null)).toEqual([]);
  });
});

describe('PDF y XML bajo demanda', () => {
  const client = (body: unknown, status?: number) => ({
    get: async (path: string) => {
      calls.push(path);
      if (status) throw Object.assign(new Error('x'), { status });
      return body as never;
    },
  });
  const calls: string[] = [];

  it('decodifica el base64 de la factura y pide la ruta documentada', async () => {
    calls.length = 0;
    const docs = siigoDocuments(client({ id: 'a', base64: Buffer.from('%PDF-1').toString('base64') }));
    const f = await docs.fetch('invoice', 'b446fbc3-99c5-4c2d-8a28-1c0d3721ab91', 'pdf');
    expect(Buffer.from(f.bytes).toString()).toBe('%PDF-1');
    expect(f.contentType).toBe('application/pdf');
    expect(calls).toEqual(['/v1/invoices/b446fbc3-99c5-4c2d-8a28-1c0d3721ab91/pdf']);
    await docs.fetch('credit_note', 'n-1', 'pdf');
    expect(calls[1]).toBe('/v1/credit-notes/n-1/pdf');
  });

  it('rechaza ids con rutas raras y explica un 404', async () => {
    const docs = siigoDocuments(client(null, 404));
    await expect(docs.fetch('invoice', '../../v1/customers', 'pdf')).rejects.toThrow('no es válido');
    await expect(docs.fetch('invoice', 'x1', 'xml')).rejects.toThrow('no encontró');
    await expect(docs.fetch('credit_note', 'x1', 'xml')).rejects.toThrow('notas crédito');
  });
});

describe('cuentas por pagar', () => {
  it('un vencimiento del reporte oficial', () => {
    const r = normalizeSiigoAccountPayable({
      due: { prefix: 'FC', consecutive: 22, quote: 1, date: '2026-11-05', balance: 1500000 },
      provider: { id: 'prov-1', identification: '900.123.456', name: 'Café del Sur' },
      cost_center: { code: '01', name: 'Planta' },
      currency: { money_code: 'USD', balance: 400 },
    });
    expect(r).toEqual({
      externalId: 'FC-22-1',
      document: 'FC-22',
      quote: '1',
      supplierExternalId: 'prov-1',
      supplierTaxId: '900123456',
      supplierName: 'Café del Sur',
      dueDate: '2026-11-05',
      balance: 1500000,
      currency: 'COP',
      foreignCurrency: 'USD',
      foreignBalance: 400,
      costCenter: 'Planta',
    });
    expect(normalizeSiigoAccountPayable({ due: { prefix: 'FC' } })).toBeNull();
  });
});

describe('precios por lista', () => {
  it('el producto trae su precio en cada lista, con nombre y moneda', () => {
    const p = normalizeSiigoProduct({
      id: 'p1',
      code: 'CAF1',
      name: 'Café',
      type: 'Product',
      prices: [
        {
          currency_code: 'COP',
          price_list: [
            { position: 1, name: 'Precio de venta 1', value: 12000 },
            { position: 2, name: 'Mayorista', value: 9000 },
          ],
        },
      ],
    });
    expect(productPriceLines(p).map((l) => [l.externalId, l.listName, l.price])).toEqual([
      ['p1:COP:1', 'Precio de venta 1', 12000],
      ['p1:COP:2', 'Mayorista', 9000],
    ]);
    expect(productPriceLines(normalizeSiigoProduct({ id: 'p2', name: 'S' }))).toEqual([]);
  });
});

describe('catálogos nuevos', () => {
  it('listas de precios, grupos, activos fijos, descuentos y ciudades', () => {
    expect(normalizeSiigoCatalogItem('price_lists', { id: 2766, name: 'Mayorista', position: 2, active: true })).toMatchObject({
      name: 'Mayorista',
      kind: '2',
    });
    expect(normalizeSiigoCatalogItem('account_groups', { id: 1253, name: 'Productos' })?.name).toBe('Productos');
    expect(normalizeSiigoCatalogItem('fixed_assets', { id: 1, name: 'Portátil', group: 'Equipo de computación', active: false })).toMatchObject({
      kind: 'Equipo de computación',
      active: false,
    });
    expect(normalizeSiigoCatalogItem('expense_concepts', { id: 13156, name: 'Ajuste al peso' })?.name).toBe('Ajuste al peso');
    expect(normalizeSiigoCatalogItem('cities', { city_code: '05001', city_name: 'Medellín', state_name: 'Antioquia' })).toMatchObject({
      externalId: '05001',
      code: '05001',
      kind: 'Antioquia',
    });
    expect(normalizeSiigoCatalogItem('cities', { name: 'Sin código' })).toBeNull();
  });
});

describe('balance de prueba por tercero (Excel)', () => {
  const rows: unknown[][] = [
    ['Empresa Andina SAS'],
    ['Balance de prueba por tercero'],
    [],
    ['Código cuenta', 'Nombre cuenta', 'Identificación', 'Nombre tercero', 'Saldo inicial', 'Movimiento Débito', 'Movimiento Crédito', 'Saldo final'],
    ['13050501', 'Clientes nacionales', '900111222', 'Cliente SAS', '1.000,00', '500,00', '200,00', '1.300,00'],
    ['', '', '900333444', 'Otro Cliente', 0, 100, 0, 100],
    ['23350501', 'Costos y gastos por pagar', '800555666', 'Proveedor', 0, 0, 700, -700],
    ['25050501', 'Salarios por pagar', '1032000111', 'Ana Pérez', 0, 0, 3000000, -3000000],
    ['25050501', 'Salarios por pagar', '1032000222', 'Luis Gómez', 0, 0, 2000000, -2000000],
    ['', 'Total', '', '', 0, 0, 0, 0],
  ];

  it('reconoce el encabezado y la cuenta que se arrastra a los terceros siguientes', () => {
    const out = parsePartyBalanceRows(rows);
    expect(out).toHaveLength(5);
    expect(out?.[0]).toMatchObject({ account: '13050501', partyTaxId: '900111222', initial: 1000, debit: 500, credit: 200, final: 1300 });
    expect(out?.[1]).toMatchObject({ account: '13050501', partyTaxId: '900333444', partyName: 'Otro Cliente' });
  });

  it('un archivo que no es un balance por tercero devuelve null', () => {
    expect(parsePartyBalanceRows([['hola'], ['mundo']])).toBeNull();
  });

  it('las cuentas de nómina pierden al tercero y se suman', () => {
    const lines = partyBalanceLines('2026-09', parsePartyBalanceRows(rows) ?? [], false);
    const payroll = lines.filter((l) => l.account === '25050501');
    expect(payroll).toHaveLength(1);
    expect(payroll[0]).toMatchObject({ credit: 5000000, final: -5000000, partyTaxId: 'nomina', partyName: 'Nómina (confidencial)' });
    expect(JSON.stringify(lines)).not.toContain('1032000111');
    expect(lines.find((l) => l.account === '13050501' && l.partyTaxId === '900111222')?.externalId).toBe(
      'party|2026-09|13050501|900111222',
    );
  });
});
