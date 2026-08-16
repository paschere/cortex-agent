/**
 * EL MANIFIESTO DE TRABAJOS — la única lista de qué corre y cuándo.
 *
 * Este worker reemplaza a Inngest Cloud, y este archivo reemplaza lo que allá
 * era configuración dispersa en 21 `createFunction`: aquí está TODO lo que el
 * sistema hace en segundo plano, en una tabla que se lee en un minuto.
 *
 * El worker NO ejecuta la lógica de negocio. La lógica vive en la app de
 * Vercel (apps/web), que es donde están el código y los secretos; el worker
 * solo guarda la cola, dispara los crons, reintenta y llama por HTTP al
 * puente `/api/jobs/run` de la app. Por eso este paquete es autocontenido:
 * cero imports del monorepo, para que Railway lo construya sin conocerlo.
 *
 * apps/web/lib/jobs-registry.test.ts es el espejo: falla si un nombre de aquí
 * no tiene handler en la app, o al revés. Si tocas esta lista, corre ese test.
 *
 * LOS CRONS SON LOS MISMOS QUE TENÍA INNGEST, ya optimizados el 14 de agosto
 * de 2026 (los de cada minuto pasaron a cada 5). Cambiarlos aquí ES cambiarlos
 * en producción al siguiente deploy del worker.
 */

export interface JobSpec {
  /** El nombre del evento, idéntico al que usaba Inngest ('errand/advance'). */
  name: string;
  /** Cron UTC. Solo los trabajos que corren solos lo tienen. */
  cron?: string;
  /** Reintentos ante fallo. 0 = una sola oportunidad (los que llaman al modelo). */
  retryLimit: number;
  /**
   * Cuántos de este trabajo pueden correr a la vez EN ESTE worker. La segunda
   * capa de exclusión (leases por encargo, claims por run) vive en la base de
   * datos y sigue intacta — esto solo evita el estampido.
   */
  concurrency: number;
  /**
   * Si el trabajo debe colapsar duplicados: la clave se saca del payload y
   * pg-boss no encola un segundo trabajo con la misma clave mientras el
   * primero espera. Sirve para los eventos «despiértate» sin contenido
   * (errand/advance): dos avisos seguidos son un solo avance.
   */
  singletonKeyFrom?: string;
}

/**
 * Techo de ejecución por trabajo, en segundos. El puente en Vercel corre con
 * maxDuration=800; el worker expira el trabajo un poco después para no marcar
 * como fallido algo que la app todavía está terminando.
 */
export const JOB_EXPIRE_SECONDS = 840;

export const JOBS: JobSpec[] = [
  // --- Los que corren solos (cron) y reparten trabajo por workspace ---------
  { name: 'errand/sweep', cron: '*/5 * * * *', retryLimit: 1, concurrency: 1 },
  { name: 'schedule/dispatch', cron: '*/5 * * * *', retryLimit: 1, concurrency: 1 },
  { name: 'orchestrator/sweep', cron: '*/5 * * * *', retryLimit: 1, concurrency: 1 },
  { name: 'drive/sync', cron: '*/10 * * * *', retryLimit: 1, concurrency: 1 },
  { name: 'kb/embeddings.reindex', cron: '*/15 * * * *', retryLimit: 3, concurrency: 1 },
  { name: 'meetings/import', cron: '*/30 * * * *', retryLimit: 1, concurrency: 1 },
  { name: 'memory/derive.dispatch', cron: '0 7 * * *', retryLimit: 1, concurrency: 1 },
  { name: 'turn-context/purge', cron: '40 8 * * *', retryLimit: 1, concurrency: 1 },
  { name: 'turn-latency/purge', cron: '50 8 * * *', retryLimit: 1, concurrency: 1 },
  { name: 'learning/pass.dispatch', cron: '20 9 * * *', retryLimit: 1, concurrency: 1 },
  { name: 'commitments/watch.dispatch', cron: '0 11 * * *', retryLimit: 1, concurrency: 1 },
  { name: 'actions/sweep.dispatch', cron: '30 11 * * *', retryLimit: 1, concurrency: 1 },
  { name: 'goals/watch.dispatch', cron: '30 11 * * *', retryLimit: 1, concurrency: 1 },
  { name: 'reports/weekly.dispatch', cron: '0 12 * * 1', retryLimit: 1, concurrency: 1 },

  // --- Los que llegan por evento --------------------------------------------
  // retryLimit 0 en los que llaman al modelo: reintentar un turno del agente
  // es pagarlo dos veces, y el sweep de los */5 ya recoge lo que quede a
  // medias. La misma decisión que tenían en Inngest.
  {
    name: 'errand/advance',
    retryLimit: 0,
    concurrency: 3,
    singletonKeyFrom: 'errandId',
  },
  {
    name: 'orchestrator/run.started',
    retryLimit: 0,
    concurrency: 2,
    singletonKeyFrom: 'runId',
  },
  { name: 'scheduled/job.run', retryLimit: 0, concurrency: 5 },
  { name: 'kb/document.ingest', retryLimit: 3, concurrency: 2 },
  { name: 'actions/sweep.workspace', retryLimit: 1, concurrency: 5 },
  { name: 'commitments/watch.workspace', retryLimit: 1, concurrency: 5 },
  { name: 'goals/watch.workspace', retryLimit: 1, concurrency: 5 },
  { name: 'learning/pass.workspace', retryLimit: 1, concurrency: 1 },
  { name: 'memory/derive.user', retryLimit: 1, concurrency: 5 },
  { name: 'reports/weekly.workspace', retryLimit: 1, concurrency: 5 },
  { name: 'dev/task.intake', retryLimit: 1, concurrency: 5 },
  { name: 'dev/task.queued', retryLimit: 0, concurrency: 2, singletonKeyFrom: 'taskId' },
  { name: 'dev/task.status', retryLimit: 1, concurrency: 5 },
];

/**
 * pg-boss no acepta '/' ni '.' en nombres de cola; el nombre humano viaja en
 * el payload y esta transformación es solo el identificador interno.
 */
export function queueNameFor(jobName: string): string {
  return jobName.replace(/[^a-zA-Z0-9_-]/g, '-');
}
