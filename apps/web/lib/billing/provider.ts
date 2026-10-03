/**
 * LA PASARELA, SIN CASARSE CON NINGUNA.
 *
 * Wompi es la primera porque es la que cobra en Colombia con PSE, tarjeta,
 * Nequi y Bancolombia. Pero Wompi, PayU, dLocal y Stripe no están de acuerdo ni
 * en qué es una «suscripción», así que el producto habla con esta interfaz y
 * nunca con un SDK: la referencia la pone Cortex, el monto lo calcula Cortex y
 * el estado lo decide `applyApprovedPayment` (agent-tools/billing/subscription).
 * La pasarela sólo cobra y avisa.
 *
 * Lo que tiene que saber hacer un adaptador:
 *   createCheckout  la URL a la que se manda al pagador, firmada.
 *   verifyWebhook   ¿el aviso viene de verdad de la pasarela? (firma)
 *   parseEvent      el aviso traducido a `PaymentEvent`.
 *   cancel          cortar lo recurrente del lado de la pasarela, si existe.
 *   fetchTransaction (opcional) consultar una transacción por id: el regreso del
 *                   pagador llega antes que el aviso, y en local el aviso nunca
 *                   llega.
 */

export type ProviderId = 'wompi';

/** Estados de un pago, ya en el vocabulario de `billing_payments.status`. */
export type ProviderPaymentStatus = 'pending' | 'approved' | 'declined' | 'voided' | 'error';

export interface CheckoutRequest {
  /** Única en toda la instalación; vuelve en el aviso. */
  reference: string;
  amountCop: number;
  currency: 'COP';
  customerEmail?: string | null;
  customerName?: string | null;
  /** A dónde vuelve el pagador. Wompi le agrega `?id=<transacción>`. */
  redirectUrl: string;
}

export interface CheckoutSession {
  url: string;
}

export interface PaymentEvent {
  /** Identidad del aviso para la idempotencia (único por pasarela). */
  eventId: string;
  type: string;
  reference: string;
  providerTxId: string;
  status: ProviderPaymentStatus;
  amountCents: number;
  currency: string;
  paymentMethod: string | null;
  /** 'test' | 'prod' en Wompi. */
  environment: string | null;
  /** Huella del cuerpo recibido, para `billing_payments.raw_event_hash`. */
  rawHash: string;
}

export interface PaymentProvider {
  readonly id: ProviderId;
  readonly environment: 'sandbox' | 'production';
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  verifyWebhook(rawBody: string, headers: Headers): boolean;
  parseEvent(rawBody: string): PaymentEvent | null;
  cancel(providerSubscriptionRef: string | null): Promise<{ remote: boolean }>;
  fetchTransaction?(transactionId: string): Promise<PaymentEvent | null>;
}
