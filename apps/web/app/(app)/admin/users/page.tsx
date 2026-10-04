import { InviteTeam } from '@/components/team/InviteTeam';
import { PendingInvitations } from '@/components/team/PendingInvitations';
import { RoleMatrix } from '@/components/team/RoleMatrix';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelHead } from '@/components/ui/panel';
import { auth } from '@/lib/auth';
import {
  decideLeave,
  decidePromoteToOwner,
  decideRemoval,
  decideStepDown,
  decideTransfer,
  normalizeMembershipRole,
} from '@/lib/founder-rules';
import { relativeTime } from '@/lib/relative-time';
import { requireSession } from '@/lib/session';
import { mustReadList } from '@/lib/supabase/read';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { listPendingInvitations } from '@/lib/team/invitations';
import { listCompanyMembers, listTwoFactorStatus } from '@/lib/team/membership-admin';
import { ROLES_INFO, type RoleKey, roleKeyOf } from '@/lib/team/role-matrix';
import { initials } from '@/lib/team/shape';
import { readStepUp } from '@/lib/team/step-up';
import { managerMapOf, readSeats, readWorkspacePlan, wouldCycle } from '@cortex/agent-tools';
import { ChevronDown, Crown, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { headers } from 'next/headers';
import { absoluteTime } from '../audit/_components/format';
import { PeopleRoster, type RosterRow } from './_components/PeopleRoster';
import { countdown } from './_lib/countdown';
import { AUDIT_ROW_CAP, WINDOW_DAYS, fetchRosterActivity, rosterFor } from './_lib/user-activity';
import { cancelInvitationAction } from './actions';

export const dynamic = 'force-dynamic';

type DirectoryRole = 'member' | 'team_admin' | 'org_admin';

interface User {
  id: string;
  email: string;
  name: string | null;
  role: DirectoryRole;
  manager_id: string | null;
  created_at: string;
}

/**
 * Lecturas de adorno —los equipos y el cargo de cada persona— que no justifican
 * tumbar la pantalla si faltan: un cargo vacío cuesta una celda, mientras que
 * lanzar aquí costaría la lista entera de personas. El contenido de verdad
 * (quiénes son) sí se lee con `mustReadList`.
 */
function quietly<T>(result: { data: T[] | null; error: unknown }): T[] {
  return result.error ? [] : (result.data ?? []);
}

export default async function UsersPage() {
  const user = await requireSession();
  const sb = getOrgScopedClient(user.organization.id);
  const requestHeaders = await headers();
  const accountId = (await auth.api.getSession({ headers: requestHeaders }))?.user?.id ?? null;

  /**
   * INVITAR VIVE AQUÍ DESDE AHORA, Y NO SÓLO EN EL ONBOARDING.
   *
   * Ésta es la pantalla donde está la gente, así que es donde se agrega gente.
   * Los asientos son los de verdad —`readSeats`, el mismo cálculo que defiende
   * `POST /api/team/invite`— y no una cuenta aparte: un formulario que dice que
   * caben tres personas y una ruta que rechaza la segunda es peor que no decir
   * nada.
   */
  const { plan, contractedSeats } = await readWorkspacePlan(sb);
  const actorRole = normalizeMembershipRole(user.organization.role);
  const actorIsOwner = actorRole === 'owner';
  const workspaceKind = user.organization.kind ?? 'company';

  // Pocas lecturas para toda la pantalla, nunca una por persona.
  const [
    roster,
    activity,
    seats,
    invitations,
    memberships,
    teamsRes,
    teamMembersRes,
    employeesRes,
    twoFactor,
    stepUp,
  ] = await Promise.all([
    sb.from('users').select('id, email, name, role, manager_id, created_at').order('created_at'),
    fetchRosterActivity(sb),
    readSeats(sb, user.organization.id, plan, contractedSeats),
    listPendingInvitations(sb, user.organization.id),
    // La membresía de better-auth de cada fila: dice quién es fundador y quién
    // ya salió, que el directorio solo no sabe decir.
    listCompanyMembers([user.organization.id]),
    sb.from('teams').select('id, name').order('name'),
    sb.from('team_members').select('team_id, user_id'),
    sb.from('employees').select('user_id, job_title').not('user_id', 'is', null),
    // Sólo un fundador responde por la seguridad de las demás cuentas.
    actorIsOwner ? listTwoFactorStatus(user.organization.id) : Promise.resolve(null),
    accountId
      ? readStepUp(accountId, requestHeaders)
      : Promise.resolve({ requirement: 'password' as const, twoFactorEnabled: false }),
  ]);

  const membershipOf = new Map(memberships.map((row) => [row.email.toLowerCase(), row]));
  const ownerCount = memberships.filter(
    (row) => normalizeMembershipRole(row.role) === 'owner',
  ).length;

  // `mustReadList` y no `?? []`: una base caída diría «todavía no hay nadie».
  const users: User[] = mustReadList<User>(roster, 'las personas de este espacio');
  const managers = managerMapOf(users.map((u) => ({ id: u.id, managerId: u.manager_id })));
  const label = (u: User) => u.name?.trim() || u.email;
  const unmanaged = users.filter((u) => !u.manager_id).length;
  const activeCount = users.filter((u) => rosterFor(activity, u.id).lastActive).length;
  const flaggedCount = users.filter((u) => rosterFor(activity, u.id).flagged30d > 0).length;

  const teamNameById = new Map(
    quietly<{ id: string; name: string }>(teamsRes).map((team) => [team.id, team.name]),
  );
  const teamsOf = new Map<string, string[]>();
  for (const link of quietly<{ team_id: string; user_id: string }>(teamMembersRes)) {
    const name = teamNameById.get(link.team_id);
    if (name) teamsOf.set(link.user_id, [...(teamsOf.get(link.user_id) ?? []), name]);
  }
  const titleOf = new Map(
    quietly<{ user_id: string; job_title: string | null }>(employeesRes).map((row) => [
      row.user_id,
      row.job_title,
    ]),
  );

  const rows: RosterRow[] = users.map((u) => {
    const membership = membershipOf.get(u.email.toLowerCase());
    const membershipRole = membership ? normalizeMembershipRole(membership.role) : null;
    const role: RoleKey | 'removed' = membershipRole
      ? roleKeyOf(membershipRole, u.role)
      : 'removed';
    const self = u.id === user.id;
    const a = rosterFor(activity, u.id);
    const decisionInput = {
      workspaceKind,
      actorRole,
      actorIsTarget: self,
      targetRole: membershipRole ?? ('member' as const),
      ownerCount,
    };
    const present = role !== 'removed';
    return {
      id: u.id,
      name: u.name?.trim() || null,
      email: u.email,
      label: label(u),
      initials: initials(label(u)),
      role,
      directoryRole: u.role,
      managerId: u.manager_id,
      // Las opciones que cerrarían un círculo NO SE OFRECEN, en vez de ofrecerse
      // y fallar al guardar; la regla es la misma función pura que defiende la
      // base de datos.
      blockedManagerIds: users
        .filter((other) => other.id === u.id || wouldCycle(managers, u.id, other.id))
        .map((other) => other.id),
      teams: [...(teamsOf.get(u.id) ?? [])].sort((x, y) => x.localeCompare(y, 'es')),
      title: titleOf.get(u.id)?.trim() || null,
      lastActiveLabel: a.lastActive ? relativeTime(a.lastActive) : null,
      lastActiveTitle: a.lastActive ? absoluteTime(a.lastActive) : null,
      calls7d: a.calls7d,
      flagged30d: a.flagged30d,
      joinedLabel: new Date(u.created_at).toLocaleDateString('es-CO'),
      self,
      twoFactor:
        twoFactor && present && (role === 'owner' || role === 'admin')
          ? (twoFactor.get(u.email.toLowerCase()) ?? false)
          : null,
      can: {
        // Fundadores, uno mismo y quien ya salió no cambian de rol por el
        // desplegable: la propiedad tiene sus propios movimientos.
        changeRole: present && !self && membershipRole !== 'owner',
        promote: present && decidePromoteToOwner(decisionInput).ok,
        transfer:
          present &&
          membershipRole !== 'owner' &&
          decideTransfer({ ...decisionInput, stepDown: true }).ok,
        remove: present && !self && decideRemoval(decisionInput).ok,
        stepDown: present && self && decideStepDown(decisionInput).ok,
        leave: present && self && decideLeave(decisionInput).ok,
      },
    };
  });

  const counts: Record<RoleKey, number> = { owner: 0, admin: 0, team_admin: 0, member: 0 };
  for (const row of rows) if (row.role !== 'removed') counts[row.role] += 1;
  const seated = rows.filter((row) => row.role !== 'removed').length;
  const privileged = rows.filter((row) => row.twoFactor !== null);
  const withoutTwoFactor = privileged.filter((row) => row.twoFactor === false).length;
  const seatPct =
    seats.maximum && seats.maximum > 0
      ? Math.min(100, Math.round((seats.used / seats.maximum) * 100))
      : 0;

  return (
    <>
      <PageHeader
        title="Personas"
        subtitle={`${seated} ${seated === 1 ? 'persona tiene' : 'personas tienen'} acceso a ${user.organization.name} · ${activeCount} con actividad en los últimos ${WINDOW_DAYS} días`}
        icon={<Users className="h-5 w-5" />}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Panel className="p-4">
          <div className="field-label">Asientos · plan {plan.name}</div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="stat-num text-xl text-ink">{seats.used}</span>
            <span className="text-sm text-ink-muted">
              {seats.maximum ? `de ${seats.maximum}` : 'sin tope'}
            </span>
          </div>
          {seats.maximum ? (
            <div className="mt-2 h-2 overflow-hidden rounded-pill bg-surface-2">
              <div
                className={`h-full rounded-pill ${seats.full ? 'bg-amber' : 'bg-primary'}`}
                style={{ width: `${Math.max(seatPct, seats.used > 0 ? 4 : 0)}%` }}
              />
            </div>
          ) : null}
          <p className="mt-2 text-micro text-ink-faint">
            {seats.members} adentro
            {seats.pending > 0 ? ` y ${seats.pending} por aceptar` : ''}
            {seats.full ? ' · llenos: amplía el plan para invitar a más' : ''}
          </p>
        </Panel>

        <Panel className="p-4">
          <div className="field-label">Quién manda</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(Object.keys(counts) as RoleKey[]).map((key) => (
              <span
                key={key}
                className={`inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-micro font-semibold ${ROLES_INFO[key].chip}`}
              >
                {key === 'owner' && <Crown className="h-3 w-3" aria-hidden />}
                <span className="tabular">{counts[key]}</span> {ROLES_INFO[key].label}
              </span>
            ))}
          </div>
          <p className="mt-2 text-micro text-ink-faint">
            {counts.owner > 1
              ? 'La propiedad está compartida: si falta uno, queda otro.'
              : 'Solo hay un fundador. Considera nombrar a un cofundador de confianza.'}
          </p>
        </Panel>

        <Panel className="p-4">
          <div className="field-label">Seguridad de las cuentas</div>
          {actorIsOwner ? (
            <>
              <div className="mt-2 flex items-center gap-2 text-sm text-ink">
                <ShieldCheck
                  className={`h-4 w-4 ${withoutTwoFactor > 0 ? 'text-amber' : 'text-emerald'}`}
                  aria-hidden
                />
                {withoutTwoFactor > 0
                  ? `${withoutTwoFactor} de ${privileged.length} sin verificación en dos pasos`
                  : 'Fundadores y administradores con dos pasos'}
              </div>
              <p className="mt-2 text-micro text-ink-faint">
                Quien administra o es fundador debería tenerla activa.
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-ink-muted">
              Los fundadores ven aquí quién tiene la verificación en dos pasos.
            </p>
          )}
        </Panel>
      </div>

      <Panel className="mb-5">
        <PanelHead title="Invitar a alguien" icon={<UserPlus className="h-4 w-4" />} />
        <div className="px-5 pb-5 pt-3">
          <InviteTeam
            seatsUsed={seats.used}
            seatsMaximum={seats.maximum}
            perSeatAnswers={plan.perSeat.answers}
            priceCopPerSeat={plan.priceCopPerSeat}
            canInvite={user.role === 'org_admin'}
          />
        </div>

        {/*
          Las pendientes van pegadas al formulario y no en un panel aparte porque
          son su consecuencia: lo que acabas de enviar sale justo debajo, y el
          asiento que ocupa se ve en la misma cifra de arriba.
        */}
        <div className="border-t border-border">
          <div className="flex items-baseline justify-between gap-3 px-5 pt-3.5">
            <span className="text-xs font-semibold text-ink">Invitaciones pendientes</span>
            {invitations.length > 0 && (
              <span className="tabular text-micro text-ink-faint">
                {invitations.length} en espera
              </span>
            )}
          </div>
          <PendingInvitations
            cancelInvitation={cancelInvitationAction}
            invitations={invitations.map((invitation) => ({
              id: invitation.id,
              email: invitation.email,
              role: invitation.role,
              expired: invitation.expired,
              // `countdown` ya dice «vencido» sola cuando la fecha pasó; el
              // prefijo se pone sólo cuando todavía falta, para que la vencida
              // no se lea «vence vencido».
              expiresLabel: invitation.expired
                ? 'vencida'
                : `vence ${countdown(invitation.expiresAt)}`,
              expiresTitle: absoluteTime(invitation.expiresAt),
            }))}
          />
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        {users.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <Users className="mx-auto mb-3 h-6 w-6 text-ink-faint" />
            <p className="text-sm font-semibold text-ink">Todavía no hay nadie registrado</p>
            {/*
              A este espacio se entra aceptando una invitación, que es justo lo que
              hay en el panel de arriba. Un estado vacío que explica mal cómo se
              llena deja a alguien esperando algo que no va a pasar solo.
            */}
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-ink-muted">
              A este espacio se entra por invitación. Escribe un correo arriba: le llega un enlace
              que dura 7 días y, en cuanto lo acepte, la persona aparece en esta lista.
            </p>
          </div>
        ) : (
          <PeopleRoster
            rows={rows}
            teamNames={[...teamNameById.values()].sort((a, b) => a.localeCompare(b, 'es'))}
            companyName={user.organization.name}
            windowDays={WINDOW_DAYS}
            stepUp={{
              requirement: stepUp.requirement,
              hasTwoFactor: stepUp.twoFactorEnabled,
            }}
          />
        )}
      </Panel>

      <details className="group mt-5 rounded-card border border-border bg-surface shadow-card">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3.5 text-sm font-bold text-ink">
          ¿Qué puede hacer cada rol?
          <ChevronDown
            className="h-4 w-4 text-ink-faint transition-transform group-open:rotate-180"
            aria-hidden
          />
        </summary>
        <div className="border-t border-border">
          <RoleMatrix highlight={actorRole === 'member' ? undefined : actorRole} />
          <p className="px-5 py-3 text-micro leading-relaxed text-ink-faint">
            Para dar acceso de fundador, abre el menú de la persona y elige «Hacer cofundador».
            Siempre queda al menos un fundador, y cada cambio de fundadores se avisa por correo y
            queda en la auditoría.
          </p>
        </div>
      </details>

      <p className="mt-4 text-micro leading-relaxed text-ink-faint">
        La actividad sale de la auditoría de los últimos{' '}
        <span className="tabular">{WINDOW_DAYS}</span> días
        {activity.capped
          ? ` (con tope de ${AUDIT_ROW_CAP.toLocaleString()} eventos: en semanas cargadas verás un piso, no el total exacto)`
          : ''}
        {flaggedCount > 0
          ? ` · ${flaggedCount} ${flaggedCount === 1 ? 'persona tiene' : 'personas tienen'} algo marcado`
          : ' · nadie tiene nada marcado'}
        . Abre a una persona para ver su perfil completo.
      </p>

      {/*
        LO QUE HACE «A QUIÉN LE RESPONDE», DICHO DONDE SE CAMBIA.

        Poner un jefe no es una etiqueta: cambia a quién le escribe Cortex
        cuando alguien deja vencer algo. Un admin que no lo sepa está tomando
        una decisión sobre el correo de otra persona sin saberlo, así que se
        dice aquí y no en la documentación.
      */}
      <p className="mt-1 text-micro leading-relaxed text-ink-faint">
        A quién le responde cada quien decide{' '}
        <strong className="font-semibold text-ink-muted">a quién avisa Cortex</strong> cuando
        alguien deja vencer un compromiso y no contesta. Si el compromiso nombró a alguien, gana
        ese; si no, el jefe; y si tampoco hay jefe, el primer administrador.{' '}
        {unmanaged > 0 ? (
          <>
            Hoy <span className="tabular">{unmanaged}</span>{' '}
            {unmanaged === 1 ? 'persona no tiene' : 'personas no tienen'} jefe puesto, así que sus
            escalados caen todos en el mismo buzón.
          </>
        ) : (
          'Todo el mundo tiene jefe puesto.'
        )}{' '}
        La línea se ve entera en «Datos de la empresa», y la ve todo el equipo: nadie puede tener en
        Cortex un jefe que no pueda ver.
      </p>
    </>
  );
}
