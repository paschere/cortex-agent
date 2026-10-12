import { fetchUserNames } from '@/app/api/admin/_lib/audit-filters';
import { TaskDetail } from '@/components/tareas/TaskDetail';
import { PageHeader } from '@/components/ui/page-header';
import { toBanner } from '@/lib/background-tasks/banner';
import { TASK_COLUMNS, taskFromRow } from '@/lib/background-tasks/repository';
import { canSeeTask } from '@/lib/background-tasks/scope';
import { taskViewerFor } from '@/lib/background-tasks/viewer';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { ListTodo } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function TareaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const { data } = await db
    .from('background_tasks')
    .select(TASK_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (!data) notFound();
  const task = taskFromRow(data as Record<string, unknown>);
  const viewer = await taskViewerFor(user);
  if (!canSeeTask(viewer, task)) notFound();
  const owners = viewer.isManager ? await fetchUserNames(db, [task.userId]) : {};

  return (
    <>
      <PageHeader
        title="Tarea"
        subtitle="El avance, lo que espera de ti, el resultado y los archivos que produjo."
        icon={<ListTodo className="h-5 w-5" />}
        actions={
          <Link href="/tareas" className="text-sm font-semibold text-primary-ink hover:underline">
            Todas las tareas
          </Link>
        }
      />
      <TaskDetail
        initial={{ ...toBanner(task as unknown as Record<string, unknown>), userId: task.userId }}
        owner={owners[task.userId] ?? null}
        viewer={{ id: viewer.id, isManager: viewer.isManager }}
      />
    </>
  );
}
