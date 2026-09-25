import { InviteTeam } from '@/components/team/InviteTeam';
import { PendingInvitations } from '@/components/team/PendingInvitations';
import { RemoveMemberDialog } from '@/components/team/RemoveMemberDialog';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelHead } from '@/components/ui/panel';
import { auth } from '@/lib/auth';
import { normalizeMembershipRole } from '@/lib/founder-rules';
import { relativeTime } from '@/lib/relative-time';
import { requireSession } from '@/lib/session';
import { mustReadList } from '@/lib/supabase/read';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { listPendingInvitations } from '@/lib/team/invitations';
import {
  changeMemberRole,
  listCompanyMembers,
  memberIdForDirectoryUser,
} from '@/lib/team/membership-admin';
import {
  managerMapOf,
  readSeats,
  readWorkspacePlan,
  setManager,
  wouldCycle,
} from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { ChevronRight, Flag, UserPlus, Users } from 'lucide-react';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import Link from 'next/link';
import { absoluteTime } from '../audit/_components/format';
import { countdown } from './_lib/countdown';
import { AUDIT_ROW_CAP, WINDOW_DAYS, fetchRosterActivity, rosterFor } from './_lib/user-activity';
import { cancelInvitationAction, removeMemberAction } from './actions';

export const dynamic = 'force-dynamic';

type Role = 'member' | 'team_admin' | 'org_admin';

interface User {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  manager_id: string | null;
  created_at: string;
}

/** Valor del desplegable para «no le responde a nadie». Vacío no viaja bien. */
const NO_MANAGER = '__nadie__';

/** Roles as a person would name them, not as the column stores them. */
const ROLE_LABEL: Record<Role, string> = {
  org_admin: 'Admin de la organización',
  team_admin: 'Admin de equipo',
  member: 'Miembro',
};

/**
 * Los dos desplegables de la fila, en una constante y no copiados.
 *
 * Son dos controles que tienen que leerse como un solo bloque: en cuanto las
 * clases se duplican, uno de los dos se queda con el borde viejo y la fila se
 * parte por una diferencia que nadie sabe de dónde sale.
 */
const SELECT_CLASS =
  'rounded-sm border border-border bg-surface px-2 py-1 text-xs text-ink transition-colors focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10';

const ROLES: readonly Role[] = ['member', 'team_admin', 'org_admin'];

/**
 * Lo que dice la etiqueta de la fila. Además de los tres roles del directorio,
 * dos estados que salen de `ba_member`: el fundador (que el directorio llama
 * `org_admin` igual que a un admin) y quien ya no tiene acceso — su fila del
 * directorio se conserva a propósito (0138) para que el historial siga
 * diciendo quién hizo qué.
 */
type Standing = Role | 'owner' | 'removed';

const STANDING_LABEL: Record<Standing, string> = {
  ...ROLE_LABEL,
  owner: 'Fundador',
  removed: 'Sin acceso',
};

const ROLE_TAG: Record<Standing, string> = {
  owner: 'border-primary/40 bg-primary-soft text-primary-ink',
  org_admin: 'border-primary/30 bg-primary-soft text-primary-ink',
  team_admin: 'border-sky/40 bg-sky-soft text-sky',
  member: 'border-border bg-surface-2 text-ink-muted',
  removed: 'border-rose/30 bg-rose-soft text-rose',
};

