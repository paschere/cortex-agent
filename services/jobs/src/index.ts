/**
 * EL WORKER DE LA COLA — lo que antes hacía Inngest Cloud, en un proceso.
 *
 * ===========================================================================
 * POR QUÉ EXISTE
 * ===========================================================================
 * Inngest cobraba por paso y el dueño pidió salirse. Lo que Inngest aportaba
 * de verdad era poco y preciso: guardar eventos, disparar crons, reintentar y
 * limitar concurrencia. Eso lo hace pg-boss sobre un Postgres chico de
 * Railway. Lo que NO se movió es la lógica de negocio: sigue en apps/web
 * (Vercel), donde ya están el código, la base principal y todos los secretos.
 *
 * Este proceso hace exactamente tres cosas:
 *   1. Programa los crons del manifiesto y encola sus trabajos.
 *   2. Recibe trabajos por HTTP (/enqueue, con secreto) desde la app.
 *   3. Ejecuta cada trabajo LLAMANDO a `POST {APP_URL}/api/jobs/run` con el
 *      mismo secreto. Un 2xx es éxito; cualquier otra cosa lanza y pg-boss
 *      reintenta según el manifiesto.
 *
 * ===========================================================================
 * VARIABLES DE ENTORNO
 * ===========================================================================
 *   DATABASE_URL  — el Postgres de Railway (solo para la cola; la base de la
 *                   app sigue en Supabase y este proceso jamás la toca).
 *   APP_URL       — https://cortex-vertix.vercel.app
 *   JOBS_SECRET   — compartido con la app; firma ambas direcciones.
 *   PORT          — lo pone Railway.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import PgBoss from 'pg-boss';
import { JOBS, JOB_EXPIRE_SECONDS, LOCAL_JOBS, queueNameFor, type JobSpec } from './manifest.js';

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

function requiredEnv(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    console.error(`Falta ${name}. Sin eso este worker no puede hacer nada útil; me detengo.`);
    process.exit(1);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');
const APP_URL = requiredEnv('APP_URL').replace(/\/$/, '');
const JOBS_SECRET = requiredEnv('JOBS_SECRET');
const PORT = Number(process.env.PORT ?? 8080);

// Los locales también entran al mapa: /enqueue puede dispararlos a mano
// («haz un backup ya»), y siguen ejecutándose localmente por su work().
const byQueue = new Map<string, JobSpec>(
  [...JOBS, ...LOCAL_JOBS].map((j) => [queueNameFor(j.name), j]),
);

/**
 * Ejecutar = llamar a la app. El timeout del fetch queda por debajo del
 * expire del trabajo para que el fallo lo reporte esta llamada (con su error
 * legible) y no el vencimiento silencioso de pg-boss.
 */
async function invokeApp(job: JobSpec, data: unknown): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (JOB_EXPIRE_SECONDS - 15) * 1000);
  try {
    const res = await fetch(`${APP_URL}/api/jobs/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${JOBS_SECRET}`,
      },
      body: JSON.stringify({ name: job.name, data: data ?? {} }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`la app contestó ${res.status} para ${job.name}: ${body.slice(0, 500)}`);
    }
    // Un 200 no basta: si un middleware o un proxy redirige a una página HTML
    // (pasó el 16 de agosto de 2026 con el middleware de sesión), fetch sigue
    // la redirección y "triunfa" contra la pantalla de login. El puente
    // contesta JSON con `ok` o `skipped`; cualquier otra cosa es un fallo
    // aunque venga con 200.
    const body = (await res.json().catch(() => null)) as { ok?: boolean; skipped?: string } | null;
    if (!body || (body.ok !== true && typeof body.skipped !== 'string')) {
      throw new Error(`la app contestó 200 para ${job.name} pero no con la forma del puente`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Dónde viven las copias. En Railway es un volumen; en local, un directorio. */
const BACKUP_DIR = process.env.BACKUP_DIR ?? '/backups';
const BACKUP_KEEP = 14;

/**
 * La copia de seguridad de la base, hecha AQUÍ porque aquí está la base.
 *
 * pg_dump en formato custom (-Fc): comprimido y restaurable por partes con
 * pg_restore, que es lo que uno quiere a las 3am de un mal día. Se excluye el
 * esquema de la cola (pgboss): son trabajos en tránsito, no datos — y meterlos
 * haría que dos copias nunca coincidan aunque el negocio no haya cambiado.
 * Después de escribir, se podan las más viejas que las últimas BACKUP_KEEP.
 */
function runBackup(): { file: string; bytes: number; kept: number } {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 17);
  const file = join(BACKUP_DIR, `cortex-${stamp}.dump`);
  const r = spawnSync(
    'pg_dump',
    [DATABASE_URL, '--format=custom', '--exclude-schema=pgboss', `--file=${file}`],
    { encoding: 'utf8', timeout: 15 * 60 * 1000 },
  );
  if (r.status !== 0) {
    rmSync(file, { force: true });
    throw new Error(`pg_dump falló: ${r.stderr?.slice(0, 500) || r.error?.message || r.status}`);
  }
  const bytes = statSync(file).size;
  if (bytes < 10_000) {
    // Un dump de menos de 10KB de una base con 114 tablas no es una copia:
    // es un error con extensión .dump. Mejor fallar y que pg-boss reintente.
    throw new Error(`el dump quedó sospechosamente chico (${bytes} bytes)`);
  }
  const all = readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('cortex-') && f.endsWith('.dump'))
    .sort();
  for (const old of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) {
    rmSync(join(BACKUP_DIR, old), { force: true });
  }
  return { file, bytes, kept: Math.min(all.length, BACKUP_KEEP) };
}

