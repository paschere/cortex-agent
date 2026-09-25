import 'server-only';

/**
 * Invitar, cambiar el rol y retirar a alguien de una empresa: UNA sola
 * implementación para las dos pantallas que lo hacen.
 *
 * ===========================================================================
 * QUIÉN LLAMA Y QUÉ YA COMPROBÓ
 * ===========================================================================
 * - `POST /api/team/invite` y «Personas» de la empresa (/admin/users) actúan en
 *   el espacio de la sesión, con el rol que `requireSession` leyó de
 *   `ba_member`.
 * - La consola del fundador (/overview/people) actúa sobre varias empresas, y
 *   antes de llegar aquí ya comprobó con `requireFounderContext` que cada una
 *   es de la cuenta.
 *
 * Aquí se vuelve a decidir de todas formas —con `decideRoleChange` /
 * `decideRemoval` sobre filas leídas en esta misma llamada— porque es la capa
 * que escribe, y porque la regla «no dejes a la empresa sin fundador» depende de
 * cuántos fundadores hay AHORA, no cuando se pintó la pantalla.
 *
 * ===========================================================================
 * better-auth ESCRIBE LA MEMBRESÍA; ESTO ESCRIBE EL DIRECTORIO
 * ===========================================================================
 * `ba_member.role` es la fuente de verdad (ver founder-rules.ts). Se cambia con
 * `auth.api.updateMemberRole` / `auth.api.removeMember` y las cabeceras de la
 * sesión de quien actúa, así que better-auth vuelve a comprobar por su cuenta
 * que esa persona puede tocar a esa otra en esa organización. Retirar dispara
 * además `offboard_removed_member()` (migración 0138): pausa rutinas, revoca
 * credenciales privadas y deja constancia en `member_offboarding_events`.
 *
 * `public.users.role` se escribe después y a mano porque `team_admin` sólo
 * existe ahí, y porque la persona afectada puede no volver a entrar en días: su
 * fila tiene que decir ya lo que dice la membresía.
 */

import { readSeats, readWorkspacePlan } from '@cortex/agent-tools';
import type { OrgRole, Role } from '@cortex/core';
import { auth, pool } from '../auth';
import {
  type MembershipRow,
  REFUSAL_MESSAGE,
  decideRemoval,
  decideRoleChange,
  directoryRoleFor,
  membershipTargetFor,
  normalizeMembershipRole,
} from '../founder-rules';
import { getOrgScopedClient } from '../supabase/service';

export interface MembershipActionResult {
  ok: boolean;
  message: string;
  /** Código HTTP sugerido, para las rutas que lo necesiten. */
  status: number;
  reason?: string;
}

/* ---------------------------------------------------------------------------
 * Lecturas
 * ------------------------------------------------------------------------- */

const MEMBERS_SQL = `
  select m.id as "memberId", m."organizationId" as "organizationId", o.name as "organizationName",
         b.id as "accountId", b.name, b.email, m.role,
         d.role::text as "directoryRole", m."createdAt"::text as "joinedAt"
    from public.ba_member m
    join public.ba_organization o on o.id = m."organizationId"
    join public.ba_user b on b.id = m."userId"
    left join public.users d
      on d.organization_id = m."organizationId" and lower(d.email) = lower(b.email)
   where m."organizationId" = any($1::text[])
   order by m."createdAt"`;

/**
 * Las membresías de varias empresas, con el rol del directorio al lado.
 *
 * `ba_member` y `ba_user` son `shared` (tenancy/tables.ts), así que el filtro
 * por empresa se escribe aquí, siempre con ids que ya validó el servidor.
 */
export async function listCompanyMembers(
  organizationIds: readonly string[],
): Promise<MembershipRow[]> {
  if (organizationIds.length === 0) return [];
  const { rows } = await pool.query<MembershipRow>(MEMBERS_SQL, [[...organizationIds]]);
  return rows;
}

export interface CompanyInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: 'member' | 'admin' | 'owner';
  expiresAt: string;
  expired: boolean;
}

