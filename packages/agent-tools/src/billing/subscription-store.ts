import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BILLING_SUBSCRIPTION_COLUMNS,
  type BillingAccess,
  type BillingSubscription,
  type BillingSubscriptionRow,
  billingAccess,
  toBillingSubscription,
} from './subscription';

/**
 * Lectura de `billing_subscriptions` (0187) por el manejador CON ALCANCE de una
 * empresa. La tabla es `tenant()`: el filtro lo pone el registro, no esta
 * función.
 *
 * Lanza si la lectura falla: quien llama decide. La puerta del medidor
 * (`checkMeter`) atrapa y deja pasar —un corte de la base no puede convertirse
 * en un bloqueo por cobro—, y /plan muestra el error en vez de inventar un
 * estado.
 */
export async function readBillingSubscription(
  db: SupabaseClient,
): Promise<BillingSubscription | null> {
  const { data, error } = await db
    .from('billing_subscriptions')
    .select(BILLING_SUBSCRIPTION_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`billing_subscriptions: ${error.message}`);
  return data ? toBillingSubscription(data as unknown as BillingSubscriptionRow) : null;
}

/** El acceso efectivo de la empresa, con la fila que lo explica. */
export async function readBillingAccess(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<{ subscription: BillingSubscription | null; access: BillingAccess }> {
  const subscription = await readBillingSubscription(db);
  return { subscription, access: billingAccess(subscription, now) };
}
