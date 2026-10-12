import 'server-only';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { isCompanyManager } from '@cortex/agent-tools';
import type { SessionUser } from '@cortex/core';
import type { TaskViewer } from './scope';

/** Quién mira, para el alcance de las tareas (igual que /actividad). */
export async function taskViewerFor(user: SessionUser): Promise<TaskViewer> {
  const db = getOrgScopedClient(user.organization.id);
  const isManager = user.role === 'org_admin' || (await isCompanyManager(db, user.id));
  return { id: user.id, isManager };
}
