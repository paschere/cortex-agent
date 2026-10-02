import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderToken } from '../types';
import {
  completeQuickbooksConnection,
  normalizeQuickbooksCustomer,
  normalizeQuickbooksInvoice,
  normalizeQuickbooksItem,
  normalizeQuickbooksPayment,
  quickbooksProvider,
  quickbooksQueries,
} from './quickbooks';
import {
  QUICKBOOKS_TOKEN_URL,
  QuickBooksClient,
  QuickBooksError,
  quickbooksAppConfig,
  quickbooksAuthorizeUrl,
  quickbooksSetupMissing,
} from './quickbooks-client';

/**
 * QuickBooks Online de punta a punta sin Intuit: un `fetch` de mentira que
 * contesta lo que dice la documentación oficial (developer.intuit.com) —el
 * endpoint de tokens con el refresh token que rota, `QueryResponse` de a 1000,
 * el 401 de un access token vencido, el 429— y los registros de ejemplo de la
 * referencia de la API.
 */

type Call = { url: string; init: RequestInit };

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fakeIntuit(handler: (url: URL, init: RequestInit, n: number) => Response) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(new URL(String(input)), init ?? {}, calls.length);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const CONFIG = {
  clientId: 'ABcd1234',
  clientSecret: 'secreto-de-la-app',
  environment: 'sandbox' as const,
  apiBase: 'https://sandbox-quickbooks.api.intuit.com',
};
const NOW = 1_800_000_000_000;
const FRESH: ProviderToken = { token: 'acceso-vigente', expiresAt: NOW + 50 * 60_000 };

function isToken(url: URL) {
  return url.toString() === QUICKBOOKS_TOKEN_URL;
}

