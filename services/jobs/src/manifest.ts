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
  { name: 'activations/dispatch', cron: '*/5 * * * *', retryLimit: 1, concurrency: 1 },
  { name: 'activations/run', retryLimit: 1, concurrency: 3, singletonKeyFrom: 'automationId' },
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
  // La cartera que avisa sola (0159): 07:00 en Bogotá, una hora después de los
  // vencimientos. Ver apps/web/inngest/functions/receivables-watch.ts.
  { name: 'receivables/watch.dispatch', cron: '0 12 * * *', retryLimit: 1, concurrency: 1 },
  // Tablas que se llenan solas desde una fuente conectada (0161). Cada 5
  // minutos decide qué sincronizaciones tocan; cada una corre en su evento.
  { name: 'table-sync/dispatch', cron: '*/5 * * * *', retryLimit: 1, concurrency: 1 },
  // Carpetas de Drive que llenan tablas (0162): cada 10 minutos, el pulso de
  // drive/sync. Ver apps/web/inngest/functions/drive-table.ts.
  { name: 'drive-table/dispatch', cron: '*/10 * * * *', retryLimit: 1, concurrency: 1 },
  // Programas contables (Siigo…) que llenan tablas y cartera (0165): cada 15
  // minutos decide qué conexiones tocan (cada una tiene su intervalo, 60 min
  // por defecto). Ver apps/web/inngest/functions/accounting-sync.ts.
  { name: 'accounting/dispatch', cron: '*/15 * * * *', retryLimit: 1, concurrency: 1 },
  { name: 'actions/sweep.dispatch', cron: '30 11 * * *', retryLimit: 1, concurrency: 1 },
  { name: 'management/workflow.dispatch', cron: '*/15 * * * *', retryLimit: 1, concurrency: 1 },
  { name: 'management/workflow.advance', retryLimit: 2, concurrency: 5 },
  { name: 'management/operation.review', retryLimit: 2, concurrency: 5 },
  // El seguimiento de Gerencia (0158): 07:15 de Bogotá en días hábiles; los
  // festivos se saltan en la app. Ver apps/web/inngest/functions/management-follow-up.ts.
  { name: 'management/follow-up.dispatch', cron: '15 12 * * 1-5', retryLimit: 1, concurrency: 1 },
  { name: 'management/follow-up.workspace', retryLimit: 1, concurrency: 5 },
  { name: 'goals/watch.dispatch', cron: '30 11 * * *', retryLimit: 1, concurrency: 1 },
  { name: 'reports/weekly.dispatch', cron: '0 12 * * 1', retryLimit: 1, concurrency: 1 },
  // Resumen periódico de una vista (0203): cada hora en punto decide qué vistas
  // con spec.digest tocan. Ver apps/web/inngest/functions/view-digest.ts.
  { name: 'views/digest.dispatch', cron: '0 * * * *', retryLimit: 1, concurrency: 1 },
  // Automatizaciones de las apps (0210): cada minuto reclama los horarios que
  // tocan y reparte lo que espera un reintento. Ver apps/web/inngest/functions/app-automations.ts.
  { name: 'apps/automation.dispatch', cron: '* * * * *', retryLimit: 1, concurrency: 1 },
  // Ubicación del equipo (0216): cada hora borra el rastro que pasó la retención de su app
  // y cierra los turnos que se quedaron abiertos. Ver apps/web/inngest/functions/app-location.ts.
  { name: 'apps/location.sweep', cron: '5 * * * *', retryLimit: 1, concurrency: 1 },
  // Cobro (0187): 13:00 UTC = 8:00 en Bogotá, para que el recordatorio llegue en horario.
  { name: 'billing/renewals', cron: '0 13 * * *', retryLimit: 1, concurrency: 1 },
  // El registro de trabajo (0174): 06:45 de Bogotá todos los días, después de
  // que los compromisos refrescan su estado. Ver apps/web/inngest/functions/work-sync.ts.
  { name: 'work/sync.dispatch', cron: '45 11 * * *', retryLimit: 1, concurrency: 1 },
  // Perseguir lo pendiente (0177): cada hora hábil de 07:45 a 16:45 de Bogotá
  // (cada quien tiene su franja); recordatorios reclamados una vez por día.
  // Ver apps/web/inngest/functions/clients-link.ts: colgar de cada cliente lo ya guardado (0179).
  { name: 'clients/link-dispatch', cron: '30 11 * * *', retryLimit: 1, concurrency: 1 },
  // Ver apps/web/inngest/functions/follow-through.ts.
  { name: 'follow-through/dispatch', cron: '45 12-21 * * 1-5', retryLimit: 1, concurrency: 1 },
  // El piloto automático (0176): cada hora y cinco reparte las empresas cuya
  // hora de corrida (Bogotá) es ésta. Días, festivos y días quietos se deciden
  // en la app. Ver apps/web/inngest/functions/autopilot.ts.
  { name: 'autopilot/dispatch', cron: '5 * * * *', retryLimit: 1, concurrency: 1 },

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
  { name: 'receivables/watch.workspace', retryLimit: 1, concurrency: 5 },
  { name: 'table-sync/run', retryLimit: 1, concurrency: 5 },
  { name: 'table-sync/setup', retryLimit: 0, concurrency: 2 },
  // Lee documentos con el modelo: sin reintento (la siguiente corrida retoma
  // lo que falte) y una corrida por carpeta a la vez.
  { name: 'drive-table/run', retryLimit: 0, concurrency: 2, singletonKeyFrom: 'syncId' },
  // Sin clave única: una carga a medias se re-encola a sí misma mientras corre,
  // y la toma en la base (`claimAccountingConnection`) ya impide dos a la vez.
  // Sin reintento: la siguiente corrida retoma desde el cursor.
  { name: 'accounting/run', retryLimit: 0, concurrency: 3 },
  { name: 'goals/watch.workspace', retryLimit: 1, concurrency: 5 },
  { name: 'learning/pass.workspace', retryLimit: 1, concurrency: 1 },
  { name: 'memory/derive.user', retryLimit: 1, concurrency: 5 },
  // Una tanda de la carga histórica de un buzón. Se re-encola a sí misma
  // mientras queden páginas; `singletonKeyFrom` evita que dos tandas de la
  // misma persona corran a la vez y se pisen el cursor.
  { name: 'gmail/backfill.user', retryLimit: 1, concurrency: 3, singletonKeyFrom: 'userId' },
  { name: 'gmail/sweep.user', retryLimit: 1, concurrency: 5, singletonKeyFrom: 'userId' },
  { name: 'reports/weekly.workspace', retryLimit: 1, concurrency: 5 },
  { name: 'views/digest.run', retryLimit: 1, concurrency: 5 },
  // Una corrida de una automatización de app (0210). Reclamarla es atómico.
  { name: 'apps/automation.run', retryLimit: 1, concurrency: 5 },
  { name: 'work/sync.workspace', retryLimit: 1, concurrency: 5 },
  // El aviso de trabajo reasignado (work.assign): la campana de quien lo recibe.
  { name: 'work/assigned', retryLimit: 1, concurrency: 5 },
  // Una empresa: recordatorios de aprobaciones, resumen de vencidos y la cuenta
  // de lo recomendado. Reintentar no repite avisos (follow_through_notices).
  {
    name: 'clients/link-workspace',
    retryLimit: 1,
    concurrency: 3,
    singletonKeyFrom: 'organizationId',
  },
  { name: 'follow-through/workspace', retryLimit: 1, concurrency: 5 },
  // Una empresa a la vez por corrida (la corrida es una por día: el índice lo
  // garantiza). Reintentar retoma la misma corrida sin repetir lo hecho.
  { name: 'autopilot/workspace', retryLimit: 1, concurrency: 3 },
  // El recordatorio de autopilot.remind: la campana de un compañero.
  { name: 'autopilot/remind', retryLimit: 1, concurrency: 5 },
  { name: 'dev/task.intake', retryLimit: 1, concurrency: 5 },
  { name: 'dev/task.queued', retryLimit: 0, concurrency: 2, singletonKeyFrom: 'taskId' },
  { name: 'dev/task.status', retryLimit: 1, concurrency: 5 },
  // Derechos del titular (0188). El barrido diario (04:30 Bogotá) vence los ZIP
  // de exportación viejos y reparte las purgas cuya gracia venció. La purga
  // tiene 0 reintentos: borra, y un estado a medias lo decide una persona.
  { name: 'legal/dispatch', cron: '30 9 * * *', retryLimit: 1, concurrency: 1 },
  { name: 'legal/export.run', retryLimit: 1, concurrency: 1, singletonKeyFrom: 'exportId' },
  {
    name: 'legal/organization.purge',
    retryLimit: 0,
    concurrency: 1,
    singletonKeyFrom: 'deletionId',
  },
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
