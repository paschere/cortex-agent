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

import { auth } from '@/lib/auth';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { cancelInvitation } from '@/lib/team/invitations';
import { memberIdForDirectoryUser, removeCompanyMember } from '@/lib/team/membership-admin';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

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

/**
 * Retirar a alguien de ESTE espacio.
 *
 * Lo único que llega de afuera es el id de su fila en el directorio. El puente a
 * `ba_member` se hace dentro de la empresa de la sesión
 * (`memberIdForDirectoryUser`), así que un id de otra empresa no encuentra a
 * nadie. Las reglas —último fundador, un admin no retira a un fundador,
 * espacio personal— son las de lib/founder-rules.ts, las mismas que usa la
 * consola del fundador.
 */
export async function removeMemberAction(directoryUserId: string): Promise<CancelResult> {
  const user = await requireSession();
  if (user.role !== 'org_admin') {
    return { ok: false, error: 'Solo quien administra el espacio puede retirar a alguien.' };
  }
  if (!directoryUserId) return { ok: false, error: 'Falta la persona.' };
  const requestHeaders = await headers();
  const accountId = (await auth.api.getSession({ headers: requestHeaders }))?.user?.id;
  if (!accountId) return { ok: false, error: 'Tu sesión venció. Vuelve a entrar.' };

  const memberId = await memberIdForDirectoryUser(user.organization.id, directoryUserId);
  if (!memberId) {
    return { ok: false, error: 'Esa persona ya no está en la empresa. Recarga la pantalla.' };
  }
  const result = await removeCompanyMember({
    organizationId: user.organization.id,
    workspaceKind: user.organization.kind ?? 'company',
    actorAccountId: accountId,
    actorRole: user.organization.role,
    memberId,
    requestHeaders,
  });
  if (!result.ok) return { ok: false, error: result.message };
  revalidatePath('/admin/users');
  revalidatePath('/plan');
  return { ok: true };
}
