import { readMissionProgress } from '@/lib/management/mission-progress-store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday, readManagement } from '@cortex/agent-tools';
import { MissionWorkspace } from './workspace';
export const dynamic = 'force-dynamic';
export default async function MissionPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const [board, mission] = await Promise.all([
    readManagement(db),
    readMissionProgress(db, user.id),
  ]);
  return (
    <MissionWorkspace
      mission={mission}
      today={bogotaToday()}
      userId={user.id}
      workspaceId={user.organization.id}
      isAdmin={user.role === 'org_admin'}
      truncated={board.truncated}
    />
  );
}
