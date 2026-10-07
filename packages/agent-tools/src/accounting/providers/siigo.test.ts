import { describe, expect, it, vi } from 'vitest';
import type { ProviderToken } from '../types';
import {
  normalizeSiigoCustomer,
  normalizeSiigoInvoice,
  normalizeSiigoProduct,
  normalizeSiigoVoucher,
  siigoProvider,
  siigoQueries,
} from './siigo';
import { SiigoClient, SiigoError, siigoPartnerId } from './siigo-client';

/**
 * Siigo de punta a punta sin Siigo: un `fetch` de mentira que contesta lo que
 * dice la documentación oficial (siigoapi.docs.apiary.io) —el token de /auth,
 * las páginas con `pagination.total_results`, el 429 de `requests_limit`— y los
 * registros de ejemplo copiados de ahí mismo.
 */

type Call = { url: string; init: RequestInit };

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fakeSiigo(handler: (url: URL, init: RequestInit, n: number) => Response) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: String(input), init: init ?? {} });
    return handler(url, init ?? {}, calls.length);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const AUTH_OK = {
  access_token: 'tok-1',
  expires_in: 86400,
  token_type: 'Bearer',
  scope: 'SiigoAPI',
};

function client(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof SiigoClient>[0]> = {},
) {
  return new SiigoClient({
    username: 'sandbox@siigoapi.com',
    accessKey: 'NDllMzI0NmEtNjExZC00NGM3LWE3OTQtMWUyNTNlZWU0ZTM0OkosU2MwLD4xQ08=',
    partnerId: 'CortexTest',
    fetch: fetchImpl,
    sleep: async () => undefined,
    minIntervalMs: 0,
    ...extra,
  });
}

