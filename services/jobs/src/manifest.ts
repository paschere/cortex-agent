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
  // El buzón de Gmail de cada quien, cada mañana a las 6:10 de Bogotá: archiva
  // lo que llegó desde el puntero de ayer y propone qué contestar (0121).
  // Cada diez minutos desde la 0126: este barrido ya no sólo archiva, también
  // decide de qué interrumpir, y un aviso de la mañana siguiente no es un aviso.
  // Ver GMAIL_SWEEP_CRON en apps/web/inngest/functions/gmail-learn.ts.
  { name: 'gmail/sweep', cron: '*/10 * * * *', retryLimit: 1, concurrency: 1 },
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
  // Una tanda de la carga histórica de un buzón. Se re-encola a sí misma
  // mientras queden páginas; `singletonKeyFrom` evita que dos tandas de la
  // misma persona corran a la vez y se pisen el cursor.
  { name: 'gmail/backfill.user', retryLimit: 1, concurrency: 3, singletonKeyFrom: 'userId' },
  { name: 'gmail/sweep.user', retryLimit: 1, concurrency: 5, singletonKeyFrom: 'userId' },
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

/**
 * TRABAJOS LOCALES: los que el worker ejecuta ÉL MISMO, sin llamar a la app.
 *
 * Separados de JOBS a propósito: el test espejo de la app
 * (apps/web/lib/jobs-registry.test.ts) exige que cada nombre de JOBS tenga un
 * handler en Vercel, y estos no lo tienen ni deben tenerlo — el backup de la
 * base corre AL LADO de la base, con pg_dump, por la red privada de Railway.
 * Mandarlo por HTTP a un serverless sería sacar gigas por el camino largo
 * para volverlos a entrar.
 *
 * EL BACKUP EXISTE PORQUE EL ÉXODO LO DEBÍA: Supabase hacía copias solas;
 * este Postgres de Railway es ahora el único hogar de TODO (datos, archivos,
 * cola) y hasta hoy no tenía ninguna. Diario a la 1:15am de Colombia, formato
 * custom de pg_dump (comprimido, restaurable con pg_restore), al volumen
 * /backups del worker, conservando los últimos 14.
 */
export const LOCAL_JOBS: JobSpec[] = [
  { name: 'db/backup', cron: '15 6 * * *', retryLimit: 2, concurrency: 1 },
];
