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
import {
  changeMemberRole,
  memberIdForDirectoryUser,
  removeCompanyMember,
} from '@/lib/team/membership-admin';
import { setManager } from '@cortex/agent-tools';
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

/** Los roles del directorio que se pueden poner desde aquí (nunca `owner`: ver founder-actions.ts). */
const ASSIGNABLE_ROLES = ['member', 'team_admin', 'org_admin'] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/**
 * El rol y el jefe de una persona, en UN guardado.
 *
 * Son las dos cosas que definen la posición de alguien aquí dentro; separarlas
 * en dos botones hace que uno se pulse por error y el otro se olvide. El
 * cuerpo es el que antes vivía dentro de `page.tsx`, movido aquí para que lo
 * llame el menú de cada fila (un componente de cliente no puede importar una
 * acción definida dentro de una página).
 *
 * EL ROL ANTES NO DURABA. Escribir sólo `public.users.role` se deshacía en la
 * siguiente petición, porque `resolveSessionDirectory` lo recalcula desde
 * `ba_member.role`. Ahora pasa por `changeMemberRole`, que cambia primero la
 * membresía con better-auth y después el directorio, con las reglas de
 * lib/founder-rules.ts. El jefe sigue por `setManager`, el único sitio que
 * escribe `users.manager_id` y que comprueba que la línea no se muerde la cola.
 *
 * `role: null` guarda sólo el jefe (filas de fundadores, la propia y las de
 * quien ya no tiene acceso no cambian de rol aquí).
 */
export async function setUserPositionAction(input: {
  userId: string;
  role: string | null;
  managerId: string | null;
}): Promise<CancelResult> {
  const user = await requireSession();
  if (user.role !== 'org_admin') {
    return { ok: false, error: 'Solo quien administra el espacio puede cambiar roles.' };
  }
  if (!input.userId) return { ok: false, error: 'Falta la persona.' };
  const role = ASSIGNABLE_ROLES.find((candidate) => candidate === input.role) ?? null;
  const sb = getOrgScopedClient(user.organization.id);
  try {
    if (role) {
      const { data: current, error } = await sb
        .from('users')
        .select('role')
        .eq('id', input.userId)
        .maybeSingle();
      if (error) return { ok: false, error: 'No se pudo leer a esa persona. Inténtalo de nuevo.' };
      if (!current) return { ok: false, error: 'Esa persona no es de este espacio.' };
      if ((current as { role: AssignableRole }).role !== role) {
        const requestHeaders = await headers();
        const accountId = (await auth.api.getSession({ headers: requestHeaders }))?.user?.id;
        const memberId = await memberIdForDirectoryUser(user.organization.id, input.userId);
        if (!accountId || !memberId) {
          return { ok: false, error: 'Esa persona ya no está en la empresa.' };
        }
        const result = await changeMemberRole({
          organizationId: user.organization.id,
          workspaceKind: user.organization.kind ?? 'company',
          actorAccountId: accountId,
          actorRole: user.organization.role,
          memberId,
          next: role,
          requestHeaders,
        });
        if (!result.ok && result.reason !== 'unchanged')
          return { ok: false, error: result.message };
      }
    }
    await setManager(sb, { userId: input.userId, managerId: input.managerId || null });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error && err.message.length < 200 ? err.message : 'No se pudo guardar.',
    };
  }
  revalidatePath('/admin/users');
  revalidatePath('/company');
  return { ok: true };
}
