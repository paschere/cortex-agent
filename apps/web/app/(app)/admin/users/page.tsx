import Link from 'next/link';
import { clsx } from 'clsx';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { revalidatePath } from 'next/cache';
import { ChevronRight, Flag, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
import { managerMapOf, setManager, wouldCycle } from '@cortex/agent-tools';
import { absoluteTime } from '../audit/_components/format';
import { AUDIT_ROW_CAP, fetchRosterActivity, rosterFor, WINDOW_DAYS } from './_lib/user-activity';

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

const ROLE_TAG: Record<Role, string> = {
  org_admin: 'border-primary/30 bg-primary-soft text-primary-ink',
  team_admin: 'border-sky/40 bg-sky-soft text-sky',
  member: 'border-border bg-surface-2 text-ink-muted',
};

/**
 * El rol y el jefe se guardan JUNTOS, en un solo formulario por fila.
 *
 * No es un atajo de maquetación: son las dos cosas que definen la posición de
 * alguien aquí dentro, y dos botones «Guardar» pegados en la misma fila hacen
 * que uno de los dos se pulse por error y el otro se olvide. Una fila, una
 * decisión, un guardado.
 *
 * Los dos cambios pasan por su propia puerta: el rol por este `update` y el jefe
 * por `setManager`, que es el ÚNICO sitio del producto que escribe
 * `users.manager_id` y el que comprueba que las dos personas son de este espacio
 * y que la línea no se muerde la cola.
 */
async function setUserPosition(formData: FormData) {
  'use server';
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new Error('forbidden');
  const userId = formData.get('userId') as string;
  const role = formData.get('role') as Role;
  const chosen = formData.get('managerId') as string;
  const managerId = !chosen || chosen === NO_MANAGER ? null : chosen;

  const sb = getOrgScopedClient(user.organization.id);
  const { error } = await sb.from('users').update({ role }).eq('id', userId);
  if (error) throw new Error(`No se pudo cambiar el rol: ${error.message}`);
  await setManager(sb, { userId, managerId });
  revalidatePath('/admin/users');
  revalidatePath('/company');
}

export default async function UsersPage() {
  const user = await requireSession();
  const sb = getOrgScopedClient(user.organization.id);

  // Two reads for the whole roster — never one per user. See _lib/user-activity.
  const [{ data }, activity] = await Promise.all([
    sb.from('users').select('id, email, name, role, manager_id, created_at').order('created_at'),
    fetchRosterActivity(sb),
  ]);

  const users: User[] = (data ?? []) as User[];
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
        subtitle={`${users.length} en la organización · ${activeCount} con actividad en los últimos ${WINDOW_DAYS} días`}
        icon={<Users className="h-5 w-5" />}
      />

      <Panel className="overflow-hidden">
        {users.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <Users className="mx-auto mb-3 h-6 w-6 text-ink-faint" />
            <p className="text-sm font-semibold text-ink">Todavía no hay nadie registrado</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-ink-muted">
              Las personas aparecen aquí la primera vez que entran a Cortex con su cuenta de Google.
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
                            ROLE_TAG[u.role],
                          )}
                        >
                          {ROLE_LABEL[u.role]}
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
                        <form action={setUserPosition} className="flex items-center gap-2">
                          <input type="hidden" name="userId" value={u.id} />
                          <select
                            name="role"
                            defaultValue={u.role}
                            aria-label={`Rol de ${label(u)}`}
                            className={SELECT_CLASS}
                          >
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
