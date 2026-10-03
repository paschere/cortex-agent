import 'server-only';
import { logger } from '@cortex/core';
import { getOrgScopedClient, getSupabaseServiceClient } from '../supabase/service';
import { type EventOutcome, applyPaymentEvent } from './ledger';
import type { PaymentEvent } from './provider';

/**
 * El aviso de la pasarela llega SIN SESIÓN y sin empresa: lo único que trae es
 * la referencia que Cortex firmó al crear el checkout. Esta es la única lectura
 * sin alcance del cobro —«¿de qué empresa es esta referencia?»— y por eso vive
 * sola en este archivo, que está en la lista de tenancy-guard.test.ts. Todo lo
 * demás va por `getOrgScopedClient(empresa)`.
 *
 * Se llama sólo DESPUÉS de verificar la firma: una referencia inventada no
 * llega aquí.
 */
export async function organizationForReference(reference: string): Promise<string | null> {
  const { data, error } = await getSupabaseServiceClient()
    .from('billing_payments')
    .select('organization_id')
    .eq('reference', reference)
    .maybeSingle();
  if (error) throw new Error(`billing_payments: ${error.message}`);
  return (data as { organization_id?: string } | null)?.organization_id ?? null;
}

/** Aplica un aviso ya verificado a la empresa dueña de su referencia. */
export async function applyVerifiedEvent(
  event: PaymentEvent,
  provider: 'wompi',
): Promise<EventOutcome> {
  const organizationId = await organizationForReference(event.reference);
  if (!organizationId) {
    // Puede ser un pago de otra cosa en la misma cuenta de Wompi. Se responde
    // 200 igual: reintentar no lo va a volver nuestro.
    logger.warn('billing: aviso con referencia desconocida', {
      provider,
      reference: event.reference,
    });
    return 'unknown_reference';
  }
  const outcome = await applyPaymentEvent(
    getOrgScopedClient(organizationId),
    organizationId,
    event,
    provider,
  );
  logger.info('billing: aviso aplicado', {
    provider,
    organizationId,
    reference: event.reference,
    status: event.status,
    outcome,
  });
  return outcome;
}