/**
 * El rol y el jefe se guardan JUNTOS, en un solo formulario por fila.
 *
 * No es un atajo de maquetación: son las dos cosas que definen la posición de
 * alguien aquí dentro, y dos botones «Guardar» pegados en la misma fila hacen
 * que uno de los dos se pulse por error y el otro se olvide. Una fila, una
 * decisión, un guardado.
 *
 * EL ROL ANTES NO DURABA. Esto escribía sólo `public.users.role`, y
 * `resolveSessionDirectory` lo recalcula desde `ba_member.role` en CADA
 * petición: ascender a alguien a admin de la organización se deshacía en su
 * siguiente clic, y quitárselo también. Ahora el rol pasa por
 * `changeMemberRole` (lib/team/membership-admin.ts), que cambia primero la
 * membresía con better-auth y después el directorio, con las reglas de
 * lib/founder-rules.ts: un admin no toca a un fundador, nadie deja a la
 * empresa sin fundador y nadie se cambia el rol a sí mismo desde aquí. Es la
 * misma función que usa la consola del fundador.
 *
 * El jefe sigue por `setManager`, que es el ÚNICO sitio del producto que
 * escribe `users.manager_id` y el que comprueba que las dos personas son de
 * este espacio y que la línea no se muerde la cola.
 */
async function setUserPosition(formData: FormData) {
  'use server';
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new Error('forbidden');
  const userId = formData.get('userId') as string;
  const submitted = formData.get('role');
  const chosen = formData.get('managerId') as string;
  const managerId = !chosen || chosen === NO_MANAGER ? null : chosen;

  const sb = getOrgScopedClient(user.organization.id);
  // El desplegable de rol va deshabilitado en las filas de fundadores, en la
  // propia y en las de quien ya no tiene acceso, y un control deshabilitado no
  // viaja en el formulario: sin `role`, sólo se guarda el jefe.
  const role = ROLES.find((candidate) => candidate === submitted) ?? null;
  if (role) {
    const { data: current, error } = await sb
      .from('users')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw new Error(`No se pudo leer a esa persona: ${error.message}`);
    if (!current) throw new Error('Esa persona no es de este espacio.');
    if ((current as { role: Role }).role !== role) {
      const requestHeaders = await headers();
      const accountId = (await auth.api.getSession({ headers: requestHeaders }))?.user?.id;
      const memberId = await memberIdForDirectoryUser(user.organization.id, userId);
      if (!accountId || !memberId) throw new Error('Esa persona ya no está en la empresa.');
      const result = await changeMemberRole({
        organizationId: user.organization.id,
        workspaceKind: user.organization.kind ?? 'company',
        actorAccountId: accountId,
        actorRole: user.organization.role,
        memberId,
        next: role,
        requestHeaders,
      });
      if (!result.ok && result.reason !== 'unchanged') throw new Error(result.message);
    }
  }
  await setManager(sb, { userId, managerId });
  revalidatePath('/admin/users');
  revalidatePath('/company');
}

