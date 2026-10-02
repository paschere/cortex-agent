import { describe, expect, it, vi } from 'vitest';
import {
  alegraInvoiceNumber,
  alegraProvider,
  alegraQueries,
  normalizeAlegraContact,
  normalizeAlegraInvoice,
  normalizeAlegraItem,
  normalizeAlegraPayment,
} from './alegra';
import { AlegraClient, AlegraError, alegraAuthorization } from './alegra-client';

/**
 * Alegra de punta a punta sin Alegra: un `fetch` de mentira que contesta lo
 * que dice la documentación oficial (developer.alegra.com) —Basic con correo y
 * token, `start`/`limit` de a 30 con `metadata.total`, el 429 con
 * `X-Rate-Limit-Reset`— y los registros de ejemplo copiados de ahí mismo.
 */

type Call = { url: string; init: RequestInit };

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fakeAlegra(handler: (url: URL, n: number) => Response) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(new URL(String(input)), calls.length);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function client(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof AlegraClient>[0]> = {},
) {
  return new AlegraClient({
    email: 'contabilidad@andina.co',
    token: 'f8c2b1e0a9d7',
    fetch: fetchImpl,
    sleep: async () => undefined,
    minIntervalMs: 0,
    ...extra,
  });
}

describe('el cliente de Alegra', () => {
  it('manda Basic con correo:token en base64 y pide de a 30 con metadata', async () => {
    const { fetchImpl, calls } = fakeAlegra(() => json(200, { metadata: { total: 0 }, data: [] }));
    await client(fetchImpl).page('/invoices', { date_afterOrNow: '2025-10-01' }, 2);
    const call = calls[0];
    const url = new URL(call?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://api.alegra.com/api/v1/invoices');
    expect(url.searchParams.get('start')).toBe('30');
    expect(url.searchParams.get('limit')).toBe('30');
    expect(url.searchParams.get('metadata')).toBe('true');
    expect(url.searchParams.get('date_afterOrNow')).toBe('2025-10-01');
    const auth = (call?.init.headers as Record<string, string>).Authorization;
    expect(auth).toBe(
      `Basic ${Buffer.from('contabilidad@andina.co:f8c2b1e0a9d7').toString('base64')}`,
    );
    expect(auth).toBe(alegraAuthorization('contabilidad@andina.co', 'f8c2b1e0a9d7'));
  });

  it('recorre las páginas hasta metadata.total, y sin metadata hasta una página corta', async () => {
    const { fetchImpl } = fakeAlegra((url) => {
      const start = Number(url.searchParams.get('start'));
      const n = start < 60 ? 30 : 5;
      return json(200, {
        metadata: { total: 65 },
        data: Array.from({ length: n }, (_, i) => ({ id: `${start + i}` })),
      });
    });
    const session = alegraProvider.open(
      { email: 'a@b.co', token: 'tok-123' },
      { fetch: fetchImpl, sleep: async () => undefined, minIntervalMs: 0 },
    );
    const seen: number[] = [];
    for (let page = 1; ; page++) {
      const p = await session.listPage('products', {}, page);
      seen.push(p.records.length);
      if (!p.hasMore) break;
    }
    expect(seen).toEqual([30, 30, 5]);

    const bare = fakeAlegra(() => json(200, [{ id: '1' }, { id: '2' }]));
    const page = await client(bare.fetchImpl).page('/items', {}, 1);
    expect(page.total).toBeNull();
    expect(page.results).toHaveLength(2);
  });

  it('un 429 espera lo que dice X-Rate-Limit-Reset y reintenta', async () => {
    const sleeps: number[] = [];
    const { fetchImpl } = fakeAlegra((_url, n) =>
      n === 1
        ? json(429, { message: 'Too Many request' }, { 'x-rate-limit-reset': '12' })
        : json(200, { metadata: { total: 1 }, data: [{ id: '1' }] }),
    );
    const page = await client(fetchImpl, { sleep: async (ms) => void sleeps.push(ms) }).page(
      '/contacts',
      {},
      1,
    );
    expect(page.results).toHaveLength(1);
    expect(sleeps).toContain(12_000);
  });

  it('un 429 que no cede termina en un error en español, con espera creciente', async () => {
    const sleeps: number[] = [];
    const { fetchImpl } = fakeAlegra(() => json(429, { message: 'Too Many request' }));
    const err = await client(fetchImpl, {
      sleep: async (ms) => void sleeps.push(ms),
      maxRetries: 3,
    })
      .page('/invoices', {}, 1)
      .catch((e) => e);
    expect(err).toBeInstanceOf(AlegraError);
    expect((err as AlegraError).kind).toBe('rate');
    expect(sleeps).toEqual([5_000, 10_000, 20_000]);
  });

  it('una llave mala se dice en español, sin reintentar; una cuenta suspendida también', async () => {
    const bad = fakeAlegra(() => json(401, { code: 401, message: 'Unauthorized' }));
    const err = await client(bad.fetchImpl)
      .verify()
      .catch((e) => e);
    expect(err).toBeInstanceOf(AlegraError);
    expect((err as AlegraError).kind).toBe('credentials');
    expect((err as AlegraError).message).toContain('Integraciones con otros sistemas');
    expect(bad.calls).toHaveLength(1);

    const suspended = fakeAlegra(() => json(402, { code: 402 }));
    const err2 = await client(suspended.fetchImpl)
      .verify()
      .catch((e) => e);
    expect((err2 as AlegraError).kind).toBe('forbidden');
  });

  it('«Probar y conectar» lee un contacto y no devuelve token (Basic no tiene)', async () => {
    const { fetchImpl, calls } = fakeAlegra(() => json(200, [{ id: '1' }]));
    const session = alegraProvider.open(
      { email: 'a@b.co', token: 'tok-123' },
      { fetch: fetchImpl, sleep: async () => undefined, minIntervalMs: 0 },
    );
    await expect(session.verify()).resolves.toEqual({ token: null });
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/api/v1/contacts');
  });
});

describe('de Alegra a la forma común', () => {
  // El ejemplo de factura de la documentación.
  const invoice = {
    id: '1',
    date: '2026-09-15',
    dueDate: '2026-10-15',
    datetime: '2026-09-16 13:46:50',
    observations: '',
    anotation: 'Favor consignar a la cuenta XXXXXX',
    status: 'open',
    total: 609,
    totalPaid: 9,
    balance: 600,
    client: { id: '1', name: 'Coorporación Alegrate', identification: '159.549.847' },
    numberTemplate: { id: '1', prefix: 'A-', number: 520 },
    currency: { code: 'USD', symbol: '$', exchangeRate: 2950 },
  };

  it('una factura: número del prefijo, saldo, vencimiento, cliente y moneda', () => {
    expect(normalizeAlegraInvoice(invoice)).toMatchObject({
      externalId: '1',
      number: 'A-520',
      date: '2026-09-15',
      dueDate: '2026-10-15',
      customerExternalId: '1',
      customerName: 'Coorporación Alegrate',
      customerTaxId: '159549847',
      total: 609,
      balance: 600,
      currency: 'USD',
      status: 'open',
      notes: 'Favor consignar a la cuenta XXXXXX',
    });
    expect(alegraInvoiceNumber({ id: '9', numberTemplate: { fullNumber: 'FE1234' } })).toBe(
      'FE1234',
    );
    expect(alegraInvoiceNumber({ id: '9' })).toBe('9');
  });

  it('cerrada es pagada, anulada no debe nada, y sin moneda va la de la empresa', () => {
    expect(normalizeAlegraInvoice({ ...invoice, status: 'closed', balance: 0 })?.status).toBe(
      'paid',
    );
    expect(normalizeAlegraInvoice({ ...invoice, status: 'void' })).toMatchObject({
      status: 'annulled',
      balance: 0,
    });
    expect(normalizeAlegraInvoice({ ...invoice, currency: null }, 'MXN')?.currency).toBe('MXN');
    expect(normalizeAlegraInvoice({ ...invoice, total: undefined })).toBeNull();
    expect(
      normalizeAlegraInvoice({ ...invoice, stamp: { legalStatus: 'STAMPED_AND_ACCEPTED' } })
        ?.einvoiceStatus,
    ).toBe('Aceptada');
  });

  it('un pago (ejemplo de la documentación) abona a sus facturas con su valor', () => {
    const payment = {
      id: '1',
      date: '2026-09-10',
      number: '140',
      amount: '600.00',
      type: 'in',
      status: 'open',
      paymentMethod: 'cash',
      observations: 'Observaciones del pago',
      client: { id: '20', name: 'Juan Carlos' },
      bankAccount: { id: '2', name: 'Bancolombia', type: 'bank' },
      invoices: [
        { id: '6', number: 'AL-12', amount: '100' },
        { id: '200', number: 'AL-13', amount: 500 },
      ],
      currency: { code: 'COP', symbol: '$' },
    };
    expect(normalizeAlegraPayment(payment)).toMatchObject({
      externalId: '1',
      number: '140',
      amount: 600,
      currency: 'COP',
      kind: 'Abono a factura',
      method: 'Efectivo · Bancolombia',
      customerExternalId: '20',
      customerName: 'Juan Carlos',
      applications: [
        { ref: '1:0', invoiceNumber: 'AL-12', amount: 100 },
        { ref: '1:1', invoiceNumber: 'AL-13', amount: 500 },
      ],
    });
    // Una sola factura sin valor: va todo a ésa. Sin facturas: anticipo.
    expect(
      normalizeAlegraPayment({ ...payment, invoices: [{ id: '6', number: 'AL-12' }] })
        ?.applications,
    ).toEqual([{ ref: '1', invoiceNumber: 'AL-12', amount: 600 }]);
    expect(normalizeAlegraPayment({ ...payment, invoices: [] })).toMatchObject({
      kind: 'Anticipo',
      applications: [{ ref: '1', invoiceNumber: null, amount: 600 }],
    });
  });

  it('un contacto y un ítem (ejemplos de la documentación), en español', () => {
    expect(
      normalizeAlegraContact({
        id: '1',
        name: 'Coorporación Alegrate',
        identification: '159.549.847',
        identificationObject: { type: 'NIT', number: '1231232288', dv: '9' },
        kindOfPerson: 'LEGAL_ENTITY',
        email: 'prueba@alegra.com',
        phonePrimary: '999-99-99',
        mobile: '(333) 555-55-55',
        address: { address: 'Calle principal #45', city: 'Barcelona', department: 'Meta' },
        type: ['client', 'provider'],
        status: 'active',
      }),
    ).toMatchObject({
      externalId: '1',
      name: 'Coorporación Alegrate',
      taxId: '1231232288',
      taxIdDisplay: '1231232288-9',
      kind: 'Empresa',
      city: 'Barcelona, Meta',
      phone: '999-99-99',
      email: 'prueba@alegra.com',
      active: true,
    });
    expect(
      normalizeAlegraItem({
        id: '1',
        name: 'Billetera',
        reference: 'REF-005',
        description: 'Billetera de cuero negro',
        status: 'active',
        type: 'simple',
        category: { id: '54', name: 'Ventas' },
        price: [{ idPriceList: '1', name: 'General', price: 1200 }],
        inventory: { unit: 'piece', availableQuantity: 150, unitCost: 560 },
      }),
    ).toMatchObject({
      name: 'Billetera',
      code: 'REF-005',
      kind: 'Producto',
      group: 'Ventas',
      price: 1200,
      stock: 150,
      unit: 'piece',
      active: true,
    });
  });
});

describe('qué se le pide a Alegra', () => {
  const now = new Date('2026-10-01T12:00:00Z');

  it('la primera vez: el último año de facturas y pagos, todos los clientes', () => {
    expect(alegraQueries('invoices', { mode: 'initial', now })).toEqual([
      { order_field: 'id', order_direction: 'ASC', date_afterOrNow: '2025-10-01' },
    ]);
    expect(alegraQueries('payments', { mode: 'initial', now })).toEqual([
      { type: 'in', order_field: 'date', order_direction: 'DESC', _desde: '2025-10-01' },
    ]);
    expect(alegraQueries('customers', { mode: 'initial', now })).toEqual([
      { order_field: 'id', order_direction: 'ASC', type: 'client' },
    ]);
  });

  it('el repaso mira seis meses; lo incremental, con margen; clientes una vez al día', () => {
    expect(alegraQueries('invoices', { mode: 'sweep', now })[0]?.date_afterOrNow).toBe(
      '2026-04-01',
    );
    expect(
      alegraQueries('invoices', { mode: 'incremental', since: '2026-10-01T11:50:00Z', now })[0]
        ?.date_afterOrNow,
    ).toBe('2026-09-28');
    expect(
      alegraQueries('payments', { mode: 'incremental', since: '2026-10-01T11:50:00Z', now })[0]
        ?._desde,
    ).toBe('2026-09-24');
    // Mismo día en Bogotá: nada; ya es otro día: completos.
    expect(
      alegraQueries('customers', { mode: 'incremental', since: '2026-10-01T11:50:00Z', now }),
    ).toEqual([]);
    expect(
      alegraQueries('products', { mode: 'incremental', since: '2026-10-01T04:00:00Z', now }),
    ).toEqual([{ order_field: 'id', order_direction: 'ASC' }]);
  });

  it('los pagos se dejan de pedir al pasar la fecha de corte, que no viaja a Alegra', async () => {
    const { fetchImpl, calls } = fakeAlegra(() =>
      json(200, {
        metadata: { total: 300 },
        data: [
          { id: 'p1', date: '2026-09-30', amount: 100, status: 'open', currency: { code: 'COP' } },
          { id: 'p2', date: '2026-09-25', amount: 50, status: 'void', currency: { code: 'COP' } },
          { id: 'p3', date: '2026-09-20', amount: 70, status: 'open', currency: { code: 'COP' } },
        ],
      }),
    );
    const session = alegraProvider.open(
      { email: 'a@b.co', token: 'tok-123' },
      { fetch: fetchImpl, sleep: async () => undefined, minIntervalMs: 0 },
    );
    const page = await session.listPage(
      'payments',
      { type: 'in', order_field: 'date', order_direction: 'DESC', _desde: '2026-09-24' },
      1,
    );
    expect(page.records.map((r) => r.externalId)).toEqual(['p1']);
    expect(page.hasMore).toBe(false);
    expect(page.skipped).toBe(0);
    expect(new URL(calls[0]?.url ?? '').searchParams.has('_desde')).toBe(false);
  });

  it('una factura sin moneda pregunta la de la empresa una vez; los borradores no cuentan', async () => {
    const { fetchImpl, calls } = fakeAlegra((url) =>
      url.pathname.endsWith('/company')
        ? json(200, { name: 'Empresa Ejemplar', currency: { code: 'COP', symbol: '$' } })
        : json(200, {
            metadata: { total: 3 },
            data: [
              { id: 'i1', date: '2026-09-01', total: 100, balance: 100, status: 'open' },
              { id: 'i2', date: '2026-09-02', total: 50, balance: 0, status: 'closed' },
              { id: 'i3', date: '2026-09-03', total: 10, status: 'draft' },
            ],
          }),
    );
    const session = alegraProvider.open(
      { email: 'a@b.co', token: 'tok-123' },
      { fetch: fetchImpl, sleep: async () => undefined, minIntervalMs: 0 },
    );
    const page = await session.listPage('invoices', { date_afterOrNow: '2026-01-01' }, 1);
    await session.listPage('invoices', { date_afterOrNow: '2026-01-01' }, 1);
    expect(page.records).toHaveLength(2);
    expect(page.records.every((r) => (r as { currency: string }).currency === 'COP')).toBe(true);
    expect(calls.filter((c) => c.url.endsWith('/company'))).toHaveLength(1);
    expect(session.requests).toBe(3);
  });
});
