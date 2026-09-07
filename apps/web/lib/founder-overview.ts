import 'server-only';

import { bogotaToday, deriveState } from '@cortex/agent-tools';
import type { ActiveOrganization } from '@cortex/core';
import { getOrgScopedClient } from './supabase/service';

export interface WorkspacePulse {
  workspace: ActiveOrganization;
  approvals: number;
  actions: number;
  deadlines: number | null;
  blocked: number | null;
  status: 'ready' | 'unavailable';
}

export interface FounderOverviewData {
  workspaces: WorkspacePulse[];
  totals: { approvals: number; actions: number; deadlines: number; blocked: number };
  unavailable: number;
}

const EMPTY = { approvals: 0, actions: 0, deadlines: 0, blocked: 0 };

async function exact(result: PromiseLike<{ count: number | null; error: unknown }>) {
  const read = await result;
  if (read.error) throw read.error;
  return read.count ?? 0;
}

/** `workspace` comes only from listMemberships; browser ids never reach here. */
async function readWorkspace(
  workspace: ActiveOrganization,
  email: string,
): Promise<WorkspacePulse> {
  try {
    const db = getOrgScopedClient(workspace.id);
    const directory = await db.from('users').select('id').eq('email', email).maybeSingle();
    if (directory.error) throw directory.error;
    const userId = (directory.data?.id as string | undefined) ?? null;
    const now = new Date().toISOString();
    const today = bogotaToday();
    const horizon = new Date(`${today}T00:00:00Z`);
    horizon.setUTCDate(horizon.getUTCDate() + 120);

    const maySeeCompanyWide = workspace.role === 'owner' || workspace.role === 'admin';
    const [approvals, actions, commitments, blocked] = await Promise.all([
      userId
        ? exact(
            db
              .from('mcp_pending_actions')
              .select('id', { count: 'exact', head: true })
              .eq('user_id', userId)
              .is('decision', null)
              .gt('expires_at', now),
          )
        : Promise.resolve(0),
      userId
        ? exact(
            db
              .from('actions')
              .select('id', { count: 'exact', head: true })
              .eq('user_id', userId)
              .eq('state', 'proposed')
              .gt('expires_at', now),
          )
        : Promise.resolve(0),
      maySeeCompanyWide
        ? db
            .from('commitments')
            .select('due_on,notice_days,state')
            .eq('review_state', 'confirmed')
            .not('state', 'in', '(met,dropped)')
            .lte('due_on', horizon.toISOString().slice(0, 10))
            .limit(500)
        : Promise.resolve({ data: null, error: null }),
      maySeeCompanyWide
        ? exact(
            db.from('errands').select('id', { count: 'exact', head: true }).eq('state', 'blocked'),
          )
        : Promise.resolve(null),
    ]);
    if (commitments.error) throw commitments.error;
    const deadlines = maySeeCompanyWide
      ? (commitments.data ?? []).filter((row) => {
          const state = deriveState(
            row as { due_on: string; notice_days: number | null; state: string },
            today,
          );
          return state === 'overdue' || state === 'due_soon';
        }).length
      : null;

    return { workspace, approvals, actions, deadlines, blocked, status: 'ready' };
  } catch {
    return { workspace, ...EMPTY, status: 'unavailable' };
  }
}

export async function readFounderOverview(
  memberships: ActiveOrganization[],
  email: string,
): Promise<FounderOverviewData> {
  const workspaces = await Promise.all(
    memberships.map((workspace) => readWorkspace(workspace, email)),
  );
  const totals = workspaces.reduce(
    (sum, item) =>
      item.status === 'ready'
        ? {
            approvals: sum.approvals + item.approvals,
            actions: sum.actions + item.actions,
            deadlines: sum.deadlines + (item.deadlines ?? 0),
            blocked: sum.blocked + (item.blocked ?? 0),
          }
        : sum,
    { ...EMPTY },
  );
  return {
    workspaces,
    totals,
    unavailable: workspaces.filter((item) => item.status === 'unavailable').length,
  };
}
