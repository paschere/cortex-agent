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
import { absoluteTime } from '../audit/_components/format';
import { AUDIT_ROW_CAP, fetchRosterActivity, rosterFor, WINDOW_DAYS } from './_lib/user-activity';

export const dynamic = 'force-dynamic';

type Role = 'member' | 'team_admin' | 'org_admin';

interface User {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  created_at: string;
}

/** Roles as a person would name them, not as the column stores them. */
const ROLE_LABEL: Record<Role, string> = {
  org_admin: 'Admin de la organización',
  team_admin: 'Admin de equipo',
  member: 'Miembro',
};

const ROLE_TAG: Record<Role, string> = {
  org_admin: 'border-primary/30 bg-primary-soft text-primary-ink',
  team_admin: 'border-sky/40 bg-sky-soft text-sky',
  member: 'border-border bg-surface-2 text-ink-muted',
};

async function setUserRole(formData: FormData) {
  'use server';
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new Error('forbidden');
  const userId = formData.get('userId') as string;
  const role = formData.get('role') as Role;
  const sb = getOrgScopedClient(user.organization.id);
  await sb.from('users').update({ role }).eq('id', userId);
  revalidatePath('/admin/users');
}

export default async function UsersPage() {
  const user = await requireSession();
  const sb = getOrgScopedClient(user.organization.id);

  // Two reads for the whole roster — never one per user. See _lib/user-activity.
  const [{ data }, activity] = await Promise.all([
    sb.from('users').select('id, email, name, role, created_at').order('created_at'),
    fetchRosterActivity(sb),
  ]);

  const users: User[] = (data ?? []) as User[];
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
            <p className="text-[13px] font-semibold text-ink">Todavía no hay nadie registrado</p>
            <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-ink-muted">
              Las personas aparecen aquí la primera vez que entran a Cortex con su cuenta de Google.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead className="border-b border-border-strong bg-surface-2">
                <tr className="text-left">
                  <th className="field-label px-4 py-2.5">Persona</th>
                  <th className="field-label px-4 py-2.5">Rol</th>
                  <th className="field-label px-4 py-2.5 text-right">Llamadas · 7d</th>
                  <th className="field-label px-4 py-2.5">Última actividad</th>
                  <th className="field-label px-4 py-2.5">Marcas</th>
                  <th className="field-label px-4 py-2.5">Ingresó</th>
                  <th className="field-label px-4 py-2.5">Cambiar el rol</th>
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
                              <span className="tabular block truncate text-[11px] text-ink-faint">
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
                            'rounded-pill border px-2 py-0.5 text-[11px] font-semibold',
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
                            className="inline-flex items-center gap-1 rounded-pill border border-rose/40 bg-rose-soft px-2 py-0.5 font-mono text-[10px] font-semibold text-rose transition-all duration-150 hover:-translate-y-px hover:opacity-90 motion-reduce:transform-none motion-reduce:transition-none"
                            title={`${a.flagged30d} evento${a.flagged30d === 1 ? '' : 's'} de seguridad en los últimos ${WINDOW_DAYS} días`}
                          >
                            <Flag className="h-3 w-3" />
                            {a.flagged30d} marcados
                          </Link>
                        ) : (
                          <span className="text-[11px] text-ink-faint">sin marcas</span>
                        )}
                      </td>
                      <td className="tabular whitespace-nowrap px-4 py-3 text-xs text-ink-faint">
                        {new Date(u.created_at).toLocaleDateString('es-CO')}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <form action={setUserRole} className="flex items-center gap-2">
                          <input type="hidden" name="userId" value={u.id} />
                          <select
                            name="role"
                            defaultValue={u.role}
                            aria-label={`Rol de ${u.name || u.email}`}
                            className="rounded-sm border border-border bg-surface px-2 py-1 text-xs text-ink transition-colors focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
                          >
                            <option value="member">{ROLE_LABEL.member}</option>
                            <option value="team_admin">{ROLE_LABEL.team_admin}</option>
                            <option value="org_admin">{ROLE_LABEL.org_admin}</option>
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

      <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
        La actividad sale de la auditoría de los últimos <span className="tabular">{WINDOW_DAYS}</span>{' '}
        días
        {activity.capped
          ? ` (con tope de ${AUDIT_ROW_CAP.toLocaleString()} eventos: en semanas cargadas verás un piso, no el total exacto)`
          : ''}
        {flaggedCount > 0
          ? ` · ${flaggedCount} ${flaggedCount === 1 ? 'persona tiene' : 'personas tienen'} algo marcado`
          : ' · nadie tiene nada marcado'}
        . Abre a una persona para ver su perfil completo.
      </p>
    </>
  );
}
