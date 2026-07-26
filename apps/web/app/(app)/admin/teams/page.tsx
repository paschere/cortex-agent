import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { revalidatePath } from 'next/cache';
import { UsersRound } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, Eyebrow } from '@/components/ui/panel';

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
    <>
      <PageHeader
        title="Teams"
        subtitle={`${teams.length} team${teams.length === 1 ? '' : 's'} in your workspace`}
        icon={<UsersRound className="h-5 w-5" />}
      />

      <div className="space-y-4">
        <Panel className="p-5">
          <Eyebrow>Create team</Eyebrow>
          <form action={createTeam} className="mt-3 flex items-center gap-2">
            <input
              name="name"
              placeholder="Team name"
              required
              className="max-w-xs flex-1 rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
            />
            <button
              type="submit"
              className="rounded-pill bg-primary px-4 py-2 text-[13px] font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong"
            >
              Create
            </button>
          </form>
        </Panel>

        <Panel className="overflow-hidden">
          {teams.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-ink-faint">No teams yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead className="border-b border-border bg-surface-2/60">
                  <tr className="text-left text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">
                    <th className="px-4 py-2.5 font-semibold">Name</th>
                    <th className="px-4 py-2.5 font-semibold">Members</th>
                  </tr>
                </thead>
                <tbody>
                  {teams.map((t) => (
                    <tr key={t.id} className="border-t border-border hover:bg-surface-2/40">
                      <td className="whitespace-nowrap px-4 py-3 font-semibold text-ink">{t.name}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-ink-muted">
                        {countByTeam[t.id] ?? 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
