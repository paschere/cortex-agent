import { runTaskSegment } from '@/lib/background-tasks/run';
import { sweepTasks } from '@/lib/background-tasks/sweep';
import type { JobHandler } from '@/lib/jobs';

/**
 * TAREAS EN SEGUNDO PLANO (migración 0222): los dos trabajos.
 *
 *   tasks/run    una TANDA de una tarea. Sin reintentos (reintentar un turno del
 *                agente es pagarlo dos veces) y sin clave única: una tarea larga
 *                se vuelve a encolar a sí misma mientras corre, y la exclusión la
 *                da la reclamación en la base (`claim` en lib/background-tasks/run.ts).
 *   tasks/sweep  cada 5 minutos: tandas muertas, trabajos perdidos y acciones
 *                paradas ya respondidas. Ver lib/background-tasks/sweep.ts.
 *
 * Sólo corren en el worker de pg-boss (services/jobs); no tienen versión Inngest.
 */

export const taskRunJob: JobHandler = async ({ event }) => {
  const data = event.data as { taskId?: string; organizationId?: string };
  if (!data?.taskId || !data?.organizationId) {
    return { skipped: 'event carried no task or workspace' };
  }
  const result = await runTaskSegment({ taskId: data.taskId, organizationId: data.organizationId });
  return { taskId: data.taskId, ...result };
};

export const taskSweepJob: JobHandler = async ({ step }) => {
  return step.run('sweep-tasks', async () => ({ ...(await sweepTasks()) }));
};