describe('el cliente de Siigo', () => {
  it('se autentica con usuario, access key y Partner-Id, y usa el token como Bearer', async () => {
    const { fetchImpl, calls } = fakeSiigo((url) =>
      url.pathname === '/auth'
        ? json(201, AUTH_OK)
        : json(200, { pagination: { page: 1, page_size: 100, total_results: 0 }, results: [] }),
    );
    await client(fetchImpl).page('/v1/customers', {}, 1);
    const [auth, list] = calls;
    expect(auth?.url).toBe('https://api.siigo.com/auth');
    expect(JSON.parse(String(auth?.init.body))).toEqual({
      username: 'sandbox@siigoapi.com',
      access_key: 'NDllMzI0NmEtNjExZC00NGM3LWE3OTQtMWUyNTNlZWU0ZTM0OkosU2MwLD4xQ08=',
    });
    expect((auth?.init.headers as Record<string, string>)['Partner-Id']).toBe('CortexTest');
    expect(list?.url).toBe('https://api.siigo.com/v1/customers?page=1&page_size=100');
    const headers = list?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-1');
    expect(headers['Partner-Id']).toBe('CortexTest');
  });

  it('el Partner-Id sale limpio: sólo letras y números, con «Cortex» por defecto', () => {
    expect(siigoPartnerId('Cortex Agent!')).toBe('CortexAgent');
    expect(siigoPartnerId('')).toBe('Cortex');
    expect(siigoPartnerId('a b')).toBe('Cortex');
    expect(siigoPartnerId(undefined)).toBe('Cortex');
  });

  it('reutiliza el token guardado mientras no esté por vencer, y guarda el nuevo', async () => {
    const now = 1_800_000_000_000;
    let stored: ProviderToken | null = { token: 'guardado', expiresAt: now + 5 * 60 * 60_000 };
    const saves: ProviderToken[] = [];
    const tokenStore = {
      load: async () => stored,
      save: async (t: ProviderToken) => {
        saves.push(t);
        stored = t;
      },
    };
    const { fetchImpl, calls } = fakeSiigo((url) =>
      url.pathname === '/auth' ? json(201, AUTH_OK) : json(200, { results: [] }),
    );
    await client(fetchImpl, { tokenStore, now: () => now }).get('/v1/products');
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/products']);
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer guardado',
    );

    // A 20 minutos de vencer ya no sirve: pide uno nuevo y lo guarda (24 h).
    stored = { token: 'casi-vencido', expiresAt: now + 20 * 60_000 };
    await client(fetchImpl, { tokenStore, now: () => now }).get('/v1/products');
    expect(saves).toHaveLength(1);
    expect(saves[0]?.token).toBe('tok-1');
    expect(saves[0]?.expiresAt).toBe(now + 86_400_000);
  });

  it('un 429 espera lo que dice Retry-After y reintenta', async () => {
    const sleeps: number[] = [];
    let listCalls = 0;
    const { fetchImpl } = fakeSiigo((url) => {
      if (url.pathname === '/auth') return json(201, AUTH_OK);
      listCalls += 1;
      if (listCalls === 1)
        return json(
          429,
          { Status: 429, Errors: [{ Code: 'requests_limit' }] },
          { 'retry-after': '7' },
        );
      return json(200, {
        pagination: { page: 1, page_size: 100, total_results: 1 },
        results: [{ id: 'x' }],
      });
    });
    const page = await client(fetchImpl, { sleep: async (ms) => void sleeps.push(ms) }).page(
      '/v1/invoices',
      {},
      1,
    );
    expect(page.results).toHaveLength(1);
    expect(sleeps).toContain(7_000);
  });

  it('un 429 que no cede termina en un error en español, con espera creciente', async () => {
    const sleeps: number[] = [];
    const { fetchImpl } = fakeSiigo((url) =>
      url.pathname === '/auth'
        ? json(201, AUTH_OK)
        : json(429, { Errors: [{ Code: 'requests_limit' }] }),
    );
    const c = client(fetchImpl, { sleep: async (ms) => void sleeps.push(ms), maxRetries: 3 });
    const err = await c.page('/v1/invoices', {}, 1).catch((e) => e);
    expect(err).toBeInstanceOf(SiigoError);
    expect((err as SiigoError).kind).toBe('rate');
    expect((err as SiigoError).message).toContain('bajar el ritmo');
    expect(sleeps).toEqual([5_000, 10_000, 20_000]);
  });

  it('una llave mala se dice en español y no se reintenta', async () => {
    const { fetchImpl, calls } = fakeSiigo(() =>
      json(401, {
        Status: 401,
        Errors: [{ Code: 'unauthorized', Message: 'Invalid credentials' }],
      }),
    );
    const err = await client(fetchImpl)
      .verify()
      .catch((e) => e);
    expect(err).toBeInstanceOf(SiigoError);
    expect((err as SiigoError).kind).toBe('credentials');
    expect((err as SiigoError).message).toContain('Mi credencial API');
    expect(calls).toHaveLength(1);
  });

  it('un token que Siigo dejó de reconocer se renueva una vez', async () => {
    let auths = 0;
    let lists = 0;
    const { fetchImpl } = fakeSiigo((url) => {
      if (url.pathname === '/auth') {
        auths += 1;
        return json(201, { ...AUTH_OK, access_token: `tok-${auths}` });
      }
      lists += 1;
      return lists === 1
        ? json(401, { Errors: [{ Code: 'unauthorized' }] })
        : json(200, { results: [] });
    });
    await client(fetchImpl).get('/v1/customers');
    expect(auths).toBe(2);
    expect(lists).toBe(2);
  });

  it('recorre las páginas hasta total_results', async () => {
    const { fetchImpl, calls } = fakeSiigo((url) => {
      if (url.pathname === '/auth') return json(201, AUTH_OK);
      const page = Number(url.searchParams.get('page'));
      const results =
        page < 3
          ? Array.from({ length: 100 }, (_, i) => ({ id: `${page}-${i}` }))
          : [{ id: '3-0' }];
      return json(200, { pagination: { page, page_size: 100, total_results: 201 }, results });
    });
    const seen: number[] = [];
    for await (const page of client(fetchImpl).pages('/v1/customers', {
      created_start: '2026-01-01',
    }))
      seen.push(page.results.length);
    expect(seen).toEqual([100, 100, 1]);
    expect(calls.filter((c) => c.url.includes('/v1/customers'))).toHaveLength(3);
    expect(calls[1]?.url).toContain('created_start=2026-01-01');
  });
});

