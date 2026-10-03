import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  CheckoutRequest,
  CheckoutSession,
  PaymentEvent,
  PaymentProvider,
  ProviderPaymentStatus,
} from './provider';

/**
 * EL ADAPTADOR DE WOMPI (Colombia: PSE, tarjeta, Nequi, Bancolombia).
 *
 * Verificado contra docs.wompi.co el 2026-10-03:
 *
 *   WEB CHECKOUT   GET https://checkout.wompi.co/p/ con public-key, currency,
 *                  amount-in-cents, reference, signature:integrity y, opcional,
 *                  redirect-url y customer-data:*. La misma URL sirve para
 *                  sandbox y producción: el ambiente lo da la llave.
 *   INTEGRIDAD     SHA256 de `<referencia><monto en centavos><moneda><secreto>`
 *                  (con `expiration-time` va entre la moneda y el secreto). El
 *                  ejemplo de la documentación reproduce exactamente; está en
 *                  wompi.test.ts.
 *   EVENTOS        `signature.properties` nombra campos de `data` (p. ej.
 *                  transaction.id, transaction.status,
 *                  transaction.amount_in_cents). Se concatenan sus valores en
 *                  ese orden, luego `timestamp`, luego el secreto de eventos, y
 *                  SHA256. Viene en `signature.checksum` y en la cabecera
 *                  `X-Event-Checksum`. Sin 200, Wompi reintenta a los 30 min,
 *                  3 h y 24 h.
 *   AMBIENTES      sandbox https://sandbox.wompi.co/v1 con pub_test_, prv_test_,
 *                  test_events_, test_integrity_; producción
 *                  https://production.wompi.co/v1 con pub_prod_, prv_prod_,
 *                  prod_events_, prod_integrity_. Mezclarlas no funciona, así
 *                  que `wompiConfigFrom` las rechaza mezcladas.
 *   RECURRENCIA    Wompi NO tiene suscripciones nativas. Se puede tokenizar una
 *                  tarjeta o Nequi (POST /v1/payment_sources con
 *                  acceptance_token) y cobrar con `payment_source_id` y
 *                  `recurrent: true`. Eso NO está cableado todavía: hoy cada
 *                  período es un pago nuevo con su enlace, y el barrido diario
 *                  manda el recordatorio (lib/billing/renewals.ts). La columna
 *                  `provider_payment_source_ref` espera ese día.
 */

export interface WompiConfig {
  environment: 'sandbox' | 'production';
  publicKey: string;
  privateKey: string;
  integritySecret: string;
  eventsSecret: string;
}

type Env = Record<string, string | undefined>;

export const WOMPI_CHECKOUT_URL = 'https://checkout.wompi.co/p/';
export const WOMPI_API = {
  sandbox: 'https://sandbox.wompi.co/v1',
  production: 'https://production.wompi.co/v1',
} as const;

const PREFIX = {
  sandbox: {
    pub: 'pub_test_',
    prv: 'prv_test_',
    events: 'test_events_',
    integrity: 'test_integrity_',
  },
  production: {
    pub: 'pub_prod_',
    prv: 'prv_prod_',
    events: 'prod_events_',
    integrity: 'prod_integrity_',
  },
} as const;

/**
 * Las llaves, o por qué no se puede cobrar. Nunca a medias: con una llave
 * faltante o de otro ambiente, el checkout dice «pronto» en vez de mandar a
 * alguien a una pasarela que le va a fallar.
 */
