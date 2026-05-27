import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { revalidatePath } from 'next/cache';

interface Team {
  id: string;
  name: string;
}

interface TeamMember {
  team_id: string;
  user_id: string;
}

async function createTeam(formData: FormData) {
  'use server';
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new Error('forbidden');
  const name = (formData.get('name') as string | null)?.trim();
  if (!name) return;
  const sb = getSupabaseServiceClient();
  await sb.from('teams').insert({ name });
  revalidatePath('/admin/teams');
}

export default async function TeamsPage() {
  const sb = getSupabaseServiceClient();

  const [{ data: teamsData }, { data: membersData }] = await Promise.all([
    sb.from('teams').select('id, name').order('name'),
    sb.from('team_members').select('team_id, user_id'),
  ]);

  const teams: Team[] = (teamsData ?? []) as Team[];
  const members: TeamMember[] = (membersData ?? []) as TeamMember[];

  const countByTeam = members.reduce<Record<string, number>>((acc, m) => {
    acc[m.team_id] = (acc[m.team_id] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Teams</h1>

      <div className="rounded-2xl border p-5">
        <h2 className="font-medium mb-3">Create team</h2>
        <form action={createTeam} className="flex items-center gap-2">
          <input
            name="name"
            placeholder="Team name"
            required
            className="rounded border bg-white dark:bg-neutral-900 px-3 py-2 text-sm flex-1 max-w-xs"
          />
          <button
            type="submit"
            className="rounded bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 px-4 py-2 text-sm hover:opacity-90"
          >
            Create
          </button>
        </form>
      </div>

      <div className="rounded-2xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 dark:bg-neutral-800">
            <tr className="text-left">
              <th className="px-4 py-3 font-medium text-neutral-500">Name</th>
              <th className="px-4 py-3 font-medium text-neutral-500">Members</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.id} className="border-t hover:bg-neutral-50 dark:hover:bg-neutral-900">
                <td className="px-4 py-3">{t.name}</td>
                <td className="px-4 py-3 text-neutral-500">{countByTeam[t.id] ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {teams.length === 0 && (
          <p className="px-4 py-6 text-sm text-neutral-500 text-center">No teams yet.</p>
        )}
      </div>
    </div>
  );
}