export default async function UsersPage() {
  const user = await requireSession();
  const sb = getOrgScopedClient(user.organization.id);

  /**
   * INVITAR VIVE AQUÍ DESDE AHORA, Y NO SÓLO EN EL ONBOARDING.
   *
   * Antes el formulario salía únicamente mientras el paso «trae a tu equipo»
   * estuviera sin hacer, así que en cuanto entraba la segunda persona la única
   * forma de invitar a la tercera desaparecía del producto entero. Ésta es la
   * pantalla donde está la gente, así que es donde se agrega gente.
   *
   * Los asientos son los de verdad —`readSeats`, el mismo cálculo que defiende
   * `POST /api/team/invite`— y no una cuenta aparte: un formulario que dice que
   * caben tres personas y una ruta que rechaza la segunda es peor que no decir
   * nada.
   */
  const { plan, contractedSeats } = await readWorkspacePlan(sb);

  // Cuatro lecturas para toda la pantalla, nunca una por persona. Ver _lib/user-activity.
  const [roster, activity, seats, invitations, memberships] = await Promise.all([
    sb.from('users').select('id, email, name, role, manager_id, created_at').order('created_at'),
    fetchRosterActivity(sb),
    readSeats(sb, user.organization.id, plan, contractedSeats),
    listPendingInvitations(sb, user.organization.id),
    // La membresía de better-auth de cada fila: dice quién es fundador y quién
    // ya salió, que el directorio solo no sabe decir.
    listCompanyMembers([user.organization.id]),
  ]);
  const membershipOf = new Map(
    memberships.map((row) => [row.email.toLowerCase(), normalizeMembershipRole(row.role)]),
  );
  const standingOf = (u: User): Standing => {
    const membership = membershipOf.get(u.email.toLowerCase());
    if (!membership) return 'removed';
    return membership === 'owner' ? 'owner' : u.role;
  };
  const actorIsOwner = user.organization.role === 'owner';
  const companyName = user.organization.name;

  // `mustReadList` y no `?? []`: con el estado vacío reescrito abajo, una base
  // caída diría «todavía no hay nadie registrado» en un espacio lleno de gente.
  const users: User[] = mustReadList<User>(roster, 'las personas de este espacio');
  const managers = managerMapOf(users.map((u) => ({ id: u.id, managerId: u.manager_id })));
  const label = (u: User) => u.name?.trim() || u.email;
  const unmanaged = users.filter((u) => !u.manager_id).length;

  /**
   * A quién puede tener de jefe esta persona.
   *
   * Las opciones que cerrarían un círculo NO SE OFRECEN, en vez de ofrecerse y
   * fallar al guardar. Un desplegable que acepta una elección y luego la rechaza
   * enseña a desconfiar del desplegable; y la regla que decide cuáles caben es
   * la misma función pura que defiende la base de datos, no una copia.
   */
  const options = (u: User) =>
    users
      .filter((other) => other.id !== u.id && !wouldCycle(managers, u.id, other.id))
      .sort((a, b) => label(a).localeCompare(label(b), 'es'));
  const activeCount = users.filter((u) => rosterFor(activity, u.id).lastActive).length;
  const flaggedCount = users.filter((u) => rosterFor(activity, u.id).flagged30d > 0).length;

  return (
    <>
      <PageHeader
        title="Personas"
        subtitle={`${users.length} en la organización · ${activeCount} con actividad en los últimos ${WINDOW_DAYS} días${
          invitations.length > 0
            ? ` · ${invitations.length} ${invitations.length === 1 ? 'invitación' : 'invitaciones'} sin aceptar`
            : ''
        }`}
        icon={<Users className="h-5 w-5" />}
      />

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
              LO QUE DECÍA ANTES ERA FALSO: «las personas aparecen aquí la primera
              vez que entran a Cortex con su cuenta de Google». Ni es la única
              forma de entrar —hay correo y contraseña— ni es la que trae a nadie
              a ESTE espacio: quien se registra por su cuenta crea el suyo. A este
              espacio se entra aceptando una invitación, que es justo lo que hay
              en el panel de arriba. Un estado vacío que explica mal cómo se llena
              deja a alguien esperando algo que no va a pasar solo.
            */}
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-ink-muted">
              A este espacio se entra por invitación. Escribe un correo arriba: le llega un enlace
              que dura 48 horas y, en cuanto lo acepte, la persona aparece en esta tabla.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-border-strong bg-surface-2">
                <tr className="text-left">
                  <th className="field-label px-4 py-2.5">Persona</th>
                  <th className="field-label px-4 py-2.5">Rol</th>
                  <th className="field-label px-4 py-2.5 text-right">Llamadas · 7d</th>
                  <th className="field-label px-4 py-2.5">Última actividad</th>
                  <th className="field-label px-4 py-2.5">Marcas</th>
                  <th className="field-label px-4 py-2.5">Ingresó</th>
                  <th className="field-label px-4 py-2.5">Rol y a quién le responde</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const a = rosterFor(activity, u.id);
                  const standing = standingOf(u);
                  const self = u.id === user.id;
                  // Fundadores, uno mismo y quien ya salió no cambian de rol
                  // aquí; ver la cabecera de `setUserPosition`.
                  const roleLocked = self || standing === 'owner' || standing === 'removed';
                  const mayRemove =
                    !self && standing !== 'removed' && (standing !== 'owner' || actorIsOwner);
                  return (
                    <tr key={u.id} className="border-t border-border hover:bg-surface-2/40">
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/users/${u.id}`}
                          className="group flex items-center gap-2"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-semibold text-ink group-hover:text-primary">
                              {u.name || u.email}
                            </span>
                            {u.name && (
                              <span className="tabular block truncate text-micro text-ink-faint">
                                {u.email}
                              </span>
                            )}
                          </span>
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-primary motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span
                          className={clsx(
                            'rounded-pill border px-2 py-0.5 text-micro font-semibold',
                            ROLE_TAG[standingOf(u)],
                          )}
                        >
                          {STANDING_LABEL[standingOf(u)]}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        {a.calls7d > 0 ? (
                          <span className="tabular font-semibold text-ink">
                            {a.calls7d.toLocaleString()}
                          </span>
                        ) : (
                          <span className="tabular text-ink-faint">—</span>
                        )}
                      </td>
                      <td
                        className="tabular whitespace-nowrap px-4 py-3 text-ink-muted"
                        title={a.lastActive ? absoluteTime(a.lastActive) : undefined}
                      >
                        {a.lastActive ? (
                          relativeTime(a.lastActive)
                        ) : (
                          <span className="text-ink-faint">Sin actividad hace {WINDOW_DAYS}d+</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {a.flagged30d > 0 ? (
                          <Link
                            href={`/admin/users/${u.id}#security`}
                            className="inline-flex items-center gap-1 rounded-pill border border-rose/40 bg-rose-soft px-2 py-0.5 font-mono text-micro font-semibold text-rose transition-all duration-150 hover:-translate-y-px hover:opacity-90 motion-reduce:transform-none motion-reduce:transition-none"
                            title={`${a.flagged30d} evento${a.flagged30d === 1 ? '' : 's'} de seguridad en los últimos ${WINDOW_DAYS} días`}
                          >
                            <Flag className="h-3 w-3" />
                            {a.flagged30d} marcados
                          </Link>
                        ) : (
                          <span className="text-micro text-ink-faint">sin marcas</span>
                        )}
                      </td>
                      <td className="tabular whitespace-nowrap px-4 py-3 text-xs text-ink-faint">
                        {new Date(u.created_at).toLocaleDateString('es-CO')}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <div className="flex items-center gap-2">
                          <form action={setUserPosition} className="flex items-center gap-2">
                            <input type="hidden" name="userId" value={u.id} />
                            <select
                              name="role"
                              defaultValue={standing === 'owner' ? 'owner' : u.role}
                              disabled={roleLocked}
                              aria-label={`Rol de ${label(u)}`}
                              title={
                                self
                                  ? 'Tu propio rol lo cambia otro administrador'
                                  : standing === 'owner'
                                    ? 'La propiedad de la empresa no se cambia desde aquí'
                                    : undefined
                              }
                              className={clsx(SELECT_CLASS, 'disabled:opacity-60')}
                            >
                              {standing === 'owner' && <option value="owner">Fundador</option>}
                              <option value="member">{ROLE_LABEL.member}</option>
                              <option value="team_admin">{ROLE_LABEL.team_admin}</option>
                              <option value="org_admin">{ROLE_LABEL.org_admin}</option>
                            </select>
                            <select
                              name="managerId"
                              defaultValue={u.manager_id ?? NO_MANAGER}
                              aria-label={`A quién le responde ${label(u)}`}
                              className={SELECT_CLASS}
                            >
                              <option value={NO_MANAGER}>A nadie</option>
                              {options(u).map((other) => (
                                <option key={other.id} value={other.id}>
                                  {label(other)}
                                </option>
                              ))}
                            </select>
                            <Button type="submit" variant="outline">
                              Guardar
                            </Button>
                          </form>
                          {mayRemove && (
                            <RemoveMemberDialog
                              compact
                              personLabel={label(u)}
                              companyName={companyName}
                              onConfirm={removeMemberAction.bind(null, u.id)}
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="mt-2 text-micro leading-relaxed text-ink-faint">
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
        LO QUE HACE LA COLUMNA NUEVA, DICHO DONDE SE CAMBIA.

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
