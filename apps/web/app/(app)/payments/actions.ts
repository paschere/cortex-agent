'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { recordPaymentReport, resolvePaymentDispute } from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import type { ActionResult } from './_components/types';

/**
 * Lo que la pantalla de Pagos puede escribir, que es exactamente dos cosas:
 * anotar lo que una persona dice que entró, y cerrar una disputa.
 *
 * Ninguna de las dos calcula nada. Las dos delegan en las mismas funciones que
 * usan el chat y el importador —`recordPaymentReport` y `resolvePaymentDispute`—
 * porque una segunda ruta a estas tablas sería una segunda implementación de
 * las cinco reglas, y la lección de la 0064 es que la que se queda atrás no da
 * la cara: la lectura sigue funcionando y nadie se entera.
 */

const PATH = '/payments';

function describe(err: unknown, fallback: string): string {
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export async function recordPayment(input: {
  amount: number;
  currency: string;
  paidOn: string;
  kind: 'payment' | 'reversal' | 'adjustment';
  clientId: string | null;
  invoiceNumber: string | null;
  reference: string | null;
  note: string | null;
}): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    const result = await recordPaymentReport(db, {
      // La fuente es la persona que está en la sesión, y no un campo del
      // formulario: `source_user_id` tiene que ser quien lo escribió de verdad.
      source: { kind: 'manual', userId: user.id },
      amount: input.amount,
      currency: input.currency,
      paidOn: input.paidOn,
      kind: input.kind,
      clientId: input.clientId,
      invoiceNumber: input.invoiceNumber,
      reference: input.reference,
      note: input.note,
      createdBy: user.id,
    });
    revalidatePath(PATH);
    return { ok: true, note: result.note };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo registrar el pago.') };
  }
}

export async function resolveDispute(input: {
  paymentId: string;
  decision: 'settle' | 'discard';
  amount: number | null;
  currency: string | null;
  paidOn: string | null;
  note: string | null;
}): Promise<ActionResult> {
  const user = await requireSession();
  try {
    const db = getOrgScopedClient(user.organization.id);
    const payment = await resolvePaymentDispute(db, {
      paymentId: input.paymentId,
      // La autoridad que resuelve es esta persona, la de la sesión. No hay
      // forma de pasar otra desde el navegador.
      userId: user.id,
      decision: input.decision,
      amount: input.amount,
      currency: input.currency,
      paidOn: input.paidOn,
      note: input.note,
    });
    revalidatePath(PATH);
    return {
      ok: true,
      note:
        payment.state === 'discarded'
          ? 'Descartado bajo tu nombre. Lo que dijo cada fuente sigue guardado tal cual llegó.'
          : 'Resuelto bajo tu nombre. Vuelve a contar en la cartera con el importe que confirmaste.',
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo resolver la disputa.') };
  }
}
