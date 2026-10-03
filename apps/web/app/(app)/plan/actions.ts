'use server';

/**
 * Pagar, cancelar y reanudar el plan desde /plan.
 *
 * Cada acción vuelve a leer la sesión y exige que quien la pide administre el
 * espacio (`org_admin`): ver la cuenta es de todo el equipo, comprometer la
 * tarjeta de la empresa no. El monto nunca viene del navegador.
 */

import { type CheckoutResult, startCheckout } from '@/lib/billing/checkout';
import { cancelBilling, resumeBilling } from '@/lib/billing/ledger';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { revalidatePath } from 'next/cache';

export interface PlanActionResult {
  ok: boolean;
  message: string;
}

const ADMIN_ONLY = 'Sólo quien administra el espacio puede cambiar el pago del plan.';

export async function checkoutPlan(planCode: string): Promise<CheckoutResult> {
  const user = await requireSession();
  if (user.role !== 'org_admin') {
    return { ok: false, reason: 'failed', message: ADMIN_ONLY };
  }
  if (typeof planCode !== 'string' || !/^[a-z0-9_-]{2,40}$/.test(planCode)) {
    return { ok: false, reason: 'not_purchasable', message: 'Ese plan no existe.' };
  }
  return startCheckout({
    organizationId: user.organization.id,
    planCode,
    userId: user.id,
    email: user.email,
    name: user.name,
  });
}

export async function cancelPlan(): Promise<PlanActionResult> {
  const user = await requireSession();
  if (user.role !== 'org_admin') return { ok: false, message: ADMIN_ONLY };
  const next = await cancelBilling(getOrgScopedClient(user.organization.id));
  revalidatePath('/plan');
  return next
    ? {
        ok: true,
        message:
          'Cancelado. Todo sigue funcionando hasta el final de lo pagado; después el espacio queda en solo lectura, con todos los datos.',
      }
    : { ok: false, message: 'Este espacio no tiene un pago activo que cancelar.' };
}

export async function resumePlan(): Promise<PlanActionResult> {
  const user = await requireSession();
  if (user.role !== 'org_admin') return { ok: false, message: ADMIN_ONLY };
  const next = await resumeBilling(getOrgScopedClient(user.organization.id));
  revalidatePath('/plan');
  return next
    ? { ok: true, message: 'Listo: el plan sigue.' }
    : { ok: false, message: 'No hay nada que reanudar.' };
}