/** Las invitaciones pendientes de varias empresas; mismo criterio que `listPendingInvitations`. */
export async function listCompanyInvitations(
  organizationIds: readonly string[],
  at: Date = new Date(),
): Promise<CompanyInvitation[]> {
  if (organizationIds.length === 0) return [];
  const { rows } = await pool.query<{
    id: string;
    organizationId: string;
    email: string;
    role: string | null;
    expiresAt: Date | string;
  }>(
    `select id, "organizationId", email, role, "expiresAt"
       from public.ba_invitation
      where "organizationId" = any($1::text[]) and status = 'pending'
      order by "expiresAt" desc`,
    [[...organizationIds]],
  );
  return rows.map((row) => {
    const expiresAt = new Date(row.expiresAt).toISOString();
    return {
      id: row.id,
      organizationId: row.organizationId,
      email: row.email,
      role: row.role === 'admin' || row.role === 'owner' ? row.role : 'member',
      expiresAt,
      expired: new Date(expiresAt).getTime() <= at.getTime(),
    };
  });
}

/**
 * El `ba_member.id` de una fila del directorio de esta empresa.
 *
 * /admin/users trabaja con ids de `public.users`; better-auth, con ids de
 * `ba_member`. El puente es el correo dentro de la MISMA empresa, igual que en
 * `resolveSessionDirectory` y en el disparador de la 0138.
 */
export async function memberIdForDirectoryUser(
  organizationId: string,
  directoryUserId: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `select m.id
       from public.users d
       join public.ba_user b on lower(b.email) = lower(d.email)
       join public.ba_member m on m."userId" = b.id and m."organizationId" = d.organization_id
      where d.id = $2 and d.organization_id = $1
      limit 1`,
    [organizationId, directoryUserId],
  );
  return rows[0]?.id ?? null;
}

/* ---------------------------------------------------------------------------
 * Invitar
 * ------------------------------------------------------------------------- */

/**
 * Invitar a alguien a UNA empresa, con el tope de asientos del plan.
 *
 * Es el cuerpo de `POST /api/team/invite` sacado a una función para que la
 * consola del fundador invite a varias empresas sin copiarlo. El porqué del
 * tope, y de que sólo el plan gratuito lo tenga, está en esa ruta.
 */
export async function inviteToCompany(input: {
  organizationId: string;
  email: string;
  role: 'member' | 'admin';
  requestHeaders: Headers;
}): Promise<MembershipActionResult & { id?: string | null }> {
  const db = getOrgScopedClient(input.organizationId);
  const { plan, contractedSeats } = await readWorkspacePlan(db);
  const seats = await readSeats(db, input.organizationId, plan, contractedSeats);

  if (seats.full) {
    return {
      ok: false,
      status: 402,
      reason: 'plan_limit',
      message: `Tu plan ${plan.name} llega hasta ${seats.maximum} personas y ya están ocupadas (${seats.members} adentro${seats.pending > 0 ? ` y ${seats.pending} por aceptar` : ''}). Amplía el plan en Plan y consumo, o cancela una invitación pendiente.`,
    };
  }

  try {
    const invitation = await auth.api.createInvitation({
      body: {
        email: input.email,
        role: input.role,
        // Nombrada y no heredada de la sesión: una sesión con otra empresa
        // activa no puede mandar la invitación a un espacio equivocado.
        organizationId: input.organizationId,
        // Reenviar a quien perdió el correo no compra un asiento: la
        // comprobación de arriba ya contó su invitación pendiente.
        resend: true,
      },
      headers: input.requestHeaders,
    });
    return {
      ok: true,
      status: 200,
      message: 'Invitación enviada.',
      id: (invitation as { id?: string })?.id ?? null,
    };
  } catch (err) {
    // Las negativas de better-auth (ya es miembro, ya invitado) traen una frase
    // usable; cualquier otra cosa recibe una genérica, nunca una traza.
    const message = err instanceof Error ? err.message : '';
    return {
      ok: false,
      status: 400,
      message:
        message && message.length < 200
          ? message
          : 'No se pudo enviar la invitación. Inténtalo de nuevo.',
    };
  }
}

/* ---------------------------------------------------------------------------
 * Cambiar el rol y retirar
 * ------------------------------------------------------------------------- */

interface MembershipScope {
  organizationId: string;
  workspaceKind: 'personal' | 'company';
  actorAccountId: string;
  /** Rol de quien actúa en esa empresa, leído del servidor (`ba_member`). */
  actorRole: OrgRole;
  memberId: string;
  requestHeaders: Headers;
}

