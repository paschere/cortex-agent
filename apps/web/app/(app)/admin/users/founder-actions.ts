'use server';

/**
 * Los movimientos de propiedad de la empresa, como acciones de servidor.
 *
 * Una acción de servidor tiene URL propia: se puede invocar sin haber pintado
 * nunca la pantalla, así que NADA de lo que decide el permiso llega del
 * navegador. De afuera sólo vienen: a quién (el id de su fila del directorio),
 * lo que escribió en la confirmación y la prueba de identidad (contraseña o
 * código). Todo lo demás —el espacio, el rol de quien actúa, a qué factor le
 * toca, cuántos fundadores hay— se lee aquí o en `lib/team/*` en esta llamada.
 *
 * Orden de las puertas, de la más barata a la más cara:
 *   1. Sesión y espacio (requireSession).
 *   2. Confirmación escrita (nombre de la persona, su correo o el de la
 *      empresa): frena el clic distraído, no al atacante.
 *   3. Re-autenticación (lib/team/step-up.ts): frena a quien tiene una sesión
 *      que no es suya. Se pide para todo movimiento de un fundador.
 *   4. Reglas y escritura (lib/team/founder-admin.ts), que además deja la
 *      auditoría y avisa a los demás fundadores.
 *
 * `leave` es la excepción de la puerta 3: cualquier miembro puede irse sin
 * re-autenticar (no hay nada que robar saliendo uno mismo); un fundador sí,
 * porque su salida cambia quién manda.
 */

import { auth } from '@/lib/auth';
import { confirmationMatches, normalizeMembershipRole } from '@/lib/founder-rules';
import { requireSession } from '@/lib/session';
import {
  type FounderScope,
  leaveCompany,
  promoteToOwner,
  stepDownAsOwner,
  transferOwnership,
} from '@/lib/team/founder-admin';
import { listCompanyMembers, memberIdForDirectoryUser } from '@/lib/team/membership-admin';
import { verifyStepUp } from '@/lib/team/step-up';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

export interface FounderActionResult {
  ok: boolean;
  message?: string;
  error?: string;
  /** Qué factor falló, para que el diálogo vuelva a pedir el correcto. */
  requirement?: string;
}

export interface FounderActionInput {
  /** Fila del directorio de la otra persona (promover y transferir). */
  directoryUserId?: string;
  /** En transferir: si quien actúa baja a administrador. */
  stepDown?: boolean;
  /** Lo que escribió para confirmar. */
  confirmation: string;
  password?: string;
  code?: string;
}

async function context() {
  const user = await requireSession();
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  const accountId = session?.user?.id;
  if (!accountId) return null;
  const scope: FounderScope = {
    organizationId: user.organization.id,
    organizationName: user.organization.name,
    workspaceKind: user.organization.kind ?? 'company',
    actorAccountId: accountId,
    actorUserId: user.id,
    requestHeaders,
  };
  return { user, scope, accountId };
}

const SESSION_EXPIRED: FounderActionResult = {
  ok: false,
  error: 'Tu sesión venció. Vuelve a entrar.',
};
const BAD_CONFIRMATION: FounderActionResult = {
  ok: false,
  error: 'Lo que escribiste no coincide. Escribe el nombre tal como aparece arriba.',
};

function done(result: { ok: boolean; message: string }): FounderActionResult {
  if (result.ok) {
    revalidatePath('/admin/users');
    revalidatePath('/settings/seguridad');
    revalidatePath('/overview');
    return { ok: true, message: result.message };
  }
  return { ok: false, error: result.message };
}

async function stepUp(
  ctx: NonNullable<Awaited<ReturnType<typeof context>>>,
  input: FounderActionInput,
): Promise<FounderActionResult | null> {
  const result = await verifyStepUp({
    accountId: ctx.accountId,
    requestHeaders: ctx.scope.requestHeaders,
    credential: { password: input.password, code: input.code },
  });
  return result.ok ? null : { ok: false, error: result.message, requirement: result.requirement };
}

/** La otra persona: su `ba_member.id` y su nombre, dentro de ESTA empresa. */
async function otherPerson(
  ctx: NonNullable<Awaited<ReturnType<typeof context>>>,
  directoryUserId: string | undefined,
) {
  if (!directoryUserId) return null;
  const memberId = await memberIdForDirectoryUser(ctx.scope.organizationId, directoryUserId);
  if (!memberId) return null;
  const rows = await listCompanyMembers([ctx.scope.organizationId]);
  const row = rows.find((candidate) => candidate.memberId === memberId);
  return row ? { memberId, name: row.name, email: row.email } : null;
}

const GONE: FounderActionResult = {
  ok: false,
  error: 'Esa persona ya no está en la empresa. Recarga la pantalla.',
};

export async function promoteToOwnerAction(
  input: FounderActionInput,
): Promise<FounderActionResult> {
  const ctx = await context();
  if (!ctx) return SESSION_EXPIRED;
  if (ctx.user.organization.role !== 'owner') {
    return { ok: false, error: 'Solo un fundador puede nombrar a otro fundador.' };
  }
  const other = await otherPerson(ctx, input.directoryUserId);
  if (!other) return GONE;
  if (
    !confirmationMatches(input.confirmation, [other.name, other.email, ctx.scope.organizationName])
  ) {
    return BAD_CONFIRMATION;
  }
  const refusedStepUp = await stepUp(ctx, input);
  if (refusedStepUp) return refusedStepUp;
  return done(await promoteToOwner({ ...ctx.scope, memberId: other.memberId }));
}

export async function transferOwnershipAction(
  input: FounderActionInput,
): Promise<FounderActionResult> {
  const ctx = await context();
  if (!ctx) return SESSION_EXPIRED;
  if (ctx.user.organization.role !== 'owner') {
    return { ok: false, error: 'Solo un fundador puede pasar la propiedad.' };
  }
  const other = await otherPerson(ctx, input.directoryUserId);
  if (!other) return GONE;
  if (
    !confirmationMatches(input.confirmation, [other.name, other.email, ctx.scope.organizationName])
  ) {
    return BAD_CONFIRMATION;
  }
  const refusedStepUp = await stepUp(ctx, input);
  if (refusedStepUp) return refusedStepUp;
  return done(
    await transferOwnership({
      ...ctx.scope,
      memberId: other.memberId,
      stepDown: input.stepDown === true,
    }),
  );
}

export async function stepDownAction(input: FounderActionInput): Promise<FounderActionResult> {
  const ctx = await context();
  if (!ctx) return SESSION_EXPIRED;
  if (ctx.user.organization.role !== 'owner') {
    return { ok: false, error: 'Solo un fundador puede dejar de serlo.' };
  }
  if (!confirmationMatches(input.confirmation, [ctx.scope.organizationName])) {
    return BAD_CONFIRMATION;
  }
  const refusedStepUp = await stepUp(ctx, input);
  if (refusedStepUp) return refusedStepUp;
  return done(await stepDownAsOwner(ctx.scope));
}

export async function leaveCompanyAction(input: FounderActionInput): Promise<FounderActionResult> {
  const ctx = await context();
  if (!ctx) return SESSION_EXPIRED;
  if (!confirmationMatches(input.confirmation, [ctx.scope.organizationName])) {
    return BAD_CONFIRMATION;
  }
  // Un fundador que se va cambia quién manda: prueba de identidad. Los demás no.
  if (normalizeMembershipRole(ctx.user.organization.role) === 'owner') {
    const refusedStepUp = await stepUp(ctx, input);
    if (refusedStepUp) return refusedStepUp;
  }
  return done(await leaveCompany(ctx.scope));
}
