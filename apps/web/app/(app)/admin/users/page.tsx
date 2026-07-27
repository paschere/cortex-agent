import Link from 'next/link';
import { clsx } from 'clsx';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { revalidatePath } from 'next/cache';
import { ChevronRight, Flag, Users } from 'lucide-react';
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

const ROLE_PILL: Record<Role, string> = {
  org_admin: 'bg-primary-soft text-primary-ink',
  team_admin: 'bg-sky-soft text-sky',
  member: 'bg-surface-2 text-ink-muted',
};

async function setUserRole(formData: FormData) {
  'use server';
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new Error('forbidden');
  const userId = formData.get('userId') as string;
  const role = formData.get('role') as Role;
  const sb = getSupabaseServiceClient();
  await sb.from('users').update({ role }).eq('id', userId);
  revalidatePath('/admin/users');
}

export default async function UsersPage() {
  const sb = getSupabaseServiceClient();

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
        title="Users"
        subtitle={`${users.length} member${users.length === 1 ? '' : 's'} · ${activeCount} active in the last ${WINDOW_DAYS} days`}
        icon={<Users className="h-5 w-5" />}
      />

      <Panel className="overflow-hidden">
        {users.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-ink-faint">No users found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead className="border-b border-border bg-surface-2/60">
                <tr className="text-left text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">
                  <th className="px-4 py-2.5 font-semibold">Teammate</th>
                  <th className="px-4 py-2.5 font-semibold">Role</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Tool calls · 7d</th>
                  <th className="px-4 py-2.5 font-semibold">Last active</th>
                  <th className="px-4 py-2.5 font-semibold">Flags</th>
                  <th className="px-4 py-2.5 font-semibold">Joined</th>
                  <th className="px-4 py-2.5 font-semibold">Role change</th>
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
                              <span className="block truncate text-[11px] text-ink-faint">
                                {u.email}
                              </span>
                            )}
                          </span>
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span
                          className={clsx(
                            'rounded-pill px-2 py-0.5 text-[10.5px] font-bold uppercase',
                            ROLE_PILL[u.role],
                          )}
                        >
                          {u.role.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        {a.calls7d > 0 ? (
                          <span className="font-semibold text-ink">
                            {a.calls7d.toLocaleString()}
                          </span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td
                        className="whitespace-nowrap px-4 py-3 text-ink-muted"
                        title={a.lastActive ? absoluteTime(a.lastActive) : undefined}
                      >
                        {a.lastActive ? (
                          relativeTime(a.lastActive)
                        ) : (
                          <span className="text-ink-faint">
                            Quiet for {WINDOW_DAYS}d+
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {a.flagged30d > 0 ? (
                          <Link
                            href={`/admin/users/${u.id}#security`}
                            className="inline-flex items-center gap-1 rounded-pill bg-rose-soft px-2 py-0.5 text-[10.5px] font-bold uppercase text-rose transition-opacity hover:opacity-80"
                            title={`${a.flagged30d} security event${a.flagged30d === 1 ? '' : 's'} in the last ${WINDOW_DAYS} days`}
                          >
                            <Flag className="h-3 w-3" />
                            {a.flagged30d} flagged
                          </Link>
                        ) : (
                          <span className="text-[11px] text-ink-faint">clear</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-ink-faint">
                        {new Date(u.created_at).toLocaleDateString()}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <form action={setUserRole} className="flex items-center gap-2">
                          <input type="hidden" name="userId" value={u.id} />
                          <select
                            name="role"
                            defaultValue={u.role}
                            className="rounded-[8px] border border-border bg-surface px-2 py-1 text-xs text-ink focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
                          >
                            <option value="member">member</option>
                            <option value="team_admin">team_admin</option>
                            <option value="org_admin">org_admin</option>
                          </select>
                          <button
                            type="submit"
                            className="rounded-pill bg-primary px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-primary-strong"
                          >
                            Save
                          </button>
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

      <p className="mt-2 text-[11px] text-ink-faint">
        Activity is read from the audit log over the last {WINDOW_DAYS} days
        {activity.capped
          ? ` (capped at ${AUDIT_ROW_CAP.toLocaleString()} events — busy weeks show a floor, not the exact total)`
          : ''}
        {flaggedCount > 0
          ? ` · ${flaggedCount} teammate${flaggedCount === 1 ? '' : 's'} with something flagged`
          : ' · nothing flagged for anyone'}
        . Open a teammate for their full profile.
      </p>
    </>
  );
}