async function loadTarget(scope: MembershipScope) {
  const rows = await listCompanyMembers([scope.organizationId]);
  const target = rows.find((row) => row.memberId === scope.memberId) ?? null;
  const ownerCount = rows.filter((row) => normalizeMembershipRole(row.role) === 'owner').length;
  return { target, ownerCount };
}

const NOT_FOUND: MembershipActionResult = {
  ok: false,
  status: 404,
  message: 'Esa persona ya no está en la empresa. Recarga la pantalla.',
};

function refused(reason: keyof typeof REFUSAL_MESSAGE): MembershipActionResult {
  return {
    ok: false,
    status: reason === 'unchanged' ? 409 : 403,
    reason,
    message: REFUSAL_MESSAGE[reason],
  };
}

/**
 * Poner a alguien en `next` (rol del directorio), de forma que persista.
 *
 * Orden: primero `ba_member` vía better-auth —si se niega, no se escribe nada
 * más—, después `public.users`. Al revés, un rechazo de better-auth dejaría un
 * directorio que dice «admin» sobre una membresía que dice «member», que es
 * exactamente el fallo que se está arreglando.
 */
export async function changeMemberRole(
  scope: MembershipScope & { next: Role },
): Promise<MembershipActionResult> {
  const { target, ownerCount } = await loadTarget(scope);
  if (!target) return NOT_FOUND;
  const targetRole = normalizeMembershipRole(target.role);
  const currentDirectoryRole = directoryRoleFor(
    targetRole,
    target.directoryRole === 'team_admin' ? 'team_admin' : null,
  );
  const decision = decideRoleChange({
    workspaceKind: scope.workspaceKind,
    actorRole: scope.actorRole,
    actorIsTarget: target.accountId === scope.actorAccountId,
    targetRole,
    ownerCount,
    currentDirectoryRole,
    next: scope.next,
  });
  if (!decision.ok) return refused(decision.reason);

  const wanted = membershipTargetFor(scope.next);
  if (targetRole !== wanted.membershipRole) {
    try {
      await auth.api.updateMemberRole({
        body: {
          memberId: target.memberId,
          role: wanted.membershipRole,
          organizationId: scope.organizationId,
        },
        headers: scope.requestHeaders,
      });
    } catch (err) {
      console.error('[membership-admin] better-auth rechazó el cambio de rol', err);
      return {
        ok: false,
        status: 400,
        message: 'No se pudo cambiar el rol. Recarga la pantalla e inténtalo de nuevo.',
      };
    }
  }

  // La fila puede no existir todavía (nunca entró a esta empresa): entonces no
  // hay nada que corregir y `resolveSessionDirectory` la creará bien.
  await pool.query(
    `update public.users set role = $3::public.user_role
      where organization_id = $1 and lower(email) = lower($2)`,
    [scope.organizationId, target.email, wanted.directoryRole],
  );
  return { ok: true, status: 200, message: 'Rol actualizado.' };
}

/**
 * Retirar a alguien de la empresa. La salida segura la hace el disparador de la
 * 0138; aquí sólo se decide si se puede y se le pide a better-auth.
 */
export async function removeCompanyMember(scope: MembershipScope): Promise<MembershipActionResult> {
  const { target, ownerCount } = await loadTarget(scope);
  if (!target) return NOT_FOUND;
  const decision = decideRemoval({
    workspaceKind: scope.workspaceKind,
    actorRole: scope.actorRole,
    actorIsTarget: target.accountId === scope.actorAccountId,
    targetRole: normalizeMembershipRole(target.role),
    ownerCount,
  });
  if (!decision.ok) return refused(decision.reason);

  try {
    await auth.api.removeMember({
      body: { memberIdOrEmail: target.memberId, organizationId: scope.organizationId },
      headers: scope.requestHeaders,
    });
  } catch (err) {
    console.error('[membership-admin] better-auth rechazó la salida', err);
    return {
      ok: false,
      status: 400,
      message: 'No se pudo retirar a esta persona. Recarga la pantalla e inténtalo de nuevo.',
    };
  }
  return { ok: true, status: 200, message: 'Acceso retirado.' };
}