/** Trabajos que este proceso resuelve solo, sin viajar a la app. */
const LOCAL_HANDLERS: Record<string, () => Promise<unknown>> = {
  'db/backup': async () => {
    const out = runBackup();
    log(`backup listo: ${out.file} (${(out.bytes / 1024 / 1024).toFixed(1)} MB, ${out.kept} conservados)`);
    return out;
  },
};

async function main() {
  const boss = new PgBoss({
    connectionString: DATABASE_URL,
    // La cola vive en su propio esquema para que un vistazo a la base deje
    // claro qué es infraestructura y qué sería (si algún día migra) negocio.
    schema: 'pgboss',
  });
  boss.on('error', (err) => console.error('pg-boss:', err));
  await boss.start();
  log('pg-boss arriba.');

  for (const job of JOBS) {
    const queue = queueNameFor(job.name);
    await boss.createQueue(queue, {
      name: queue,
      retryLimit: job.retryLimit,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: JOB_EXPIRE_SECONDS,
    });

    await boss.work(
      queue,
      { batchSize: job.concurrency },
      async (jobs) => {
        // batchSize > 1 entrega un lote; cada trabajo se resuelve solo, para
        // que el fallo de uno no arrastre a los demás del lote.
        await Promise.all(
          jobs.map(async (j) => {
            log(`→ ${job.name}`, j.id);
            await invokeApp(job, j.data);
            log(`✓ ${job.name}`, j.id);
          }),
        );
      },
    );

    if (job.cron) {
      // schedule es idempotente: re-programar el mismo cron actualiza, no duplica.
      await boss.schedule(queue, job.cron, {}, { tz: 'Etc/UTC' });
    }
  }
  // Los trabajos locales usan la misma cola (reintentos y cron gratis) pero
  // su handler corre aquí mismo — ver LOCAL_JOBS en el manifiesto.
  for (const job of LOCAL_JOBS) {
    const queue = queueNameFor(job.name);
    const handler = LOCAL_HANDLERS[job.name];
    if (!handler) {
      console.error(`trabajo local sin handler: ${job.name} — no se programa.`);
      continue;
    }
    await boss.createQueue(queue, {
      name: queue,
      retryLimit: job.retryLimit,
      retryDelay: 120,
      retryBackoff: true,
      expireInSeconds: JOB_EXPIRE_SECONDS,
    });
    await boss.work(queue, { batchSize: 1 }, async (jobs) => {
      for (const j of jobs) {
        log(`→ ${job.name} (local)`, j.id);
        await handler();
        log(`✓ ${job.name} (local)`, j.id);
      }
    });
    if (job.cron) await boss.schedule(queue, job.cron, {}, { tz: 'Etc/UTC' });
  }

  log(
    `colas listas: ${JOBS.length} trabajos, ${JOBS.filter((j) => j.cron).length} crons, ${LOCAL_JOBS.length} locales.`,
  );

  // -------------------------------------------------------------------------
  // La puerta de entrada: la app encola aquí lo que antes era inngest.send().
  // -------------------------------------------------------------------------
  const server = http.createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/health') {
      // El último backup a la vista: que «¿tenemos copias?» se conteste con
      // un curl y no con una excavación de logs.
      let lastBackup: { file: string; mb: number; at: string } | null = null;
      try {
        const files = readdirSync(BACKUP_DIR)
          .filter((f) => f.startsWith('cortex-') && f.endsWith('.dump'))
          .sort();
        const newest = files[files.length - 1];
        if (newest) {
          const st = statSync(join(BACKUP_DIR, newest));
          lastBackup = {
            file: newest,
            mb: Number((st.size / 1024 / 1024).toFixed(1)),
            at: st.mtime.toISOString(),
          };
        }
      } catch {
        // Sin volumen (local, primer arranque): el health no se cae por eso.
      }
      return reply(200, { ok: true, jobs: JOBS.length, lastBackup });
    }

    if (req.method !== 'POST' || req.url !== '/enqueue') return reply(404, { error: 'no' });
    if (req.headers.authorization !== `Bearer ${JOBS_SECRET}`) {
      return reply(401, { error: 'sin autorización' });
    }

    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      // Un evento de cola son unos cientos de bytes; un cuerpo grande es un
      // error o un abuso, y en ambos casos la respuesta correcta es cortar.
      if (raw.length > 256 * 1024) req.destroy();
    });
    req.on('end', () => {
      void (async () => {
        try {
          const { name, data } = JSON.parse(raw) as { name?: string; data?: unknown };
          const queue = name ? queueNameFor(name) : '';
          const spec = byQueue.get(queue);
          if (!name || !spec) return reply(400, { error: `trabajo desconocido: ${name}` });

          const payload = (data ?? {}) as Record<string, unknown>;
          const key = spec.singletonKeyFrom ? payload[spec.singletonKeyFrom] : undefined;
          const jobId = await boss.send(queue, payload, {
            ...(typeof key === 'string' && key
              ? // Colapsar duplicados mientras uno espera: dos «despiértate»
                // para el mismo encargo son un solo avance.
                { singletonKey: key, singletonSeconds: 30 }
              : {}),
          });
          return reply(200, { ok: true, jobId });
        } catch (err) {
          return reply(500, { error: err instanceof Error ? err.message : 'falló el encolado' });
        }
      })();
    });
  });

  server.listen(PORT, () => log(`escuchando en :${PORT}`));

  const shutdown = async () => {
    log('apagando…');
    server.close();
    await boss.stop({ graceful: true, timeout: 25_000 });
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('el worker no pudo arrancar:', err);
  process.exit(1);
});
