import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  copToCents,
  createWompiProvider,
  eventChecksum,
  integritySignature,
  parseWompiEvent,
  verifyWompiEvent,
  wompiConfigFrom,
} from './wompi';

/**
 * Las firmas contra los ejemplos de docs.wompi.co.
 *
 * INTEGRIDAD: el ejemplo de la documentación reproduce exacto (referencia
 * «sk8-438k4-xmxm392-sn2m», 2490000 centavos, COP, secreto de producción de
 * ejemplo → 37c8407747e5…). Si esta prueba falla, se rompió la fórmula.
 *
 * EVENTOS: la documentación muestra la cadena paso a paso
 * («1234-1610641025-49201APPROVED44900001530291411prod_events_…») pero el hash
 * que imprime (3476DDA5…) NO es el SHA256 de esa cadena — se comprobó con
 * `shasum -a 256` el 2026-10-03 y da 5a18ec5e…. La CADENA sí es la de la
 * documentación, y es lo que se prueba aquí: que armamos exactamente esa cadena,
 * y que el hash es el SHA256 de ella.
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const DOC_EVENT = {
  event: 'transaction.updated',
  data: {
    transaction: {
      id: '1234-1610641025-49201',
      amount_in_cents: 4490000,
      reference: 'MZQ3X2DE2SMX',
      customer_email: 'juan.perez@gmail.com',
      currency: 'COP',
      payment_method_type: 'NEQUI',
      redirect_url: 'https://mitienda.com.co/pagos/redireccion',
      status: 'APPROVED',
      shipping_address: null,
      payment_link_id: null,
      payment_source_id: null,
    },
  },
  environment: 'prod',
  signature: {
    properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
    checksum: '',
  },
  timestamp: 1530291411,
  sent_at: '2018-07-20T16:45:05.000Z',
};
const DOC_EVENTS_SECRET = 'prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z';
const DOC_CHAIN = `1234-1610641025-49201APPROVED44900001530291411${DOC_EVENTS_SECRET}`;

function signedDocEvent(secret = DOC_EVENTS_SECRET) {
  const event = structuredClone(DOC_EVENT);
  event.signature.checksum = (eventChecksum(event, secret) ?? '').toUpperCase();
  return event;
}

describe('firma de integridad del checkout', () => {
  it('reproduce el ejemplo de la documentación', () => {
    expect(
      integritySignature({
        reference: 'sk8-438k4-xmxm392-sn2m',
        amountInCents: 2490000,
        currency: 'COP',
        integritySecret: 'prod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6',
      }),
    ).toBe('37c8407747e595535433ef8f6a811d853cd943046624a0ec04662b17bbf33bf5');
  });

  it('con expiration-time la fecha va entre la moneda y el secreto', () => {
    expect(
      integritySignature({
        reference: 'R1',
        amountInCents: 100,
        currency: 'COP',
        integritySecret: 'S',
        expirationTime: '2026-10-04T00:00:00.000Z',
      }),
    ).toBe(sha('R1100COP2026-10-04T00:00:00.000ZS'));
  });

  it('pesos enteros a centavos', () => {
    expect(copToCents(150000)).toBe(15000000);
  });
});

describe('checksum de eventos', () => {
  it('arma exactamente la cadena de la documentación y la hashea con SHA256', () => {
    expect(eventChecksum(DOC_EVENT, DOC_EVENTS_SECRET)).toBe(sha(DOC_CHAIN));
  });

  it('acepta el evento firmado, en mayúsculas o minúsculas, por cuerpo o cabecera', () => {
    const body = JSON.stringify(signedDocEvent());
    expect(verifyWompiEvent(body, new Headers(), DOC_EVENTS_SECRET)).toBe(true);
    const lower = signedDocEvent();
    const checksum = lower.signature.checksum.toLowerCase();
    lower.signature.checksum = '';
    expect(
      verifyWompiEvent(
        JSON.stringify(lower),
        new Headers({ 'X-Event-Checksum': checksum }),
        DOC_EVENTS_SECRET,
      ),
    ).toBe(true);
  });

  it('rechaza un monto alterado, otro secreto, cabecera distinta o cuerpo roto', () => {
    const tampered = signedDocEvent();
    tampered.data.transaction.amount_in_cents = 100;
    expect(verifyWompiEvent(JSON.stringify(tampered), new Headers(), DOC_EVENTS_SECRET)).toBe(
      false,
    );
    expect(
      verifyWompiEvent(JSON.stringify(signedDocEvent()), new Headers(), 'prod_events_otro'),
    ).toBe(false);
    expect(
      verifyWompiEvent(
        JSON.stringify(signedDocEvent()),
        new Headers({ 'X-Event-Checksum': 'a'.repeat(64) }),
        DOC_EVENTS_SECRET,
      ),
    ).toBe(false);
    expect(verifyWompiEvent('{no es json', new Headers(), DOC_EVENTS_SECRET)).toBe(false);
    const unsigned = structuredClone(DOC_EVENT);
    expect(verifyWompiEvent(JSON.stringify(unsigned), new Headers(), DOC_EVENTS_SECRET)).toBe(
      false,
    );
  });

  it('traduce el evento con un id estable para la idempotencia', () => {
    const body = JSON.stringify(signedDocEvent());
    const a = parseWompiEvent(body);
    const b = parseWompiEvent(body);
    expect(a).toMatchObject({
      reference: 'MZQ3X2DE2SMX',
      providerTxId: '1234-1610641025-49201',
      status: 'approved',
      amountCents: 4490000,
      currency: 'COP',
      paymentMethod: 'NEQUI',
      environment: 'prod',
    });
    expect(a?.eventId).toBe(b?.eventId);
    expect(
      parseWompiEvent(JSON.stringify({ ...DOC_EVENT, event: 'nequi_token.updated' })),
    ).toBeNull();
  });
});

describe('configuración', () => {
  const sandbox = {
    WOMPI_ENV: 'sandbox',
    WOMPI_PUBLIC_KEY: 'pub_test_abc',
    WOMPI_PRIVATE_KEY: 'prv_test_abc',
    WOMPI_INTEGRITY_SECRET: 'test_integrity_abc',
    WOMPI_EVENTS_SECRET: 'test_events_abc',
  };

  it('sin llaves no hay pasarela, y dice cuáles faltan', () => {
    const result = wompiConfigFrom({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('WOMPI_PUBLIC_KEY');
  });

  it('rechaza llaves de sandbox con WOMPI_ENV=production', () => {
    const result = wompiConfigFrom({ ...sandbox, WOMPI_ENV: 'production' });
    expect(result.ok).toBe(false);
  });

  it('arma la URL del checkout firmada', async () => {
    const config = wompiConfigFrom(sandbox);
    if (!config.ok) throw new Error(config.reason);
    const provider = createWompiProvider(config.config);
    const { url } = await provider.createCheckout({
      reference: 'CTX-REF-1',
      amountCop: 150000,
      currency: 'COP',
      customerEmail: 'ana@acme.co',
      redirectUrl: 'https://cortex.test/plan?pago=CTX-REF-1',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://checkout.wompi.co/p/');
    expect(parsed.searchParams.get('amount-in-cents')).toBe('15000000');
    expect(parsed.searchParams.get('signature:integrity')).toBe(
      sha('CTX-REF-115000000COPtest_integrity_abc'),
    );
    expect(parsed.searchParams.get('customer-data:email')).toBe('ana@acme.co');
    // El secreto nunca sale en la URL.
    expect(url).not.toContain('test_integrity_abc');
    expect(url).not.toContain('prv_test');
  });

  it('un aviso de producción no mueve una instalación de sandbox', () => {
    const config = wompiConfigFrom(sandbox);
    if (!config.ok) throw new Error(config.reason);
    const provider = createWompiProvider(config.config);
    const event = signedDocEvent('test_events_abc');
    expect(provider.verifyWebhook(JSON.stringify(event), new Headers())).toBe(true);
    expect(provider.parseEvent(JSON.stringify(event))).toBeNull();
    expect(provider.parseEvent(JSON.stringify({ ...event, environment: 'test' }))).not.toBeNull();
  });

  it('consulta la transacción del regreso con un id estable por estado', async () => {
    const config = wompiConfigFrom(sandbox);
    if (!config.ok) throw new Error(config.reason);
    const calls: string[] = [];
    const provider = createWompiProvider(config.config, (async (url: string) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          data: {
            id: '11-22-33',
            reference: 'CTX-REF-1',
            status: 'APPROVED',
            amount_in_cents: 15000000,
            currency: 'COP',
            payment_method_type: 'PSE',
          },
        }),
      );
    }) as unknown as typeof fetch);
    const tx = await provider.fetchTransaction?.('11-22-33');
    expect(calls[0]).toBe('https://sandbox.wompi.co/v1/transactions/11-22-33');
    expect(tx).toMatchObject({ status: 'approved', eventId: 'tx:11-22-33:APPROVED' });
    expect(await provider.fetchTransaction?.('../etc')).toBeNull();
  });
});
