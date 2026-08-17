'use server';

/**
 * Lo que «Personas» sabe hacer con una invitación que todavía no acepta nadie.
 *
 * LA PUERTA SE VUELVE A COMPROBAR AQUÍ AUNQUE `admin/layout.tsx` YA LA COMPRUEBE.
 * El layout decide quién VE la pantalla; una acción de servidor es un endpoint
 * propio, con su URL, invocable sin haber pintado nunca la página. Es el mismo
 * criterio de `api/team/invite/route.ts` —`user.role !== 'org_admin'`— y por el
 * mismo motivo: la comprobación que vive sólo en la pantalla no es una
 * comprobación.
 *
 * EL ESPACIO NO VIAJA EN EL FORMULARIO. Lo pone `requireSession`, y el id de la
 * invitación es lo ÚNICO que llega de afuera. Así, lo peor que puede hacer
 * alguien manipulando la petición es nombrar una invitación que no es suya, y
 * `cancelInvitation` no la encuentra porque el espacio va en el WHERE.
 */

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { cancelInvitation } from '@/lib/team/invitations';
import { revalidatePath } from 'next/cache';

export interface CancelResult {
  ok: boolean;
  /** Qué decirle a quien pulsó, cuando no se pudo. */
  error?: string;
}

export async function cancelInvitationAction(invitationId: string): Promise<CancelResult> {
  const user = await requireSession();
  if (user.role !== 'org_admin') {
    return { ok: false, error: 'Solo quien administra el espacio puede cancelar invitaciones.' };
  }
  if (!invitationId) return { ok: false, error: 'Falta la invitación.' };

  const db = getOrgScopedClient(user.organization.id);
  const canceled = await cancelInvitation(db, user.organization.id, invitationId);
  if (!canceled) {
    // Ni «no existe» ni «es de otra empresa» ni «ya la aceptaron» se distinguen
    // a propósito: las tres se responden igual para no convertir esta acción en
    // una forma de averiguar qué invitaciones existen en otros espacios.
    return { ok: false, error: 'Esa invitación ya no está pendiente. Recarga la pantalla.' };
  }

  // El asiento vuelve a estar libre, y la cifra de asientos sale en las dos
  // pantallas: la de personas y la del plan.
  revalidatePath('/admin/users');
  revalidatePath('/plan');
  return { ok: true };
}
