import Link from 'next/link';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { revalidatePath } from 'next/cache';
import { ShieldBan, UserMinus, UserPlus, Users2, UsersRound } from 'lucide-react';
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

interface WorkspaceUser {
  id: string;
  name: string | null;
  email: string;
  role: string;
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

async function addTeamMember(formData: FormData) {
  'use server';
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new Error('forbidden');
  const teamId = (formData.get('teamId') as string | null)?.trim();
  const userId = (formData.get('userId') as string | null)?.trim();
  if (!teamId || !userId) return;
  const sb = getSupabaseServiceClient();
  await sb.from('team_members').upsert({ team_id: teamId, user_id: userId }, {
    onConflict: 'team_id,user_id',
  });
  revalidatePath('/admin/teams');
}

async function removeTeamMember(formData: FormData) {
  'use server';
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new Error('forbidden');
  const teamId = (formData.get('teamId') as string | null)?.trim();
  const userId = (formData.get('userId') as string | null)?.trim();
  if (!teamId || !userId) return;
  const sb = getSupabaseServiceClient();
  await sb.from('team_members').delete().eq('team_id', teamId).eq('user_id', userId);
  revalidatePath('/admin/teams');
}

export default async function TeamsPage() {
  const sb = getSupabaseServiceClient();

  const [{ data: teamsData }, { data: membersData }, { data: usersData }, { data: permsData }] =
    await Promise.all([
      sb.from('teams').select('id, name').order('name'),
      sb.from('team_members').select('team_id, user_id'),
      sb.from('users').select('id, name, email, role').order('email'),
      sb.from('team_tool_permissions').select('team_id').eq('allowed', false),
    ]);

  const teams: Team[] = (teamsData ?? []) as Team[];
  const members: TeamMember[] = (membersData ?? []) as TeamMember[];
  const users: WorkspaceUser[] = (usersData ?? []) as WorkspaceUser[];
  const perms = (permsData ?? []) as { team_id: string }[];

  const usersById = new Map(users.map((u) => [u.id, u]));

  const membersByTeam = members.reduce<Record<string, WorkspaceUser[]>>((acc, m) => {
    const u = usersById.get(m.user_id);
    if (!u) return acc;
    (acc[m.team_id] ??= []).push(u);
    return acc;
  }, {});

  const restrictionsByTeam = perms.reduce<Record<string, number>>((acc, p) => {
    acc[p.team_id] = (acc[p.team_id] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <PageHeader
        title="Teams"
        subtitle={`${teams.length} team${teams.length === 1 ? '' : 's'} in your workspace — membership drives tool access`}
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

        {teams.length === 0 ? (
          <Panel className="p-8 text-center text-[13px] text-ink-faint">No teams yet.</Panel>
        ) : (
          teams.map((team) => {
            const teamMembers = (membersByTeam[team.id] ?? []).sort((a, b) =>
              (a.name ?? a.email).localeCompare(b.name ?? b.email),
            );
            const memberIds = new Set(teamMembers.map((u) => u.id));
            const candidates = users.filter((u) => !memberIds.has(u.id));
            const restrictions = restrictionsByTeam[team.id] ?? 0;

            return (
              <Panel key={team.id} className="overflow-hidden">
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2/60 px-4 py-3">
                  <span className="text-[13.5px] font-semibold text-ink">{team.name}</span>
                  <span className="inline-flex items-center gap-1 rounded-pill bg-surface-2 px-2.5 py-0.5 text-[10.5px] font-semibold text-ink-muted">
                    <Users2 className="h-3 w-3" />
                    {teamMembers.length} member{teamMembers.length === 1 ? '' : 's'}
                  </span>
                  <Link
                    href={`/tools?team=${team.id}`}
                    className={
                      restrictions > 0
                        ? 'inline-flex items-center gap-1 rounded-pill bg-rose-soft px-2.5 py-0.5 text-[10.5px] font-semibold text-rose transition-opacity hover:opacity-80'
                        : 'inline-flex items-center gap-1 rounded-pill bg-surface-2 px-2.5 py-0.5 text-[10.5px] font-semibold text-ink-faint transition-colors hover:text-ink'
                    }
                  >
                    <ShieldBan className="h-3 w-3" />
                    {restrictions} tool restriction{restrictions === 1 ? '' : 's'}
                  </Link>
                </div>

                <div className="px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                    Members
                  </div>
                  {teamMembers.length === 0 ? (
                    <p className="mt-2 text-[12.5px] text-ink-faint">
                      No members yet — add someone below.
                    </p>
                  ) : (
                    <ul className="mt-2 divide-y divide-border">
                      {teamMembers.map((u) => (
                        <li key={u.id} className="flex items-center gap-3 py-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-semibold text-ink">
                              {u.name || u.email}
                            </div>
                            {u.name && (
                              <div className="truncate text-[11.5px] text-ink-faint">{u.email}</div>
                            )}
                          </div>
                          <span className="shrink-0 rounded-pill bg-surface-2 px-2 py-0.5 text-[10.5px] font-semibold text-ink-muted">
                            {u.role}
                          </span>
                          <form action={removeTeamMember} className="shrink-0">
                            <input type="hidden" name="teamId" value={team.id} />
                            <input type="hidden" name="userId" value={u.id} />
                            <button
                              type="submit"
                              className="inline-flex items-center gap-1 rounded-pill border border-border px-2.5 py-1 text-[11.5px] font-semibold text-ink-muted transition-colors hover:border-rose hover:text-rose"
                            >
                              <UserMinus className="h-3 w-3" />
                              Remove
                            </button>
                          </form>
                        </li>
                      ))}
                    </ul>
                  )}

                  <form
                    action={addTeamMember}
                    className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3"
                  >
                    <input type="hidden" name="teamId" value={team.id} />
                    <select
                      name="userId"
                      required
                      defaultValue=""
                      disabled={candidates.length === 0}
                      className="min-w-[240px] rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10 disabled:opacity-50"
                    >
                      <option value="" disabled>
                        {candidates.length === 0
                          ? 'Everyone is already on this team'
                          : 'Select a teammate…'}
                      </option>
                      {candidates.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name ? `${u.name} (${u.email})` : u.email}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      disabled={candidates.length === 0}
                      className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-[13px] font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong disabled:opacity-50"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                      Add member
                    </button>
                  </form>
                </div>
              </Panel>
            );
          })
        )}
      </div>
    </>
  );
}
