import 'server-only';

/**
 * Compartir, pasar y soltar la propiedad de una empresa: lo que escribe, y sólo
 * después de decidir, con las reglas de founder-rules.ts.
 *
 * ===========================================================================
 * LO QUE CADA LLAMADA VUELVE A LEER
 * ===========================================================================
 * Quién actúa y quién es el otro se leen de `ba_member` AQUÍ, en esta llamada.
 * El rol de quien actúa NO viaja desde la pantalla ni desde la sesión cacheada:
 * si le quitaron la propiedad hace un minuto, esta función lo sabe. Es el mismo
 * criterio de `changeMemberRole`, con una diferencia: aquel recibe `actorRole`
 * porque lo comprueba el layout; estos cuatro movimientos no confían ni en eso.
 *
 * La re-autenticación (contraseña o código de dos pasos) la pide la ACCIÓN, ver
 * lib/team/step-up.ts: esta capa asume que ya pasó.
 *
 * ===========================================================================
 * ORDEN DE ESCRITURA: NUNCA CERO FUNDADORES
 * ===========================================================================
 * 1. Intención en la auditoría (`attempted`), antes de tocar nada.
 * 2. `ba_member` por better-auth (que repite la comprobación por su cuenta).
 *    En una transferencia, primero se asciende al otro y después se baja a
 *    quien actúa: si el segundo paso falla quedan dos fundadores, no ninguno.
 * 3. `public.users.role` para que el directorio diga ya lo que dice la membresía.
 * 4. Resultado en la auditoría (`ok` o `error`) y aviso por correo a TODOS los
 *    fundadores. El correo es de mejor esfuerzo: que Resend esté caído no
 *    deshace un cambio ya hecho, pero tampoco lo oculta (queda en la auditoría).
 */

import { writeAuditEvent } from '@cortex/agent-tools';
import type { UUID } from '@cortex/core';
import { auth, pool } from '../auth';
import { sendEmail } from '../email';
import {
  REFUSAL_MESSAGE,
  decideLeave,
  decidePromoteToOwner,
  decideStepDown,
  decideTransfer,
  normalizeMembershipRole,
} from '../founder-rules';
import { getOrgScopedClient } from '../supabase/service';
import { type MembershipActionResult, listCompanyMembers } from './membership-admin';

export interface FounderScope {
  organizationId: string;
  organizationName: string;
  workspaceKind: 'personal' | 'company';
  actorAccountId: string;
  /** Fila de `public.users` de quien actúa: es el `user_id` de la auditoría. */
  actorUserId: string;
  requestHeaders: Headers;
}

export type FounderChange = 'promote' | 'transfer' | 'step_down' | 'leave';

export const FOUNDER_TOOL_ID: Record<FounderChange, string> = {
  promote: 'team_founder_promote',
  transfer: 'team_founder_transfer',
  step_down: 'team_founder_step_down',
  leave: 'team_leave_company',
};

const NOT_FOUND: MembershipActionResult = {
  ok: false,
  status: 404,
  message: 'Esa persona ya no está en la empresa. Recarga la pantalla.',
};

function refused(reason: keyof typeof REFUSAL_MESSAGE): MembershipActionResult {
  return { ok: false, status: 403, reason, message: REFUSAL_MESSAGE[reason] };
}

async function snapshot(scope: FounderScope, memberId: string | null) {
  const rows = await listCompanyMembers([scope.organizationId]);
  const actor = rows.find((row) => row.accountId === scope.actorAccountId) ?? null;
  const target = memberId ? (rows.find((row) => row.memberId === memberId) ?? null) : actor;
  const ownerCount = rows.filter((row) => normalizeMembershipRole(row.role) === 'owner').length;
  return { actor, target, ownerCount };
}

type Row = NonNullable<Awaited<ReturnType<typeof snapshot>>['actor']>;

const label = (row: Row) => row.name?.trim() || row.email;