describe('de Siigo a la forma común', () => {
  // El ejemplo de factura de la documentación, con una cuota a crédito.
  const invoice = {
    id: '63f918c2-ca65-4edc-a7db-66bcdd5159fb',
    document: { id: 24446 },
    number: 22,
    name: 'FV-2-22',
    date: '2026-07-15',
    customer: {
      id: '6b6ceb28-b2eb-4b98-b3dd-26648a933c81',
      identification: '13832081',
      branch_office: 0,
    },
    total: 2546.05,
    balance: 1273.02,
    stamp: { status: 'Accepted' },
    payments: [
      { id: 5636, name: 'Crédito', value: 1273.03, due_date: '2026-08-14' },
      { id: 5637, name: 'Crédito', value: 1273.02, due_date: '2026-09-13' },
    ],
    public_url: 'https://documentview.siigo.com/document?data=MS4ruap0JuOL8dao3oKEMa',
    metadata: { created: '2026-07-15T03:33:17.208Z' },
  };

  it('una factura: número, saldo, vencimiento de la última cuota, peso por defecto', () => {
    expect(normalizeSiigoInvoice(invoice)).toMatchObject({
      externalId: invoice.id,
      number: 'FV-2-22',
      date: '2026-07-15',
      dueDate: '2026-09-13',
      customerExternalId: '6b6ceb28-b2eb-4b98-b3dd-26648a933c81',
      customerTaxId: '13832081',
      total: 2546.05,
      balance: 1273.02,
      currency: 'COP',
      status: 'open',
      einvoiceStatus: 'Aceptada',
    });
  });

  it('una factura anulada no debe nada, y una en dólares se queda en dólares', () => {
    expect(normalizeSiigoInvoice({ ...invoice, annulled: true })).toMatchObject({
      balance: 0,
      status: 'annulled',
    });
    expect(normalizeSiigoInvoice({ ...invoice, currency: { code: 'usd' } })?.currency).toBe('USD');
    expect(normalizeSiigoInvoice({ ...invoice, balance: 0 })?.status).toBe('paid');
  });

  it('sin número, fecha o total no hay factura que contar', () => {
    expect(normalizeSiigoInvoice({ ...invoice, name: undefined, number: undefined })).toBeNull();
    expect(normalizeSiigoInvoice({ ...invoice, date: 'ayer' })).toBeNull();
    expect(normalizeSiigoInvoice({ ...invoice, total: undefined })).toBeNull();
  });

  it('un recibo que abona a dos facturas son dos líneas, cada una con su factura', () => {
    const voucher = {
      id: 'rc-1',
      name: 'RC-1-9',
      date: '2026-08-20',
      type: 'DebtPayment',
      customer: { id: 'c-1', identification: '900.123.456' },
      items: [
        { due: { prefix: 'FV-2', consecutive: 22, quote: 1 }, value: 1000 },
        { due: { prefix: 'FV-2', consecutive: 23, quote: 1 }, value: 500 },
      ],
      payment: { id: 5636, name: 'Bancolombia', value: 1500 },
    };
    expect(normalizeSiigoVoucher(voucher)).toMatchObject({
      externalId: 'rc-1',
      amount: 1500,
      kind: 'Abono a factura',
      method: 'Bancolombia',
      customerTaxId: '900123456',
      applications: [
        { ref: 'rc-1:0', invoiceNumber: 'FV-2-22', amount: 1000 },
        { ref: 'rc-1:1', invoiceNumber: 'FV-2-23', amount: 500 },
      ],
    });
  });

  it('un anticipo es un solo pago sin factura; un detallado no suma sus líneas contables', () => {
    expect(
      normalizeSiigoVoucher({
        id: 'rc-2',
        date: '2026-08-21',
        type: 'AdvancePayment',
        payment: { value: 300 },
      })?.applications,
    ).toEqual([{ ref: 'rc-2', invoiceNumber: null, amount: 300 }]);
    expect(
      normalizeSiigoVoucher({
        id: 'rc-3',
        date: '2026-08-21',
        type: 'Detailed',
        items: [{ value: 119000 }, { value: 119000 }],
      }),
    ).toBeNull();
  });

  it('un cliente y un producto, con nombres y estados en español', () => {
    expect(
      normalizeSiigoCustomer({
        id: 'c-1',
        person_type: 'Company',
        identification: '900123456',
        check_digit: '7',
        name: ['Coltrans S.A.S.'],
        active: true,
        address: {
          address: 'Cra. 18 #79A - 42',
          city: { city_name: 'Bogotá', state_name: 'Bogotá D.C.' },
        },
        phones: [{ indicative: '57', number: '3006003345' }],
        contacts: [{ first_name: 'Marcos', last_name: 'Castillo', email: 'm@coltrans.co' }],
        metadata: { created: '2026-01-02T10:00:00Z' },
      }),
    ).toMatchObject({
      name: 'Coltrans S.A.S.',
      taxId: '900123456',
      taxIdDisplay: '900123456-7',
      kind: 'Empresa',
      city: 'Bogotá, Bogotá D.C.',
      phone: '+57 3006003345',
      email: 'm@coltrans.co',
      active: true,
      createdOn: '2026-01-02',
    });
    expect(
      normalizeSiigoProduct({
        id: 'p-1',
        code: 'Item-1',
        name: 'Camiseta de algodón',
        type: 'Service',
        active: false,
        prices: [{ currency_code: 'COP', price_list: [{ position: 1, value: 12000 }] }],
        available_quantity: 4,
      }),
    ).toMatchObject({ kind: 'Servicio', price: 12000, stock: 4, active: false });
    expect(
      normalizeSiigoCustomer({
        id: 's-1',
        type: 'Supplier',
        name: ['Proveedor S.A.'],
        active: false,
      }),
    ).toMatchObject({ relationship: 'Proveedor', active: false });
  });
});

