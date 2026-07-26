import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { revalidatePath } from 'next/cache';
import { Users } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';

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
  const { data } = await sb
    .from('users')
    .select('id, email, name, role, created_at')
    .order('created_at');

  const users: User[] = (data ?? []) as User[];

  return (
    <>
      <PageHeader
        title="Users"
        subtitle={`${users.length} member${users.length === 1 ? '' : 's'} in your workspace`}
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
                  <th className="px-4 py-2.5 font-semibold">Email</th>
                  <th className="px-4 py-2.5 font-semibold">Name</th>
                  <th className="px-4 py-2.5 font-semibold">Role</th>
                  <th className="px-4 py-2.5 font-semibold">Joined</th>
                  <th className="px-4 py-2.5 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-border hover:bg-surface-2/40">
                    <td className="whitespace-nowrap px-4 py-3 font-semibold text-ink">{u.email}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-muted">{u.name ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span
                        className={`rounded-pill px-2 py-0.5 text-[10.5px] font-bold uppercase ${ROLE_PILL[u.role]}`}
                      >
                        {u.role.replace('_', ' ')}
                      </span>
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
