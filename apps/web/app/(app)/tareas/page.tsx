import { fetchUserNames } from '@/app/api/admin/_lib/audit-filters';
import { TaskGallery } from '@/components/tareas/TaskGallery';
import { TaskList, toRow } from '@/components/tareas/TaskList';
import { PageHeader } from '@/components/ui/page-header';
import { TASK_COLUMNS, taskFromRow } from '@/lib/background-tasks/repository';
import { applyTaskScope } from '@/lib/background-tasks/scope';
import { taskViewerFor } from '@/lib/background-tasks/viewer';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { BUILTIN_TEMPLATES } from '@/lib/task-templates/catalog';
import { type TaskTemplate, templateFromRow } from '@/lib/task-templates/shape';
import { ListTodo } from 'lucide-react';

export const dynamic = 'force-dynamic';

/**
 * TAREAS: lo que Cortex hace en segundo plano.
 *
 * Quien administra la empresa ve las de todos; cualquier otra persona, sólo las
 * suyas (el mismo alcance que /actividad, ver lib/background-tasks/scope.ts).
 */
export default async function TareasPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const viewer = await taskViewerFor(user);
  const { data } = await applyTaskScope(
    db
      .from('background_tasks')
      .select(TASK_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(100),
    viewer,
  );
  const tasks = ((data ?? []) as Record<string, unknown>[]).map(taskFromRow);
  const owners = viewer.isManager
    ? await fetchUserNames(
        db,
        tasks.map((t) => t.userId),
      )
    : {};
  const [companyRows, integrations] = await Promise.all([
    db
      .from('task_templates')
      .select('id, title, summary, prompt, needs, minutes')
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(40),
    db.from('integrations').select('provider').eq('user_id', user.id),
  ]);
  const company = ((companyRows.data ?? []) as Record<string, unknown>[])
    .map(templateFromRow)
    .filter((t): t is TaskTemplate => t !== null);
  const connected = new Set(
    ((integrations.data ?? []) as { provider: string }[]).map((r) => r.provider),
  );
  if (process.env.HUBSPOT_PRIVATE_APP_TOKEN) connected.add('hubspot');
  const rows = tasks.map((t) => toRow({ ...t, ownerName: owners[t.userId] ?? null }));

  return (
    <>
      <PageHeader
        title="Tareas"
        subtitle="Lo que le pediste a Cortex que hiciera por su cuenta. Sigue aunque cierres el navegador, te avisa al terminar y te pide el visto bueno cuando hace falta."
        icon={<ListTodo className="h-5 w-5" />}
      />
      <TaskGallery
        templates={[...company, ...BUILTIN_TEMPLATES]}
        connected={[...connected]}
        canManage={viewer.isManager}
      />
      <TaskList initial={rows} viewer={{ id: viewer.id, isManager: viewer.isManager }} />
    </>
  );
}