function sql(url: URL) {
  return url.searchParams.get('query') ?? '';
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('la app de QuickBooks de la instalación', () => {
  it('sin id o secreto no hay app: un mensaje claro, nada se cae', () => {
    expect(quickbooksAppConfig({})).toBeNull();
    expect(quickbooksSetupMissing({ QUICKBOOKS_CLIENT_ID: 'x' })).toContain(
      'Falta configurar la app de QuickBooks',
    );
    expect(
      quickbooksAppConfig({ QUICKBOOKS_CLIENT_ID: 'a', QUICKBOOKS_CLIENT_SECRET: 'b' }),
    ).toMatchObject({ environment: 'production', apiBase: 'https://quickbooks.api.intuit.com' });
    expect(
      quickbooksAppConfig({
        QUICKBOOKS_CLIENT_ID: 'a',
        QUICKBOOKS_CLIENT_SECRET: 'b',
        QUICKBOOKS_ENVIRONMENT: 'sandbox',
      })?.apiBase,
    ).toBe('https://sandbox-quickbooks.api.intuit.com');
  });

  it('la dirección de Intuit pide sólo contabilidad y lleva el state', () => {
    const url = new URL(
      quickbooksAuthorizeUrl({
        clientId: 'ABcd1234',
        redirectUri: 'https://cortex.app/api/integrations/quickbooks/callback',
        state: 'st-1',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
    expect(url.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('st-1');
  });

  it('el programa sin app configurada abre una sesión que dice qué falta', async () => {
    vi.stubEnv('QUICKBOOKS_CLIENT_ID', '');
    vi.stubEnv('QUICKBOOKS_CLIENT_SECRET', '');
    expect(quickbooksProvider.setupMissing?.()).toContain('Falta configurar');
    const session = quickbooksProvider.open({
      realm_id: '123',
      refresh_token: 'r',
      company_name: 'X',
    });
    const err = await session.listPage('invoices', {}, 1).catch((e) => e);
    expect(err).toBeInstanceOf(QuickBooksError);
    expect((err as QuickBooksError).kind).toBe('setup');
  });
});

describe('el cliente de QuickBooks', () => {
  function client(
    fetchImpl: typeof fetch,
    extra: Partial<ConstructorParameters<typeof QuickBooksClient>[0]> = {},
  ) {
    return new QuickBooksClient({
      realmId: '9130354889999',
      refreshToken: 'refresh-1',
      config: CONFIG,
      fetch: fetchImpl,
      sleep: async () => undefined,
      now: () => NOW,
      minIntervalMs: 0,
      tokenStore: { load: async () => FRESH, save: async () => undefined },
      ...extra,
    });
  }

  it('pagina con STARTPOSITION y MAXRESULTS 1000, minorversion y Bearer', async () => {
    const { fetchImpl, calls } = fakeIntuit((url) => {
      const start = Number(/STARTPOSITION (\d+)/.exec(sql(url))?.[1]);
      const n = start === 1 ? 1000 : 3;
      return json(200, {
        QueryResponse: {
          Invoice: Array.from({ length: n }, (_, i) => ({ Id: `${start + i}` })),
          startPosition: start,
          maxResults: n,
        },
      });
    });
    const c = client(fetchImpl);
    const first = await c.page('Invoice', "TxnDate >= '2025-10-01'", 'MetaData.CreateTime', 1);
    const second = await c.page('Invoice', "TxnDate >= '2025-10-01'", 'MetaData.CreateTime', 2);
    expect([first.results.length, first.hasMore]).toEqual([1000, true]);
    expect([second.results.length, second.hasMore]).toEqual([3, false]);
    const url = new URL(calls[1]?.url ?? '');
    expect(url.origin + url.pathname).toBe(
      'https://sandbox-quickbooks.api.intuit.com/v3/company/9130354889999/query',
    );
    expect(sql(url)).toBe(
      "SELECT * FROM Invoice WHERE TxnDate >= '2025-10-01' ORDERBY MetaData.CreateTime STARTPOSITION 1001 MAXRESULTS 1000",
    );
    expect(url.searchParams.get('minorversion')).toBe('75');
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer acceso-vigente',
    );
  });

  it('un 401 renueva el acceso una vez, guarda el refresh token NUEVO y repite', async () => {
    const savedCredentials: Array<Record<string, string>> = [];
    const savedTokens: ProviderToken[] = [];
    let queries = 0;
    const { fetchImpl, calls } = fakeIntuit((url, init) => {
      if (isToken(url)) {
        expect((init.headers as Record<string, string>).Authorization).toBe(
          `Basic ${Buffer.from('ABcd1234:secreto-de-la-app').toString('base64')}`,
        );
        expect(String(init.body)).toBe('grant_type=refresh_token&refresh_token=refresh-1');
        return json(200, {
          token_type: 'bearer',
          access_token: 'acceso-2',
          refresh_token: 'refresh-2',
          expires_in: 3600,
          x_refresh_token_expires_in: 8726400,
        });
      }
      queries += 1;
      return queries === 1
        ? json(401, {
            fault: {
              error: [{ message: 'message=AuthenticationFailed', code: '3200' }],
              type: 'AUTHENTICATION',
            },
          })
        : json(200, { QueryResponse: { Customer: [{ Id: '1', DisplayName: 'Amy' }] } });
    });
    vi.stubEnv('QUICKBOOKS_CLIENT_ID', CONFIG.clientId);
    vi.stubEnv('QUICKBOOKS_CLIENT_SECRET', CONFIG.clientSecret);
    vi.stubEnv('QUICKBOOKS_ENVIRONMENT', 'sandbox');
    const session = quickbooksProvider.open(
      { realm_id: '9130354889999', refresh_token: 'refresh-1', company_name: 'Craig’s Design' },
      {
        fetch: fetchImpl,
        sleep: async () => undefined,
        now: () => NOW,
        minIntervalMs: 0,
        tokenStore: {
          load: async () => FRESH,
          save: async (t) => void savedTokens.push(t),
          saveCredentials: async (c) => void savedCredentials.push(c),
        },
      },
    );
    const page = await session.listPage('customers', {}, 1);
    expect(page.records).toHaveLength(1);
    expect(savedCredentials).toEqual([
      { realm_id: '9130354889999', refresh_token: 'refresh-2', company_name: 'Craig’s Design' },
    ]);
    expect(savedTokens).toEqual([{ token: 'acceso-2', expiresAt: NOW + 3_600_000 }]);
    const last = calls[calls.length - 1];
    expect((last?.init.headers as Record<string, string>).Authorization).toBe('Bearer acceso-2');
  });

  it('si el refresh token nuevo no se puede guardar, no se sigue', async () => {
    const { fetchImpl, calls } = fakeIntuit((url) =>
      isToken(url)
        ? json(200, { access_token: 'a2', refresh_token: 'refresh-2', expires_in: 3600 })
        : json(200, { QueryResponse: {} }),
    );
    const err = await client(fetchImpl, {
      tokenStore: { load: async () => null, save: async () => undefined },
      onRefreshToken: async () => {
        throw new Error('la base no respondió');
      },
    })
      .page('Customer', undefined, undefined, 1)
      .catch((e) => e);
    expect((err as Error).message).toBe('la base no respondió');
    expect(calls.every((c) => isToken(new URL(c.url)))).toBe(true);
  });

  it('un refresh token vencido pide volver a conectar, en español', async () => {
    const { fetchImpl } = fakeIntuit(() => json(400, { error: 'invalid_grant' }));
    const err = await client(fetchImpl, {
      tokenStore: { load: async () => null, save: async () => undefined },
    })
      .page('Invoice', undefined, undefined, 1)
      .catch((e) => e);
    expect(err).toBeInstanceOf(QuickBooksError);
    expect((err as QuickBooksError).kind).toBe('credentials');
    expect((err as QuickBooksError).message).toContain('Vuelve a conectar');
  });

  it('un 429 espera lo que dice Retry-After y reintenta; si no cede, error en español', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const { fetchImpl } = fakeIntuit(() => {
      n += 1;
      return n === 1
        ? json(
            429,
            { Fault: { Error: [{ code: '003001' }], type: 'ThrottleExceeded' } },
            {
              'retry-after': '9',
            },
          )
        : json(200, { QueryResponse: { Item: [{ Id: '1' }] } });
    });
    const page = await client(fetchImpl, { sleep: async (ms) => void sleeps.push(ms) }).page(
      'Item',
      undefined,
      undefined,
      1,
    );
    expect(page.results).toHaveLength(1);
    expect(sleeps).toContain(9_000);

    const stuck = fakeIntuit(() => json(429, {}));
    const backoff: number[] = [];
    const err = await client(stuck.fetchImpl, {
      sleep: async (ms) => void backoff.push(ms),
      maxRetries: 3,
    })
      .page('Item', undefined, undefined, 1)
      .catch((e) => e);
    expect((err as QuickBooksError).kind).toBe('rate');
    expect(backoff).toEqual([5_000, 10_000, 20_000]);
  });
});

describe('de QuickBooks a la forma común', () => {
  // El ejemplo de factura de la referencia de la API (Invoice), resumido.
  const invoice = {
    Id: '130',
    DocNumber: '1037',
    TxnDate: '2026-09-20',
    DueDate: '2026-10-20',
    TotalAmt: 362.07,
    Balance: 362.07,
    CustomerRef: { value: '24', name: 'Sonnenschein Family Store' },
    CurrencyRef: { value: 'USD', name: 'United States Dollar' },
    CustomerMemo: { value: 'Thank you for your business and have a great day!' },
    MetaData: {
      CreateTime: '2026-09-20T14:42:05-07:00',
      LastUpdatedTime: '2026-09-20T14:42:05-07:00',
    },
  };

  it('una factura: número, cliente por nombre, saldo, vencimiento y moneda', () => {
    expect(normalizeQuickbooksInvoice(invoice)).toMatchObject({
      externalId: '130',
      number: '1037',
      date: '2026-09-20',
      dueDate: '2026-10-20',
      customerExternalId: '24',
      customerName: 'Sonnenschein Family Store',
      total: 362.07,
      balance: 362.07,
      currency: 'USD',
      status: 'open',
      notes: 'Thank you for your business and have a great day!',
    });
    expect(normalizeQuickbooksInvoice({ ...invoice, Balance: 0 })?.status).toBe('paid');
    expect(
      normalizeQuickbooksInvoice({ ...invoice, CurrencyRef: undefined }, 'CAD')?.currency,
    ).toBe('CAD');
    expect(
      normalizeQuickbooksInvoice({ ...invoice, TotalAmt: 0, Balance: 0, PrivateNote: 'Voided' })
        ?.status,
    ).toBe('annulled');
    expect(normalizeQuickbooksInvoice({ ...invoice, TxnDate: undefined })).toBeNull();
  });

  it('un pago (ejemplo de la referencia) abona por id de factura, con su número', () => {
    const payment = {
      Id: '163',
      TxnDate: '2026-09-25',
      TotalAmt: 65,
      UnappliedAmt: 10,
      CustomerRef: { value: '20', name: 'Red Rock Diner' },
      PaymentRefNum: '4377',
      PaymentMethodRef: { value: '1', name: 'Cash' },
      Line: [{ Amount: 55, LinkedTxn: [{ TxnId: '70', TxnType: 'Invoice' }] }],
    };
    expect(normalizeQuickbooksPayment(payment, new Map([['70', '1024']]))).toMatchObject({
      externalId: '163',
      number: '4377',
      amount: 65,
      kind: 'Abono a factura',
      method: 'Cash',
      customerName: 'Red Rock Diner',
      applications: [
        { ref: '163:0', invoiceNumber: '1024', amount: 55 },
        { ref: '163:sin-aplicar', invoiceNumber: null, amount: 10 },
      ],
    });
    expect(
      normalizeQuickbooksPayment({ ...payment, Line: [], UnappliedAmt: 0 }, new Map())
        ?.applications,
    ).toEqual([{ ref: '163', invoiceNumber: null, amount: 65 }]);
  });

  it('un cliente y un producto (ejemplos de la referencia)', () => {
    expect(
      normalizeQuickbooksCustomer({
        Id: '1',
        DisplayName: "Amy's Bird Sanctuary",
        CompanyName: "Amy's Bird Sanctuary",
        GivenName: 'Amy',
        FamilyName: 'Lauterbach',
        PrimaryEmailAddr: { Address: 'Birds@Intuit.com' },
        PrimaryPhone: { FreeFormNumber: '(650) 555-3311' },
        BillAddr: { Line1: '4581 Finch St.', City: 'Bayshore', CountrySubDivisionCode: 'CA' },
        Active: true,
        MetaData: { CreateTime: '2026-01-02T16:48:43-08:00' },
      }),
    ).toMatchObject({
      name: "Amy's Bird Sanctuary",
      kind: 'Empresa',
      city: 'Bayshore, CA',
      address: '4581 Finch St.',
      phone: '(650) 555-3311',
      email: 'Birds@Intuit.com',
      active: true,
      createdOn: '2026-01-02',
    });
    expect(
      normalizeQuickbooksItem({
        Id: '11',
        Name: 'Pump',
        Sku: 'P-461',
        Type: 'Inventory',
        UnitPrice: 15,
        QtyOnHand: 25,
        TrackQtyOnHand: true,
        Active: true,
        ParentRef: { value: '2', name: 'Fountains' },
      }),
    ).toMatchObject({
      name: 'Pump',
      code: 'P-461',
      kind: 'Producto',
      group: 'Fountains',
      price: 15,
      stock: 25,
    });
  });
});

describe('qué se le pide a QuickBooks', () => {
  const now = new Date('2026-10-01T12:00:00Z');

  it('la primera vez el último año; el repaso seis meses; lo incremental, lo cambiado', () => {
    expect(quickbooksQueries('invoices', { mode: 'initial', now })).toEqual([
      { where: "TxnDate >= '2025-10-01'", orderby: 'MetaData.CreateTime' },
    ]);
    expect(quickbooksQueries('invoices', { mode: 'sweep', now })[0]?.where).toBe(
      "TxnDate >= '2026-04-01'",
    );
    expect(quickbooksQueries('customers', { mode: 'initial', now })).toEqual([
      { orderby: 'MetaData.CreateTime' },
    ]);
    expect(
      quickbooksQueries('payments', {
        mode: 'incremental',
        since: '2026-10-01T11:50:00.123Z',
        now,
      }),
    ).toEqual([
      {
        where: "MetaData.LastUpdatedTime >= '2026-10-01T11:50:00Z'",
        orderby: 'MetaData.LastUpdatedTime',
      },
    ]);
  });

  it('los pagos nombran sus facturas: las vistas en la sesión, las demás con un IN', async () => {
    vi.stubEnv('QUICKBOOKS_CLIENT_ID', CONFIG.clientId);
    vi.stubEnv('QUICKBOOKS_CLIENT_SECRET', CONFIG.clientSecret);
    const asked: string[] = [];
    const { fetchImpl } = fakeIntuit((url) => {
      const q = sql(url);
      asked.push(q);
      if (q.startsWith('SELECT * FROM Invoice'))
        return json(200, {
          QueryResponse: {
            Invoice: [
              {
                Id: '70',
                DocNumber: '1024',
                TxnDate: '2026-09-01',
                TotalAmt: 55,
                Balance: 0,
                CurrencyRef: { value: 'USD' },
              },
            ],
          },
        });
      if (q.startsWith('SELECT Id, DocNumber FROM Invoice'))
        return json(200, { QueryResponse: { Invoice: [{ Id: '71', DocNumber: '1025' }] } });
      if (q.startsWith('SELECT * FROM Preferences'))
        return json(200, {
          QueryResponse: { Preferences: [{ CurrencyPrefs: { HomeCurrency: { value: 'USD' } } }] },
        });
      return json(200, {
        QueryResponse: {
          Payment: [
            {
              Id: 'p1',
              TxnDate: '2026-09-25',
              TotalAmt: 80,
              Line: [
                { Amount: 55, LinkedTxn: [{ TxnId: '70', TxnType: 'Invoice' }] },
                { Amount: 25, LinkedTxn: [{ TxnId: '71', TxnType: 'Invoice' }] },
              ],
            },
          ],
        },
      });
    });
    const session = quickbooksProvider.open(
      { realm_id: '123', refresh_token: 'r1', company_name: 'Empresa' },
      {
        fetch: fetchImpl,
        sleep: async () => undefined,
        now: () => NOW,
        minIntervalMs: 0,
        tokenStore: { load: async () => FRESH, save: async () => undefined },
      },
    );
    await session.listPage('invoices', { where: "TxnDate >= '2026-01-01'" }, 1);
    const page = await session.listPage('payments', {}, 1);
    expect(asked).toContain("SELECT Id, DocNumber FROM Invoice WHERE Id IN ('71') MAXRESULTS 1000");
    expect(
      (
        page.records[0] as { applications: Array<{ invoiceNumber: string | null }> }
      ).applications.map((a) => a.invoiceNumber),
    ).toEqual(['1024', '1025']);
    // El pago no trae moneda: se preguntó la de la empresa, una vez.
    expect(asked.filter((q) => q.includes('Preferences'))).toHaveLength(1);
  });

  it('las categorías de productos no son productos ni cuentan como ilegibles', async () => {
    vi.stubEnv('QUICKBOOKS_CLIENT_ID', CONFIG.clientId);
    vi.stubEnv('QUICKBOOKS_CLIENT_SECRET', CONFIG.clientSecret);
    const { fetchImpl } = fakeIntuit(() =>
      json(200, {
        QueryResponse: {
          Item: [
            { Id: '1', Name: 'Fountains', Type: 'Category' },
            { Id: '2', Name: 'Pump', Type: 'Inventory' },
          ],
        },
      }),
    );
    const session = quickbooksProvider.open(
      { realm_id: '123', refresh_token: 'r1', company_name: 'Empresa' },
      {
        fetch: fetchImpl,
        sleep: async () => undefined,
        now: () => NOW,
        minIntervalMs: 0,
        tokenStore: { load: async () => FRESH, save: async () => undefined },
      },
    );
    const page = await session.listPage('products', {}, 1);
    expect(page.records.map((r) => r.externalId)).toEqual(['2']);
    expect(page.skipped).toBe(0);
  });
});

describe('la vuelta de Intuit', () => {
  it('cambia el código, lee la empresa y deja la llave lista para guardar', async () => {
    const { fetchImpl, calls } = fakeIntuit((url) =>
      isToken(url)
        ? json(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 3600 })
        : json(200, {
            QueryResponse: { CompanyInfo: [{ CompanyName: 'Craig’s Design and Landscaping' }] },
          }),
    );
    const result = await completeQuickbooksConnection({
      code: 'codigo-1',
      realmId: '9130354889999',
      redirectUri: 'https://cortex.app/api/integrations/quickbooks/callback',
      fetch: fetchImpl,
      config: CONFIG,
    });
    expect(result.credentials).toEqual({
      realm_id: '9130354889999',
      refresh_token: 'r1',
      company_name: 'Craig’s Design and Landscaping',
    });
    expect(result.token.token).toBe('a1');
    expect(String(calls[0]?.init.body)).toContain('grant_type=authorization_code');
    expect(String(calls[0]?.init.body)).toContain('code=codigo-1');
  });

  it('sin app configurada o con una empresa que no es un id, no se conecta', async () => {
    await expect(
      completeQuickbooksConnection({ code: 'c', realmId: '1', redirectUri: 'x', config: null }),
    ).rejects.toMatchObject({ kind: 'setup' });
    await expect(
      completeQuickbooksConnection({
        code: 'c',
        realmId: "1' OR 1=1",
        redirectUri: 'x',
        config: CONFIG,
      }),
    ).rejects.toBeInstanceOf(QuickBooksError);
  });
});