describe('qué se le pide a Siigo', () => {
  const now = new Date('2026-10-01T12:00:00Z');

  it('la primera vez: todos los clientes, productos, facturas y recibos disponibles', () => {
    expect(siigoQueries('invoices', { mode: 'initial', now })).toEqual([{}]);
    expect(siigoQueries('payments', { mode: 'initial', now })).toEqual([{}]);
    expect(siigoQueries('customers', { mode: 'initial', now })).toEqual([
      { type: 'Customer', active: 'true' },
      { type: 'Customer', active: 'false' },
      { type: 'Supplier', active: 'true' },
      { type: 'Supplier', active: 'false' },
      { type: 'Other', active: 'true' },
      { type: 'Other', active: 'false' },
    ]);
    const products = siigoQueries('products', { mode: 'initial', now });
    expect(products).toHaveLength(12);
    expect(products).toContainEqual({ type: 'Service', active: 'false', stock_control: 'false' });
    expect(products).toContainEqual({ type: 'Product', active: 'true', stock_control: 'true' });
  });

  it('el repaso diario mira seis meses; lo incremental, lo nuevo Y lo cambiado', () => {
    expect(siigoQueries('invoices', { mode: 'sweep', now })).toEqual([
      { date_start: '2026-04-01' },
    ]);
    const productUpdates = siigoQueries('products', {
      mode: 'incremental',
      since: '2026-10-01T11:50:00.000Z',
      now,
    });
    expect(productUpdates).toHaveLength(24);
    expect(productUpdates).toContainEqual({
      type: 'Service',
      active: 'false',
      stock_control: 'true',
      updated_start: '2026-10-01T11:50:00Z',
    });
    expect(
      siigoQueries('customers', { mode: 'incremental', since: '2026-10-01T11:50:00.000Z', now }),
    ).toHaveLength(12);
  });

  it('el programa abre una sesión que devuelve la forma común y cuenta lo ilegible', async () => {
    const { fetchImpl } = fakeSiigo((url) =>
      url.pathname === '/auth'
        ? json(201, AUTH_OK)
        : json(200, {
            pagination: { page: 1, page_size: 100, total_results: 2 },
            results: [
              { id: 'i-1', name: 'FV-1-1', date: '2026-09-01', total: 100, balance: 100 },
              { id: 'i-2', date: '2026-09-01', total: 100 },
            ],
          }),
    );
    const session = siigoProvider.open(
      { username: 'u@x.co', access_key: 'llave-de-prueba' },
      { fetch: fetchImpl, sleep: async () => undefined, minIntervalMs: 0 },
    );
    const page = await session.listPage('invoices', { date_start: '2026-01-01' }, 1);
    expect(page.records).toHaveLength(1);
    expect(page.skipped).toBe(1);
    expect(page.hasMore).toBe(false);
    expect(session.requests).toBe(2);
  });
});
