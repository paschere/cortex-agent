/**
 * EL PUENTE DE LA COLA — donde los trabajos de pg-boss se vuelven ejecución.
 *
 * El worker de Railway (services/jobs) no sabe hacer nada: guarda la cola,
 * dispara los crons y llama aquí con `{ name, data }`. Este endpoint busca el
 * handler en el registro y lo corre EN VERCEL, que es donde viven el código,
 * la base y los secretos. Es exactamente el contrato que tenía /api/inngest
 * con Inngest Cloud, pero con un dueño que no cobra por paso.
 *
 * SEGURIDAD: el worker firma con JOBS_SECRET y aquí se compara en tiempo
 * constante. Sin secreto configurado, el endpoint no existe (404) — la misma
 * decisión que tomó /api/inngest con INNGEST_SIGNING_KEY, y por la misma
 * razón: un endpoint que ejecuta trabajos sin autenticar es una puerta
 * trasera con nombre amable.
 *
 * maxDuration=800: los trabajos largos (una corrida del orquestador, un
 * encargo con varias patas) corren dentro de UNA invocación. Inngest los
 * partía en pasos por HTTP; aquí el paso es la función entera, y 13 minutos
 * es techo de sobra para el peor caso medido.
 */

import { timingSafeEqual } from 'node:crypto';
import { logger } from '@cortex/core';
import { makeStep } from '@/lib/jobs';
import { JOB_HANDLERS } from '@/lib/jobs-registry';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

function authorized(header: string | null): boolean {
  const secret = (process.env.JOBS_SECRET ?? '').trim();
  if (!secret) return false;
  const expected = `Bearer ${secret}`;
  const got = header ?? '';
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  // timingSafeEqual exige longitudes iguales; la comparación de longitudes no
  // filtra nada útil porque la longitud del secreto no es el secreto.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!(process.env.JOBS_SECRET ?? '').trim()) {
    return new Response('La cola no está configurada', { status: 404 });
  }
  if (!authorized(req.headers.get('authorization'))) {
    return new Response('Sin autorización', { status: 401 });
  }

  let name = '';
  let data: Record<string, unknown> = {};
  try {
    const body = (await req.json()) as { name?: string; data?: Record<string, unknown> };
    name = body.name ?? '';
    data = body.data ?? {};
  } catch {
    return Response.json({ error: 'cuerpo inválido' }, { status: 400 });
  }

  const handler = JOB_HANDLERS[name];
  if (!handler) {
    // 200 y no 404 A PROPÓSITO: un trabajo desconocido suele ser un deploy a
    // medias (el worker ya conoce el nombre, la app todavía no, o al revés).
    // Reintentarlo no lo va a arreglar; que quede registrado y la cola siga.
    logger.error('jobs: llegó un trabajo sin handler', { name });
    return Response.json({ skipped: `sin handler: ${name}` });
  }

  const started = Date.now();
  try {
    const result = await handler({ event: { name, data }, step: makeStep() });
    logger.info('jobs: trabajo terminado', { name, ms: Date.now() - started });
    return Response.json({ ok: true, result: result ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('jobs: trabajo falló', { name, ms: Date.now() - started, error: message });
    // 500 → pg-boss reintenta según el retryLimit del manifiesto.
    return Response.json({ error: message }, { status: 500 });
  }
}
