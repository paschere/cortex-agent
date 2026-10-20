import { describe, expect, it, vi } from 'vitest';
import { type CreditNotePayload, type CustomerPayload, type ReceiptPayload } from '../outbound/shape';
import { ProviderValidationError } from '../types';
import {
  buildAlegraContact,
  buildSiigoCreditNote,
  buildSiigoCustomer,
  buildSiigoVoucherMulti,
  readSiigoInvoiceDetail,
  siigoOutbound,
} from './outbound';
import type { SiigoClient } from './siigo-client';

const company: CustomerPayload = {
  taxId: '900123456',
  dv: '8',
  idType: '31',
  personType: 'Company',
  name: 'Avianca Cargo SAS',
  email: 'pagos@avianca.com',
  phone: '6015551234',
  address: 'Calle 26 # 59-15',
  city: { name: 'Bogotá', stateCode: '11', cityCode: '11001' },
  vatResponsible: true,
};

describe('cliente en Siigo', () => {
  it('arma el tercero con ciudad DANE, teléfono y contacto', () => {
    expect(buildSiigoCustomer(company)).toEqual({
      type: 'Customer',
      person_type: 'Company',
      id_type: '31',
      identification: '900123456',
      check_digit: '8',
      name: ['Avianca Cargo SAS'],
      vat_responsible: true,
      address: { address: 'Calle 26 # 59-15', city: { country_code: 'Co', state_code: '11', city_code: '11001' } },
      phones: [{ number: '6015551234' }],
      contacts: [{ first_name: 'Avianca', last_name: 'Cargo SAS', email: 'pagos@avianca.com' }],
    });
  });
  it('persona natural: nombres y apellidos aparte y sin dígito', () => {
    const body = buildSiigoCustomer({ ...company, idType: '13', personType: 'Person', dv: null, name: 'Marcos Castillo' });
    expect(body.name).toEqual(['Marcos', 'Castillo']);
    expect(body).not.toHaveProperty('check_digit');
    expect((body.contacts as Array<{ last_name: string }>)[0]?.last_name).toBe('Castillo');
  });
  it('un nombre de una palabra repite el apellido (Siigo lo exige)', () => {
    const body = buildSiigoCustomer({ ...company, name: 'Avianca' });
    expect((body.contacts as Array<{ last_name: string }>)[0]?.last_name).toBe('Avianca');
  });
  it('contacto de Alegra', () => {
    expect(buildAlegraContact(company)).toMatchObject({
      name: 'Avianca Cargo SAS',
      identificationObject: { type: 'NIT', number: '900123456', dv: '8' },
      kindOfPerson: 'LEGAL_ENTITY',
      type: ['client'],
      email: 'pagos@avianca.com',
    });
  });
});

const receipt: ReceiptPayload = {
  customerTaxId: '900123456',
  customerName: 'Avianca',
  date: '2026-10-19',
  amount: 1_100_000,
  applications: [
    { invoiceNumber: 'FV-1-68', invoiceExternalId: 'i68', invoiceDate: '2026-09-20', amount: 700_000 },
    { invoiceNumber: 'FV-1-70', invoiceExternalId: 'i70', invoiceDate: '2026-10-01', amount: 400_000 },
  ],
  bankAccount: null,
  reference: 'BAN-77',
};

describe('recibo de caja con varias facturas', () => {
  it('un renglón por factura y un solo pago por el total', () => {
    const { body, problems } = buildSiigoVoucherMulti({
      payload: receipt,
      documentId: 7,
      payment: { id: 5636, name: 'Bancolombia', dueDate: false },
    });
    expect(problems).toEqual([]);
    expect(body).toMatchObject({
      document: { id: 7 },
      date: '2026-10-19',
      type: 'DebtPayment',
      customer: { identification: '900123456', branch_office: 0 },
      payment: { id: 5636, value: 1_100_000 },
    });
    expect(body.items).toEqual([
      { due: { prefix: 'FV-1', consecutive: 68, quote: 1, date: '2026-09-20' }, value: 700_000 },
      { due: { prefix: 'FV-1', consecutive: 70, quote: 1, date: '2026-10-01' }, value: 400_000 },
    ]);
    expect(String(body.observations)).toMatch(/BAN-77/);
  });
  it('sin tipo de documento o con un número raro, lo dice', () => {
    const r = buildSiigoVoucherMulti({
      payload: { ...receipt, applications: [{ invoiceNumber: 'raro', invoiceExternalId: null, invoiceDate: null, amount: 5 }] },
      documentId: null,
      payment: null,
    });
    expect(r.problems.join(' ')).toMatch(/RC/);
    expect(r.problems.join(' ')).toMatch(/raro/);
  });
});

