import { describe, expect, it, vi } from 'vitest';
import { ProviderUncertainError, ProviderValidationError } from '../types';
import { AlegraClient } from './alegra-client';
import { alegraEinvoiceStatus, alegraInvoicing, sameTaxId, siigoInvoicing } from './invoicing';
import { SiigoClient, describeSiigoValidation } from './siigo-client';

/**
 * La mitad que ESCRIBE en Siigo y Alegra (0182), con `fetch` falso: qué
 * cabeceras salen, qué se reintenta y qué no, y cómo vuelve un rechazo.
 */

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function siigo(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url).endsWith('/auth')) return json(200, { access_token: 'tok', expires_in: 86400 });
    const next = responses.shift();
    if (!next) throw new Error('sin respuesta');
    if (next instanceof Error) throw next;
    return next;
  });
  const client = new SiigoClient({
    username: 'u',
    accessKey: 'k',
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async () => undefined,
    minIntervalMs: 0,
  });
  return { client, calls, fetch };
}

describe('Siigo: crear la factura', () => {
  it('manda la llave de idempotencia y devuelve número, CUFE y estado DIAN', async () => {
    const { client, calls } = siigo([
      json(201, {
        id: 'abc-123',
        name: 'FV-2-22',
        total: 1190,
        public_url: 'https://documentview.siigo.com/document?data=x',
        stamp: { status: 'Accepted', cufe: 'cufe-1' },
      }),
    ]);
    const out = await siigoInvoicing(client).createInvoice(
      { a: 1 },
      { idempotencyKey: 'CTX-abc_123' },
    );
    expect(out).toEqual({
      id: 'abc-123',
      number: 'FV-2-22',
      cufe: 'cufe-1',
      einvoiceStatus: 'Aceptada',
      url: 'https://documentview.siigo.com/document?data=x',
      total: 1190,
    });
    const post = calls.find((c) => c.url.endsWith('/v1/invoices'));
    const headers = post?.init.headers as Record<string, string>;
    expect(post?.init.method).toBe('POST');
    expect(headers['Idempotency-Key']).toBe('CTXabc123');
    expect(headers['Partner-Id']).toBeTruthy();
    expect(headers.Authorization).toBe('Bearer tok');
  });

  it('un 400 sale en español, nombrando qué arreglar', async () => {
    const { client } = siigo([
      json(400, {
        Status: 400,
        Errors: [
          {
            Code: 'invalid_reference',
            Message: 'The customer does not exist',
            Params: ['customer.identification'],
          },
          {
            Code: 'parameter_required',
            Message: 'The field code is required',
            Params: ['items.code'],
          },
        ],
      }),
    ]);
    const err = await siigoInvoicing(client)
      .createInvoice({}, { idempotencyKey: 'k' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderValidationError);
    expect((err as Error).message).toMatch(
      /^Siigo no aceptó la factura: el cliente no existe en Siigo/,
    );
    expect((err as Error).message).toMatch(/uno de los productos no existe/);
    expect((err as ProviderValidationError).details).toHaveLength(2);
  });

  it('una red cortada o un 5xx NO se reintenta: «no se sabe si quedó creada»', async () => {
    const cut = siigo([new TypeError('socket hang up')]);
    await expect(
      siigoInvoicing(cut.client).createInvoice({}, { idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(ProviderUncertainError);
    expect(cut.calls.filter((c) => c.url.endsWith('/v1/invoices'))).toHaveLength(1);
    const down = siigo([json(502, {})]);
    await expect(
      siigoInvoicing(down.client).createInvoice({}, { idempotencyKey: 'k' }),
    ).rejects.toThrow(/no se sabe si quedó creada/);
    expect(down.calls.filter((c) => c.url.endsWith('/v1/invoices'))).toHaveLength(1);
  });

  it('un 429 sí espera y repite (Siigo rechaza antes de procesar)', async () => {
    const { client, calls } = siigo([
      json(429, {}, { 'retry-after': '1' }),
      json(201, { id: 'x', name: 'FV-1' }),
    ]);
    const out = await siigoInvoicing(client).createInvoice({}, { idempotencyKey: 'k' });
    expect(out.number).toBe('FV-1');
    expect(calls.filter((c) => c.url.endsWith('/v1/invoices'))).toHaveLength(2);
  });

  it('el catálogo se traduce y el cliente se busca por NIT sin creerle al primero', async () => {
    const { client } = siigo([
      json(200, [
        {
          id: 24446,
          name: 'Factura electrónica',
          electronic_type: 'ElectronicInvoice',
          discount_type: 'Percentage',
          active: true,
        },
        { id: 1, name: 'Factura', electronic_type: 'NoElectronic', active: true },
      ]),
      json(200, { results: [{ id: 629, first_name: 'Ana', last_name: 'Ruiz', active: true }] }),
      json(200, [{ id: 5636, name: 'Crédito', due_date: true, active: true }]),
      json(200, [
        { id: 13156, name: 'IVA 19%', type: 'IVA', percentage: 19, active: true },
        { id: 2, name: 'Retefuente 4%', type: 'Retefuente', percentage: 4, active: true },
      ]),
      json(200, { results: [{ id: 'z', identification: '800000000', name: ['Otro'] }] }),
    ]);
    const inv = siigoInvoicing(client);
    const catalog = await inv.catalog();
    expect(catalog.documentTypes.map((d) => d.electronic)).toEqual([true, false]);
    expect(catalog.sellers).toEqual([{ id: '629', name: 'Ana Ruiz' }]);
    expect(catalog.paymentTypes[0]?.credit).toBe(true);
    expect(catalog.taxes.map((t) => t.kind)).toEqual(['iva', 'retefuente']);
    expect(await inv.findCustomer('900123456')).toBeNull();
  });
});

describe('Alegra: crear la factura', () => {
  function alegra(responses: Response[]) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new TypeError('sin red');
      return next;
    });
    const client = new AlegraClient({
      email: 'a@b.co',
      token: 't',
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: async () => undefined,
      minIntervalMs: 0,
    });
    return { client, calls };
  }

  it('devuelve el número completo y el estado DIAN', async () => {
    const { client, calls } = alegra([
      json(201, {
        id: 99,
        total: 1190,
        numberTemplate: { fullNumber: 'FE-99' },
        stamp: { cufe: 'c9', legalStatus: 'STAMPED_AND_ACCEPTED' },
      }),
    ]);
    const out = await alegraInvoicing(client).createInvoice({ x: 1 }, { idempotencyKey: 'k' });
    expect(out).toMatchObject({
      id: '99',
      number: 'FE-99',
      cufe: 'c9',
      einvoiceStatus: 'Aceptada',
    });
    expect(calls[0]?.url).toBe('https://api.alegra.com/api/v1/invoices');
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it('un rechazo trae el mensaje de Alegra y una pista', async () => {
    const { client } = alegra([json(400, { code: 3061, message: 'El ítem no existe' })]);
    await expect(
      alegraInvoicing(client).createInvoice({}, { idempotencyKey: 'k' }),
    ).rejects.toThrow(/Alegra no aceptó la factura: «El ítem no existe».*producto o servicio/);
  });

  it('sin red no se sabe si llegó y no se repite', async () => {
    const { client, calls } = alegra([]);
    await expect(
      alegraInvoicing(client).createInvoice({}, { idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(ProviderUncertainError);
    expect(calls).toHaveLength(1);
  });

  it('busca el cliente por NIT, con o sin dígito de verificación', async () => {
    const { client } = alegra([json(200, [{ id: 5, name: 'Nexa', identification: '9001234567' }])]);
    expect(await alegraInvoicing(client).findCustomer('900123456')).toEqual({
      id: '5',
      name: 'Nexa',
    });
  });
});

describe('ayudas', () => {
  it('compara NIT sin DV y traduce estados', () => {
    expect(sameTaxId('900.123.456-7', '900123456')).toBe(true);
    expect(sameTaxId('900123456', '900123456')).toBe(true);
    expect(sameTaxId('800123456', '900123456')).toBe(false);
    expect(alegraEinvoiceStatus('STAMPED_AND_WAITING_RESPONSE')).toBe('Pendiente');
    expect(describeSiigoValidation(null, 400).message).toMatch(/no dijo por qué/);
  });
});
