'use client';

import { Button } from '@/components/ui/button';
import type { ActionResult, ProjectChoice, TimesheetView } from '@/lib/projects/shape';
import { Timer } from 'lucide-react';
import { useState } from 'react';
import { LogTimeDialog, type LogTimeInput } from './LogTimeDialog';
import { TimesheetTable } from './ProjectsScreen';

/**
 * MIS HORAS DE LA SEMANA, en «Mi semana» (migración 0196): por proyecto y día,
 * con «Registrar horas» a un clic. Sólo sale si la empresa tiene prendido el
 * módulo de proyectos.
 */
export function MyTimesheet({
  week,
  projects,
  today,
  logTime,
}: {
  week: TimesheetView;
  projects: ProjectChoice[];
  today: string;
  logTime: (input: LogTimeInput) => Promise<ActionResult>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-10" aria-labelledby="mis-horas">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="mis-horas" className="text-lg font-extrabold tracking-tight text-ink">
            Mis horas · semana del {week.weekLabel}
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Lo que registraste en cada proyecto u orden de servicio. Total: {week.total}.
          </p>
        </div>
        <Button variant="outline" onClick={() => setOpen(true)} disabled={!projects.length}>
          <Timer className="h-4 w-4" aria-hidden />
          Registrar horas
        </Button>
      </div>
      <TimesheetTable
        week={week}
        emptyText={
          projects.length
            ? 'No has registrado horas esta semana.'
            : 'No hay proyectos abiertos donde registrar horas.'
        }
      />
      {open && (
        <LogTimeDialog
          projects={projects}
          today={today}
          onClose={() => setOpen(false)}
          logTime={logTime}
        />
      )}
    </section>
  );
}