async function audit(
  scope: FounderScope,
  change: FounderChange,
  status: 'attempted' | 'ok' | 'error',
  started: number,
  detail: Record<string, unknown>,
) {
  await writeAuditEvent({
    db: getOrgScopedClient(scope.organizationId),
    userId: scope.actorUserId as UUID,
    toolId: FOUNDER_TOOL_ID[change],
    input: detail,
    status,
    latencyMs: Math.round(performance.now() - started),
    surface: 'web',
    // Cambiar quién es dueño de la empresa es lo más alto que hay en la escala.
    riskLevel: 'critical',
    decision: 'confirmed',
    riskReason: 'Cambio de quién es fundador de la empresa, confirmado con re-autenticación.',
    metadata: { organizationId: scope.organizationId, ...detail },
  });
}

async function setMembershipRole(
  scope: FounderScope,
  memberId: string,
  role: 'owner' | 'admin',
): Promise<boolean> {
  try {
    await auth.api.updateMemberRole({
      body: { memberId, role, organizationId: scope.organizationId },
      headers: scope.requestHeaders,
    });
    return true;
  } catch (err) {
    console.error('[founder-admin] better-auth rechazó el cambio de rol', err);
    return false;
  }
}

/** Fundadores y administradores comparten rol en el directorio: `org_admin`. */
async function markDirectoryAdmin(scope: FounderScope, email: string) {
  await pool.query(
    `update public.users set role = 'org_admin'::public.user_role
      where organization_id = $1 and lower(email) = lower($2)`,
    [scope.organizationId, email],
  );
}

const GENERIC_FAILURE = (what: string): MembershipActionResult => ({
  ok: false,
  status: 400,
  message: `No se pudo ${what}. Recarga la pantalla e inténtalo de nuevo.`,
});

/**
 * Aviso a todos los fundadores. Se calcula DESPUÉS del cambio (los que son
 * fundadores ahora) más quienes dejaron de serlo en él (`alsoNotify`): la
 * persona a la que le quitan o sueltan la propiedad también tiene que saberlo.
 */
async function notifyFounders(
  scope: FounderScope,
  subject: string,
  body: string,
  alsoNotify: readonly string[] = [],
) {
  try {
    const rows = await listCompanyMembers([scope.organizationId]);
    const founders = rows
      .filter((row) => normalizeMembershipRole(row.role) === 'owner')
      .map((row) => row.email);
    const to = [...new Set([...founders, ...alsoNotify].map((email) => email.toLowerCase()))];
    const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '');
    const link = base ? `\n\nPuedes revisarlo en ${base}/admin/users` : '';
    await sendEmail({
      to: to,
      subject,
      text: `${body}${link}\n\nRecibes este aviso porque eres fundador de ${scope.organizationName} en Cortex. Si no reconoces este cambio, entra a Cortex y revisa la auditoría.`,
    });
  } catch (err) {
    console.error('[founder-admin] no se pudo avisar a los fundadores', err);
  }
}

/* ---------------------------------------------------------------------------
 * Hacer cofundador
 * ------------------------------------------------------------------------- */

export async function promoteToOwner(
  scope: FounderScope & { memberId: string },
): Promise<MembershipActionResult> {
  const started = performance.now();
  const { actor, target, ownerCount } = await snapshot(scope, scope.memberId);
  if (!actor) return refused('not_manager');
  if (!target) return NOT_FOUND;
  const decision = decidePromoteToOwner({
    workspaceKind: scope.workspaceKind,
    actorRole: normalizeMembershipRole(actor.role),
    actorIsTarget: target.accountId === scope.actorAccountId,
    targetRole: normalizeMembershipRole(target.role),
  });
  if (!decision.ok) return refused(decision.reason);

  const detail = {
    memberId: target.memberId,
    targetEmail: target.email,
    targetName: label(target),
    ownersBefore: ownerCount,
  };
  await audit(scope, 'promote', 'attempted', started, detail);
  if (!(await setMembershipRole(scope, target.memberId, 'owner'))) {
    await audit(scope, 'promote', 'error', started, detail);
    return GENERIC_FAILURE('hacer cofundador a esta persona');
  }
  await markDirectoryAdmin(scope, target.email);
  await audit(scope, 'promote', 'ok', started, detail);
  await notifyFounders(
    scope,
    `${label(target)} ahora es cofundador de ${scope.organizationName}`,
    `${label(actor)} nombró cofundador a ${label(target)} (${target.email}) en ${scope.organizationName}.\n\nUn cofundador puede hacer todo lo que hace un administrador y, además, nombrar o retirar a otros cofundadores y borrar la empresa.`,
  );
  return { ok: true, status: 200, message: `${label(target)} ahora es cofundador.` };
}

