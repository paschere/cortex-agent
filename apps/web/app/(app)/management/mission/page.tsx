import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday, readManagement } from '@cortex/agent-tools';
import { MissionWorkspace } from './workspace';
export const dynamic = 'force-dynamic';
export default async function MissionPage() {
  const user = await requireSession();
  const board = await readManagement(getOrgScopedClient(user.organization.id));
  return (
    <MissionWorkspace
      cases={board.cases}
      people={board.people}
      today={bogotaToday()}
      userId={user.id}
      isAdmin={user.role === 'org_admin'}
      truncated={board.truncated}
    />
  );
}
