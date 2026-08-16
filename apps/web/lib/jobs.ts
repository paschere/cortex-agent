/**
 * LA COLA, VISTA DESDE LA APP — encolar trabajos y ejecutarlos cuando vuelven.
 *
 * ===========================================================================
 * QUÉ REEMPLAZA ESTO
 * ===========================================================================
 * Antes: `inngest.send({ name, data })` mandaba el evento a Inngest Cloud, que
 * cobraba por paso y luego invocaba `/api/inngest` de vuelta. Ahora el mismo
 * evento viaja al worker de pg-boss en Railway (`services/jobs`), que guarda,
 * reintenta y programa — y ejecuta llamando a `/api/jobs/run` de vuelta aquí.
 * La lógica de negocio no se movió un milímetro: sigue corriendo en Vercel,
 * con los mismos secretos y la misma base.
 *
 * ===========================================================================
 * EL CAMINO DOBLE, Y CUÁNDO SE MUERE
 * ===========================================================================
 * `enqueueJob` usa el worker si `JOBS_WORKER_URL` está configurada y cae a
 * Inngest si no. Eso existe para UNA cosa: poder desplegar este código antes
 * de que el worker esté vivo sin dejar de encolar nada. El día que el worker
 * esté verificado en producción, se borra INNGEST_SIGNING_KEY de Vercel (el
 * endpoint /api/inngest se apaga solo) y el fallback queda como código muerto
 * que un commit posterior retira.
 */

import { logger } from '@cortex/core';
import { inngest } from '@/lib/inngest';

export interface JobEvent {
  name: string;
  data: Record<string, unknown>;
}

/**
 * La firma que comparten todos los handlers portados desde Inngest. `step` es
 * el shim de compatibilidad: los cuerpos de las funciones se escribieron
 * contra la API de pasos de Inngest y no hay razón para reescribirlos.
 */
export interface JobStep {
  /**
   * En Inngest, `step.run` memoizaba el paso entre reintentos. Aquí ejecuta y
   * ya: pg-boss reintenta el TRABAJO entero, y las funciones de este repo son
   * idempotentes por diseño (leases, claims, upserts) precisamente porque esa
   * memoización nunca fue garantía suficiente.
   */
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sendEvent(id: string, events: JobEvent | JobEvent[]): Promise<void>;
  /** Duración tipo Inngest: '30s', '2m', o milisegundos. Duerme de verdad. */
  sleep(id: string, duration: string | number): Promise<void>;
}

export interface JobContext {
  event: JobEvent;
  step: JobStep;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

/** '30s' | '2m' | '1h' | número en ms → ms. */
export function parseDuration(duration: string | number): number {
  if (typeof duration === 'number') return Math.max(0, duration);
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(duration.trim());
  if (!m) return 0;
  const value = Number(m[1]);
  const unit = m[2];
  return unit === 'ms' ? value : unit === 's' ? value * 1000 : unit === 'm' ? value * 60_000 : value * 3_600_000;
}

/**
 * Encola un trabajo. Nunca lanza por fallos de red del worker: quien encola
 * suele estar terminando un turno de chat o un webhook, y romper ESO porque
 * la cola parpadeó es peor que perder un evento que un cron de barrido va a
 * recoger de todas formas (los sweeps existen exactamente para eso).
 * Devuelve false si no se pudo encolar, para quien quiera saberlo.
 */
export async function enqueueJob(name: string, data: Record<string, unknown>): Promise<boolean> {
  const workerUrl = (process.env.JOBS_WORKER_URL ?? '').trim().replace(/\/$/, '');
  const secret = (process.env.JOBS_SECRET ?? '').trim();

  if (workerUrl && secret) {
    try {
      const res = await fetch(`${workerUrl}/enqueue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ name, data }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        logger.error('jobs: el worker rechazó el encolado', { name, status: res.status });
        return false;
      }
      return true;
    } catch (err) {
      logger.error('jobs: no se pudo llegar al worker', {
        name,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // Transición: sin worker configurado, el evento sigue yendo a Inngest para
  // que nada se pierda entre el deploy del código y el arranque del worker.
  try {
    await inngest.send({ name, data });
    return true;
  } catch (err) {
    logger.error('jobs: tampoco se pudo encolar en Inngest', {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function enqueueJobs(events: JobEvent[]): Promise<void> {
  for (const e of events) await enqueueJob(e.name, e.data);
}

/** El shim que hace que un handler escrito para Inngest corra aquí sin más. */
export function makeStep(): JobStep {
  return {
    run: async (_name, fn) => fn(),
    sendEvent: async (_id, events) => {
      await enqueueJobs(Array.isArray(events) ? events : [events]);
    },
    sleep: (_id, duration) => new Promise((resolve) => setTimeout(resolve, parseDuration(duration))),
  };
}