/* ---------------------------------------------------------------------------
 * Transferir la propiedad
 * ------------------------------------------------------------------------- */

export async function transferOwnership(
  scope: FounderScope & { memberId: string; stepDown: boolean },
): Promise<MembershipActionResult> {
  const started = performance.now();
  const { actor, target, ownerCount } = await snapshot(scope, scope.memberId);
  if (!actor) return refused('not_manager');
  if (!target) return NOT_FOUND;
  const decision = decideTransfer({
    workspaceKind: scope.workspaceKind,
    actorRole: normalizeMembershipRole(actor.role),
    actorIsTarget: target.accountId === scope.actorAccountId,
    targetRole: normalizeMembershipRole(target.role),
    ownerCount,
    stepDown: scope.stepDown,
  });
  if (!decision.ok) return refused(decision.reason);

  const detail = {
    memberId: target.memberId,
    targetEmail: target.email,
    targetName: label(target),
    stepDown: decision.demoteActor,
    ownersBefore: ownerCount,
  };
  await audit(scope, 'transfer', 'attempted', started, detail);
  if (decision.promoteTarget) {
    if (!(await setMembershipRole(scope, target.memberId, 'owner'))) {
      await audit(scope, 'transfer', 'error', started, detail);
      return GENERIC_FAILURE('pasar la propiedad');
    }
    await markDirectoryAdmin(scope, target.email);
  }
  if (decision.demoteActor) {
    if (!(await setMembershipRole(scope, actor.memberId, 'admin'))) {
      // Estado seguro: ya hay dos fundadores. Se dice tal cual.
      await audit(scope, 'transfer', 'error', started, { ...detail, partial: 'target_promoted' });
      return {
        ok: false,
        status: 400,
        message: `${label(target)} ya es cofundador, pero no se pudo bajar tu rol. Sigues siendo fundador: puedes intentar «Dejar de ser fundador» después.`,
      };
    }
    await markDirectoryAdmin(scope, actor.email);
  }
  await audit(scope, 'transfer', 'ok', started, detail);
  await notifyFounders(
    scope,
    decision.demoteActor
      ? `La propiedad de ${scope.organizationName} pasó a ${label(target)}`
      : `${label(target)} ahora es cofundador de ${scope.organizationName}`,
    decision.demoteActor
      ? `${label(actor)} pasó la propiedad de ${scope.organizationName} a ${label(target)} (${target.email}) y ahora es administrador.`
      : `${label(actor)} nombró cofundador a ${label(target)} (${target.email}) en ${scope.organizationName}.`,
    decision.demoteActor ? [actor.email] : [],
  );
  return {
    ok: true,
    status: 200,
    message: decision.demoteActor
      ? `${label(target)} es ahora fundador y tú quedaste como administrador.`
      : `${label(target)} ahora es cofundador.`,
  };
}

/* ---------------------------------------------------------------------------
 * Dejar de ser fundador
 * ------------------------------------------------------------------------- */