const invoiceRaw = {
  id: 'inv-1',
  total: 1190,
  items: [
    { code: 'SERV-1', description: 'Atención', quantity: 2, price: 500, discount: 0, total: 1000, taxes: [{ id: 13156 }] },
    { code: 'SERV-2', description: 'Con descuento', quantity: 1, price: 100, discount: 10, total: 90 },
  ],
};

describe('nota crédito', () => {
  it('lee las líneas de la factura (neto después de descuento)', () => {
    const d = readSiigoInvoiceDetail(invoiceRaw);
    expect(d?.items[0]).toMatchObject({ code: 'SERV-1', quantity: 2, price: 500, taxes: [{ id: 13156 }] });
    expect(d?.items[1]?.price).toBe(90);
    expect(readSiigoInvoiceDetail(null)).toBeNull();
  });
  const note: CreditNotePayload = {
    invoiceNumber: 'FV-1-68',
    invoiceExternalId: 'inv-1',
    customerTaxId: '900123456',
    date: '2026-10-19',
    reason: 2,
    observations: 'Anulada',
    mode: 'total',
    items: [],
  };
  it('total: copia las líneas, apunta a la factura y paga por el total', () => {
    const r = buildSiigoCreditNote({
      payload: note,
      invoice: readSiigoInvoiceDetail(invoiceRaw),
      documentId: 9,
      payment: { id: 1, name: 'Efectivo', dueDate: false },
      taxes: [],
    });
    expect(r.problems).toEqual([]);
    expect(r.total).toBe(1190);
    expect(r.body).toMatchObject({ document: { id: 9 }, invoice: 'inv-1', reason: 2, payments: [{ id: 1, value: 1190 }] });
    expect((r.body.items as unknown[]).length).toBe(2);
    expect(r.body).not.toHaveProperty('stamp');
  });
  it('ítems propios: IVA del catálogo y total con impuestos; stamp sólo si se pide', () => {
    const r = buildSiigoCreditNote({
      payload: { ...note, mode: 'items', items: [{ description: 'Devolución', productCode: 'SERV-1', quantity: 2, unitPrice: 100, taxRate: 'iva_19' }] },
      invoice: readSiigoInvoiceDetail(invoiceRaw),
      documentId: 9,
      payment: { id: 1, name: 'Crédito', dueDate: true },
      taxes: [{ id: 13156, name: 'IVA 19%', type: 'IVA', percentage: 19 }],
      stamp: true,
    });
    expect(r.problems).toEqual([]);
    expect(r.total).toBe(238);
    expect((r.body.items as Array<{ taxes: unknown }>)[0]?.taxes).toEqual([{ id: 13156 }]);
    expect(r.body.stamp).toEqual({ send: true });
    expect((r.body.payments as Array<{ due_date?: string }>)[0]?.due_date).toBe('2026-10-19');
  });
  it('factura que no se encuentra y IVA que no existe', () => {
    const r = buildSiigoCreditNote({
      payload: { ...note, mode: 'items', items: [{ description: 'x', productCode: 'A', quantity: 1, unitPrice: 1, taxRate: 'iva_5' }] },
      invoice: null,
      documentId: null,
      payment: null,
      taxes: [],
    });
    expect(r.problems.join(' ')).toMatch(/NC/);
    expect(r.problems.join(' ')).toMatch(/FV-1-68/);
    expect(r.problems.join(' ')).toMatch(/IVA del 5/);
  });
});

function fakeClient(handlers: { get?: (path: string, q?: Record<string, unknown>) => unknown; post?: (path: string, body: unknown, o?: unknown) => unknown }) {
  return {
    get: vi.fn(async (path: string, q?: Record<string, unknown>) => handlers.get?.(path, q)),
    post: vi.fn(async (path: string, body: unknown, o?: unknown) => handlers.post?.(path, body, o)),
  } as unknown as SiigoClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };
}