export function wompiConfigFrom(
  env: Env = process.env,
): { ok: true; config: WompiConfig } | { ok: false; reason: string } {
  const environment = (env.WOMPI_ENV ?? 'sandbox').trim().toLowerCase();
  if (environment !== 'sandbox' && environment !== 'production') {
    return { ok: false, reason: `WOMPI_ENV debe ser sandbox o production, no «${environment}».` };
  }
  const publicKey = (env.WOMPI_PUBLIC_KEY ?? '').trim();
  const privateKey = (env.WOMPI_PRIVATE_KEY ?? '').trim();
  const integritySecret = (env.WOMPI_INTEGRITY_SECRET ?? '').trim();
  const eventsSecret = (env.WOMPI_EVENTS_SECRET ?? '').trim();
  const missing = [
    ['WOMPI_PUBLIC_KEY', publicKey],
    ['WOMPI_PRIVATE_KEY', privateKey],
    ['WOMPI_INTEGRITY_SECRET', integritySecret],
    ['WOMPI_EVENTS_SECRET', eventsSecret],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) return { ok: false, reason: `Faltan llaves: ${missing.join(', ')}.` };

  const expected = PREFIX[environment];
  const mismatched = [
    ['WOMPI_PUBLIC_KEY', publicKey, expected.pub],
    ['WOMPI_PRIVATE_KEY', privateKey, expected.prv],
    ['WOMPI_INTEGRITY_SECRET', integritySecret, expected.integrity],
    ['WOMPI_EVENTS_SECRET', eventsSecret, expected.events],
  ]
    .filter(([, value, prefix]) => !(value as string).startsWith(prefix as string))
    .map(([name]) => name);
  if (mismatched.length > 0) {
    return {
      ok: false,
      reason: `Llaves de otro ambiente para WOMPI_ENV=${environment}: ${mismatched.join(', ')}.`,
    };
  }
  return {
    ok: true,
    config: { environment, publicKey, privateKey, integritySecret, eventsSecret },
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Pesos enteros → centavos, como los pide Wompi. */
export function copToCents(amountCop: number): number {
  return Math.round(amountCop) * 100;
}

/** La firma de integridad del checkout. Se calcula SIEMPRE en el servidor. */
export function integritySignature(input: {
  reference: string;
  amountInCents: number;
  currency: string;
  integritySecret: string;
  expirationTime?: string | null;
}): string {
  return sha256(
    `${input.reference}${input.amountInCents}${input.currency}${input.expirationTime ?? ''}${input.integritySecret}`,
  );
}

/** Lee `transaction.id` dentro de `data`. */
function pick(data: unknown, path: string): unknown {
  let cursor: unknown = data;
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** El checksum que DEBERÍA traer un evento, según la documentación. */
export function eventChecksum(
  event: { data?: unknown; signature?: { properties?: unknown }; timestamp?: unknown },
  eventsSecret: string,
): string | null {
  const properties = event.signature?.properties;
  if (!Array.isArray(properties) || properties.length === 0) return null;
  if (typeof event.timestamp !== 'number' && typeof event.timestamp !== 'string') return null;
  let concatenated = '';
  for (const property of properties) {
    if (typeof property !== 'string') return null;
    const value = pick(event.data, property);
    if (value === undefined || value === null) return null;
    concatenated += String(value);
  }
  return sha256(`${concatenated}${event.timestamp}${eventsSecret}`);
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a.toLowerCase(), 'utf8');
  const right = Buffer.from(b.toLowerCase(), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** ¿Este cuerpo lo firmó Wompi con nuestro secreto de eventos? */
export function verifyWompiEvent(rawBody: string, headers: Headers, eventsSecret: string): boolean {
  let parsed: {
    data?: unknown;
    signature?: { properties?: unknown; checksum?: unknown };
    timestamp?: unknown;
  };
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const expected = eventChecksum(parsed, eventsSecret);
  if (!expected) return false;
  const given =
    (typeof parsed.signature?.checksum === 'string' && parsed.signature.checksum
      ? parsed.signature.checksum
      : null) ?? headers.get('x-event-checksum');
  if (!given) return false;
  if (!sameHex(expected, given)) return false;
  // Si viene la cabecera, tiene que decir lo mismo que el cuerpo.
  const header = headers.get('x-event-checksum');
  return header ? sameHex(expected, header) : true;
}

const STATUS: Record<string, ProviderPaymentStatus> = {
  APPROVED: 'approved',
  DECLINED: 'declined',
  VOIDED: 'voided',
  ERROR: 'error',
  PENDING: 'pending',
};

interface WompiTransaction {
  id?: unknown;
  reference?: unknown;
  status?: unknown;
  amount_in_cents?: unknown;
  currency?: unknown;
  payment_method_type?: unknown;
}

function fromTransaction(
  tx: WompiTransaction,
  meta: { eventId: string; type: string; environment: string | null; rawHash: string },
): PaymentEvent | null {
  if (typeof tx.id !== 'string' || typeof tx.reference !== 'string') return null;
  const status = STATUS[String(tx.status ?? '').toUpperCase()];
  if (!status) return null;
  const amount = Number(tx.amount_in_cents);
  if (!Number.isFinite(amount)) return null;
  return {
    eventId: meta.eventId,
    type: meta.type,
    reference: tx.reference,
    providerTxId: tx.id,
    status,
    amountCents: amount,
    currency: typeof tx.currency === 'string' ? tx.currency : '',
    paymentMethod: typeof tx.payment_method_type === 'string' ? tx.payment_method_type : null,
    environment: meta.environment,
    rawHash: meta.rawHash,
  };
}

/**
 * El aviso traducido. Sólo `transaction.updated`: es el único que mueve un
 * pago. La identidad del aviso es su checksum — Wompi no manda un id de evento,
 * y el checksum ya es único por (transacción, estado, monto, timestamp).
 */
export function parseWompiEvent(rawBody: string): PaymentEvent | null {
  let parsed: {
    event?: unknown;
    data?: { transaction?: WompiTransaction };
    environment?: unknown;
    signature?: { checksum?: unknown };
  };
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (parsed.event !== 'transaction.updated') return null;
  const tx = parsed.data?.transaction;
  const checksum =
    typeof parsed.signature?.checksum === 'string' ? parsed.signature.checksum : null;
  if (!tx || !checksum) return null;
  return fromTransaction(tx, {
    eventId: `event:${checksum.toLowerCase()}`,
    type: 'transaction.updated',
    environment: typeof parsed.environment === 'string' ? parsed.environment : null,
    rawHash: sha256(rawBody),
  });
}

export function createWompiProvider(
  config: WompiConfig,
  fetcher: typeof fetch = fetch,
): PaymentProvider {
  return {
    id: 'wompi',
    environment: config.environment,

    async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
      const amountInCents = copToCents(request.amountCop);
      const params = new URLSearchParams();
      params.set('public-key', config.publicKey);
      params.set('currency', request.currency);
      params.set('amount-in-cents', String(amountInCents));
      params.set('reference', request.reference);
      params.set(
        'signature:integrity',
        integritySignature({
          reference: request.reference,
          amountInCents,
          currency: request.currency,
          integritySecret: config.integritySecret,
        }),
      );
      params.set('redirect-url', request.redirectUrl);
      if (request.customerEmail) params.set('customer-data:email', request.customerEmail);
      if (request.customerName) params.set('customer-data:full-name', request.customerName);
      return { url: `${WOMPI_CHECKOUT_URL}?${params.toString()}` };
    },

    verifyWebhook(rawBody: string, headers: Headers): boolean {
      return verifyWompiEvent(rawBody, headers, config.eventsSecret);
    },

    parseEvent(rawBody: string): PaymentEvent | null {
      const event = parseWompiEvent(rawBody);
      if (!event) return null;
      // Un aviso de sandbox nunca mueve una instalación de producción, ni al revés.
      const expected = config.environment === 'production' ? 'prod' : 'test';
      if (event.environment && event.environment !== expected) return null;
      return event;
    },

    async cancel(): Promise<{ remote: boolean }> {
      // Sin suscripción nativa no hay nada que cancelar del lado de Wompi: el
      // próximo período simplemente no se cobra.
      return { remote: false };
    },

    async fetchTransaction(transactionId: string): Promise<PaymentEvent | null> {
      if (!/^[\w-]{4,80}$/.test(transactionId)) return null;
      const res = await fetcher(
        `${WOMPI_API[config.environment]}/transactions/${encodeURIComponent(transactionId)}`,
        { headers: { Authorization: `Bearer ${config.publicKey}` }, cache: 'no-store' },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: WompiTransaction };
      if (!body.data) return null;
      const status = String(body.data.status ?? '').toUpperCase();
      return fromTransaction(body.data, {
        // Consultar la misma transacción en el mismo estado es el mismo hecho.
        eventId: `tx:${String(body.data.id)}:${status}`,
        type: 'transaction.lookup',
        environment: null,
        rawHash: sha256(JSON.stringify(body.data)),
      });
    },
  };
}

/** La pasarela configurada, o null con el motivo. */
export function wompiFromEnv(
  env: Env = process.env,
): { provider: PaymentProvider; reason: null } | { provider: null; reason: string } {
  const config = wompiConfigFrom(env);
  if (!config.ok) return { provider: null, reason: config.reason };
  return { provider: createWompiProvider(config.config), reason: null };
}
