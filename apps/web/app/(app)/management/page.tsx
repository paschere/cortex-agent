import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday, readManagement, readManagementSignals } from '@cortex/agent-tools';
import { ManagementBoard } from './ManagementBoard';
export const dynamic = 'force-dynamic';
export default async function ManagementPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const [board, sources] = await Promise.all([
    readManagement(db),
    readManagementSignals(db, user.id),
  ]);
  return (
    <ManagementBoard
      {...board}
      {...sources}
      today={bogotaToday()}
      userId={user.id}
      isAdmin={user.role === 'org_admin'}
    />
  );
}

// Narration organization runs here as a server action, with its own 60 s abort.
export const maxDuration = 90;
