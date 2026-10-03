import 'server-only';
import { logger } from '@cortex/core';
import { appBaseUrl } from '../email-templates/layout';
import { getOrgScopedClient } from '../supabase/service';
import { workspaceHref } from '../workspace-context';
import {
  type EventOutcome,
  applyPaymentEvent,
  attachCheckoutUrl,
  createPendingPayment,
  newPaymentReference,
  quotePlan,
} from './ledger';
import { wompiFromEnv } from './wompi';

/**
 * Del botón «Pagar» a la pasarela, y del regreso de la pasarela a /plan.
 *
 * Todo con el manejador CON ALCANCE de la empresa en sesión. El monto lo
 * calcula el servidor (precio por persona × asientos facturables, igual que la
 * cuenta del mes en /plan); el navegador sólo dice qué plan.
 */

/** Lo que se le dice a quien pulsa «Pagar» sin pasarela configurada. Nunca finge. */
export const CHECKOUT_UNAVAILABLE =
  'Pronto podrás pagar aquí; escríbenos y lo activamos contigo mientras tanto.';

export type CheckoutResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'not_configured' | 'not_purchasable' | 'failed'; message: string };

export function checkoutAvailable(): boolean {
  return wompiFromEnv().provider !== null;
}

export async function startCheckout(input: {
  organizationId: string;
  planCode: string;
  userId: string;
  email: string;
  name: string | null;
}): Promise<CheckoutResult> {
  const { provider, reason } = wompiFromEnv();
  if (!provider) {
    logger.info('billing: checkout sin pasarela', { reason });
    return { ok: false, reason: 'not_configured', message: CHECKOUT_UNAVAILABLE };
  }
  const db = getOrgScopedClient(input.organizationId);
  const quote = await quotePlan(db, input.planCode);
  if (!quote) {
    return {
      ok: false,
      reason: 'not_purchasable',
      message: 'Ese plan se activa en una conversación, no desde aquí. Escríbenos.',
    };
  }
  try {
    const reference = newPaymentReference();
    await createPendingPayment(db, {
      reference,
      quote,
      provider: 'wompi',
      createdBy: input.userId,
    });
    const back = workspaceHref(input.organizationId, `/plan?pago=${encodeURIComponent(reference)}`);
    const { url } = await provider.createCheckout({
      reference,
      amountCop: quote.amountCop,
      currency: 'COP',
      customerEmail: input.email,
      customerName: input.name,
      redirectUrl: `${appBaseUrl()}${back}`,
    });
    await attachCheckoutUrl(db, reference, url);
    return { ok: true, url };
  } catch (err) {
    logger.error('billing: no se pudo crear el checkout', {
      organizationId: input.organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      reason: 'failed',
      message: 'No se pudo abrir el pago. Inténtalo de nuevo en un momento.',
    };
  }
}

/**
 * El pagador vuelve con `?pago=<referencia>&id=<transacción>`. El aviso de
 * Wompi puede no haber llegado todavía (y en local no llega nunca), así que se
 * consulta la transacción y se aplica por el MISMO camino idempotente. Sólo si
 * la transacción dice la misma referencia que la URL, y la referencia es de
 * esta empresa (lo garantiza el manejador con alcance).
 */
export async function reconcileReturn(
  organizationId: string,
  reference: string,
  transactionId: string,
): Promise<EventOutcome | 'unverified'> {
  const { provider } = wompiFromEnv();
  if (!provider?.fetchTransaction) return 'unverified';
  try {
    const tx = await provider.fetchTransaction(transactionId);
    if (!tx || tx.reference !== reference) return 'unverified';
    return await applyPaymentEvent(getOrgScopedClient(organizationId), organizationId, tx, 'wompi');
  } catch (err) {
    logger.warn('billing: no se pudo consultar la transacción del regreso', {
      organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'unverified';
  }
}
