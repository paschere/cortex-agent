import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { revalidatePath } from 'next/cache';

type Role = 'member' | 'team_admin' | 'org_admin';

interface User {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  created_at: string;
}

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
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Users</h1>
      <div className="rounded-2xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 dark:bg-neutral-800">
            <tr className="text-left">
              <th className="px-4 py-3 font-medium text-neutral-500">Email</th>
              <th className="px-4 py-3 font-medium text-neutral-500">Name</th>
              <th className="px-4 py-3 font-medium text-neutral-500">Role</th>
              <th className="px-4 py-3 font-medium text-neutral-500">Joined</th>
              <th className="px-4 py-3 font-medium text-neutral-500">Action</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t hover:bg-neutral-50 dark:hover:bg-neutral-900">
                <td className="px-4 py-3">{u.email}</td>
                <td className="px-4 py-3 text-neutral-500">{u.name ?? '—'}</td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-xs font-medium">
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-3 text-neutral-500 text-xs">
                  {new Date(u.created_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <form action={setUserRole} className="flex items-center gap-2">
                    <input type="hidden" name="userId" value={u.id} />
                    <select
                      name="role"
                      defaultValue={u.role}
                      className="rounded border bg-white dark:bg-neutral-900 px-2 py-1 text-xs"
                    >
                      <option value="member">member</option>
                      <option value="team_admin">team_admin</option>
                      <option value="org_admin">org_admin</option>
                    </select>
                    <button
                      type="submit"
                      className="rounded bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 px-2 py-1 text-xs hover:opacity-90"
                    >
                      Save
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && (
          <p className="px-4 py-6 text-sm text-neutral-500 text-center">No users found.</p>
        )}
      </div>
    </div>
  );
}