describe('siigoOutbound con un cliente de mentira', () => {
  it('el cliente que ya existe no se toca ni se vuelve a crear', async () => {
    const client = fakeClient({ get: () => ({ results: [{ id: 'c1', identification: '900123456', name: ['Avianca'] }] }) });
    const out = await siigoOutbound(client).upsertCustomer(company, { idempotencyKey: 'k' });
    expect(out).toEqual({ id: 'c1', name: 'Avianca', created: false });
    expect(client.post).not.toHaveBeenCalled();
  });
  it('crea el cliente si no existe', async () => {
    const client = fakeClient({
      get: () => ({ results: [] }),
      post: () => ({ id: 'c9', name: ['Avianca Cargo SAS'] }),
    });
    const out = await siigoOutbound(client).upsertCustomer(company, { idempotencyKey: 'k' });
    expect(out).toEqual({ id: 'c9', name: 'Avianca Cargo SAS', created: true });
    expect(client.post).toHaveBeenCalledWith('/v1/customers', expect.objectContaining({ identification: '900123456' }), expect.objectContaining({ idempotencyKey: 'k' }));
  });
  it('una carrera: Siigo dice que ya existe', async () => {
    const client = fakeClient({
      get: () => ({ results: [] }),
      post: () => {
        throw new ProviderValidationError('x', ['already_exists: ya existe'], 400);
      },
    });
    const out = await siigoOutbound(client).upsertCustomer(company, { idempotencyKey: 'k' });
    expect(out.created).toBe(false);
  });
  it('recibo: lee el catálogo RC, elige la única forma de pago de contado y manda con la llave', async () => {
    const client = fakeClient({
      get: (path) =>
        path === '/v1/document-types'
          ? [{ id: 7, active: true }]
          : [{ id: 5636, name: 'Bancolombia', active: true, due_date: false }],
      post: () => ({ id: 'rc-1', name: 'RC-1-12', total: 1_100_000 }),
    });
    const out = await siigoOutbound(client).createReceipt?.(receipt, { idempotencyKey: 'KEY' });
    expect(out).toMatchObject({ id: 'rc-1', number: 'RC-1-12' });
    expect(client.post).toHaveBeenCalledWith('/v1/vouchers', expect.objectContaining({ type: 'DebtPayment' }), { idempotencyKey: 'KEY', noun: 'el recibo de caja' });
  });
  it('recibo con dos formas de pago de contado y ninguna elegida: no manda nada', async () => {
    const client = fakeClient({
      get: (path) =>
        path === '/v1/document-types'
          ? [{ id: 7 }]
          : [{ id: 1, name: 'Caja', due_date: false }, { id: 2, name: 'Davivienda', due_date: false }],
    });
    await expect(siigoOutbound(client).createReceipt?.(receipt, { idempotencyKey: 'K' })).rejects.toThrow(/Elige/);
    expect(client.post).not.toHaveBeenCalled();
    const ok = fakeClient({
      get: (path) =>
        path === '/v1/document-types'
          ? [{ id: 7 }]
          : [{ id: 1, name: 'Caja', due_date: false }, { id: 2, name: 'Davivienda', due_date: false }],
      post: () => ({ id: 'x', name: 'RC-1-1' }),
    });
    await siigoOutbound(ok).createReceipt?.(receipt, { idempotencyKey: 'K', paymentTypeId: '2' });
    expect((ok.post.mock.calls[0]?.[1] as { payment: { id: number } }).payment.id).toBe(2);
  });
  it('nota crédito total: lee la factura por id y crea', async () => {
    const client = fakeClient({
      get: (path) => {
        if (path === '/v1/document-types') return [{ id: 9 }];
        if (path === '/v1/payment-types') return [{ id: 1, name: 'Efectivo', due_date: false }];
        if (path.startsWith('/v1/invoices/')) return invoiceRaw;
        return [];
      },
      post: () => ({ id: 'nc-1', name: 'NC-1-3', total: 1190, stamp: { status: 'Accepted' } }),
    });
    const out = await siigoOutbound(client).createCreditNote?.(
      { invoiceNumber: 'FV-1-68', invoiceExternalId: 'inv-1', customerTaxId: null, date: '2026-10-19', reason: 2, observations: '', mode: 'total', items: [] },
      { idempotencyKey: 'K', stamp: true },
    );
    expect(out).toMatchObject({ id: 'nc-1', number: 'NC-1-3', total: 1190, einvoiceStatus: 'Accepted' });
    expect((client.post.mock.calls[0]?.[1] as { stamp?: unknown }).stamp).toEqual({ send: true });
  });
  it('nota crédito: si la factura no está en Siigo no manda nada', async () => {
    const client = fakeClient({
      get: (path) => (path === '/v1/document-types' ? [{ id: 9 }] : path === '/v1/payment-types' ? [{ id: 1, name: 'E', due_date: false }] : { results: [] }),
    });
    await expect(
      siigoOutbound(client).createCreditNote?.(
        { invoiceNumber: 'FV-1-99', invoiceExternalId: null, customerTaxId: null, date: '2026-10-19', reason: 2, observations: '', mode: 'total', items: [] },
        { idempotencyKey: 'K' },
      ),
    ).rejects.toThrow(/FV-1-99/);
    expect(client.post).not.toHaveBeenCalled();
  });
});
