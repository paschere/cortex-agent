'use client';

import { TaskDetail } from '@/components/tareas/TaskDetail';
import { TaskGallery } from '@/components/tareas/TaskGallery';
import { TaskList } from '@/components/tareas/TaskList';
import { PageHeader } from '@/components/ui/page-header';
import { FIXTURE_FILES, FIXTURE_TASKS } from '@/lib/background-tasks/fixtures';
import { BUILTIN_TEMPLATES } from '@/lib/task-templates/catalog';
import type { TaskTemplate } from '@/lib/task-templates/shape';
import { ListTodo } from 'lucide-react';
import { useEffect } from 'react';

const COMPANY_FIXTURE: TaskTemplate = {
  id: 'c-1',
  source: 'company',
  title: 'Revisa las rutas de reparto de {{ciudad}}',
  summary: 'La plantilla propia de la empresa: ordena las entregas del día por zona.',
  prompt: 'Revisa las rutas de reparto de {{ciudad}} y propón un orden por zona.',
  needs: ['gmail'],
  minutes: 8,
  fields: [{ key: 'ciudad', label: 'ciudad', placeholder: 'p. ej. Medellín' }],
};

export function TareasShowcase({
  dark,
  view,
  admin,
}: {
  dark: boolean;
  view: 'lista' | 'tarea' | 'necesita' | 'galeria';
  admin: boolean;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  const viewer = { id: 'u1', isManager: admin };
  const rows = admin ? FIXTURE_TASKS : FIXTURE_TASKS.filter((t) => t.userId === 'u1');
  const detail = FIXTURE_TASKS.find((t) => t.id === (view === 'necesita' ? 't-needs' : 't-done'));
  return (
    <div className="cortex-workspace mx-auto min-h-screen max-w-5xl bg-canvas px-4 py-8 sm:px-8">
      <PageHeader
        title="Tareas"
        subtitle="Lo que le pediste a Cortex que hiciera por su cuenta. Sigue aunque cierres el navegador, te avisa al terminar y te pide el visto bueno cuando hace falta."
        icon={<ListTodo className="h-5 w-5" />}
      />
      {view === 'galeria' ? (
        <>
          <TaskGallery
            templates={[COMPANY_FIXTURE, ...BUILTIN_TEMPLATES]}
            connected={['google', 'siigo']}
            canManage={admin}
            fixture
          />
          <TaskList initial={rows.slice(0, 2)} viewer={viewer} fixture />
        </>
      ) : view === 'lista' || !detail ? (
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
