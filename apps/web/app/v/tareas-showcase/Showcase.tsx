'use client';

import { TaskDetail } from '@/components/tareas/TaskDetail';
import { TaskList } from '@/components/tareas/TaskList';
import { PageHeader } from '@/components/ui/page-header';
import { FIXTURE_FILES, FIXTURE_TASKS } from '@/lib/background-tasks/fixtures';
import { ListTodo } from 'lucide-react';
import { useEffect } from 'react';

export function TareasShowcase({
  dark,
  view,
  admin,
}: {
  dark: boolean;
  view: 'lista' | 'tarea' | 'necesita';
  admin: boolean;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  const viewer = { id: 'u1', isManager: admin };
  const rows = admin ? FIXTURE_TASKS : FIXTURE_TASKS.filter((t) => t.userId === 'u1');
  const detail = FIXTURE_TASKS.find((t) => t.id === (view === 'necesita' ? 't-needs' : 't-done'));
  return (
    <div className="mx-auto min-h-screen max-w-5xl bg-canvas px-4 py-8 sm:px-8">
      <PageHeader
        title="Tareas"
        subtitle="Lo que le pediste a Cortex que hiciera por su cuenta. Sigue aunque cierres el navegador, te avisa al terminar y te pide el visto bueno cuando hace falta."
        icon={<ListTodo className="h-5 w-5" />}
      />
      {view === 'lista' || !detail ? (
        <TaskList initial={rows} viewer={viewer} fixture />
      ) : (
        <TaskDetail
          initial={detail}
          owner={detail.ownerName}
          viewer={viewer}
          fixture
          fixtureFiles={view === 'tarea' ? FIXTURE_FILES : FIXTURE_FILES.slice(0, 2)}
        />
      )}
    </div>
  );
}