export async function stepDownAsOwner(scope: FounderScope): Promise<MembershipActionResult> {
  const started = performance.now();
  const { actor, ownerCount } = await snapshot(scope, null);
  if (!actor) return refused('not_manager');
  const decision = decideStepDown({
    workspaceKind: scope.workspaceKind,
    actorRole: normalizeMembershipRole(actor.role),
    ownerCount,
  });
  if (!decision.ok) return refused(decision.reason);

  const detail = { memberId: actor.memberId, targetEmail: actor.email, ownersBefore: ownerCount };
  await audit(scope, 'step_down', 'attempted', started, detail);
  if (!(await setMembershipRole(scope, actor.memberId, 'admin'))) {
    await audit(scope, 'step_down', 'error', started, detail);
    return GENERIC_FAILURE('dejar de ser fundador');
  }
  await markDirectoryAdmin(scope, actor.email);
  await audit(scope, 'step_down', 'ok', started, detail);
  await notifyFounders(
    scope,
    `${label(actor)} dejó de ser fundador de ${scope.organizationName}`,
    `${label(actor)} (${actor.email}) dejó de ser fundador de ${scope.organizationName}. Sigue en la empresa como administrador.`,
    [actor.email],
  );
  return { ok: true, status: 200, message: 'Ya no eres fundador. Quedas como administrador.' };
}

/* ---------------------------------------------------------------------------
 * Dejar la empresa
 * ------------------------------------------------------------------------- */

export async function leaveCompany(scope: FounderScope): Promise<MembershipActionResult> {
  const started = performance.now();
  const { actor, ownerCount } = await snapshot(scope, null);
  if (!actor) return NOT_FOUND;
  const role = normalizeMembershipRole(actor.role);
  const decision = decideLeave({
    workspaceKind: scope.workspaceKind,
    actorRole: role,
    ownerCount,
  });
  if (!decision.ok) return refused(decision.reason);

  const detail = { memberId: actor.memberId, targetEmail: actor.email, roleBefore: role };
  await audit(scope, 'leave', 'attempted', started, detail);
  try {
    // Mismo camino que «retirar»: borra la membresía y el disparador de la 0138
    // pausa rutinas y revoca credenciales privadas de quien se va.
    await auth.api.leaveOrganization({
      body: { organizationId: scope.organizationId },
      headers: scope.requestHeaders,
    });
  } catch (err) {
    console.error('[founder-admin] better-auth rechazó la salida', err);
    await audit(scope, 'leave', 'error', started, detail);
    return GENERIC_FAILURE('salir de la empresa');
  }
  await audit(scope, 'leave', 'ok', started, detail);
  // Sólo es un cambio de fundadores si quien se va lo era.
  if (role === 'owner') {
    await notifyFounders(
      scope,
      `${label(actor)} salió de ${scope.organizationName}`,
      `${label(actor)} (${actor.email}) era fundador de ${scope.organizationName} y salió de la empresa.`,
      [actor.email],
    );
  }
  return { ok: true, status: 200, message: `Saliste de ${scope.organizationName}.` };
}

/* ---------------------------------------------------------------------------
 * Invitar directo como cofundador
 * ------------------------------------------------------------------------- */

/**
 * Invitar a alguien que todavía no está en la empresa como cofundador.
 *
 * Es el mismo poder que «hacer cofundador», concedido por adelantado: quien
 * acepte el enlace entra como `owner`. Por eso pasa por la misma auditoría
 * (`team_founder_promote`, con `via: 'invitation'`) y el mismo aviso a los
 * fundadores. La re-autenticación y el «sólo un fundador» los comprueba la ruta
 * antes de llamar; `invite` es la invitación de siempre (asientos incluidos).
 */
export async function inviteCofounder<T extends { status: string; message: string }>(
  scope: FounderScope,
  email: string,
  invite: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const { actor, ownerCount } = await snapshot(scope, null);
  const detail = { via: 'invitation', targetEmail: email, ownersBefore: ownerCount };
  await audit(scope, 'promote', 'attempted', started, detail);
  const result = await invite();
  await audit(scope, 'promote', result.status === 'sent' ? 'ok' : 'error', started, {
    ...detail,
    outcome: result.status,
  });
  if (result.status === 'sent') {
    await notifyFounders(
      scope,
      `Invitación de cofundador en ${scope.organizationName}`,
      `${actor ? label(actor) : 'Un fundador'} invitó a ${email} como cofundador de ${scope.organizationName}. Cuando acepte, podrá hacer todo lo que hace un administrador y, además, nombrar o retirar a otros cofundadores y borrar la empresa.\n\nSi no reconoces esta invitación, cancélala en Personas.`,
    );
  }
  return result;
}
