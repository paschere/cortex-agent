import { enqueueJob } from '@/lib/jobs';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Fire a routine right now. Emits the very same `scheduled/job.run` event the
 * minute-by-minute dispatcher emits (plus `manual: true`), so the run goes
 * through schedule-run.ts unchanged — same execution, same notifications.
 *
 * Global routines are runnable by anyone on the team; private ones only by
 * their owner.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await requireSession();
  const { id } = await params;

  const db = getOrgScopedClient(user.organization.id);
  const { data: job } = await db
    .from('scheduled_jobs')
    .select('id, user_id, is_global, status')
    .eq('id', id)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const isOwner = (job.user_id as string) === user.id;
  if (!isOwner && !(job.is_global as boolean)) {
    return NextResponse.json({ error: 'Not allowed to run this routine' }, { status: 403 });
  }

  // schedule-run.ts refuses to execute anything that is not active, so say so
  // here instead of queueing an event that would silently no-op.
  if (job.status !== 'active') {
    return NextResponse.json(
      { error: `This routine is ${job.status as string}, not active` },
      { status: 409 },
    );
  }

  // Durante la transición valen las dos colas: el worker de pg-boss si está
  // configurado, o Inngest como respaldo (es exactamente el orden que sigue
  // `enqueueJob`). Sin ninguna de las dos, decirlo aquí con un 503 es mejor
  // que encolar hacia el vacío y devolver `{ok: true}`.
  if (!process.env.JOBS_WORKER_URL && !process.env.INNGEST_SIGNING_KEY) {
    return NextResponse.json({ error: 'Background runs are not configured yet' }, { status: 503 });
  }

  const queued = await enqueueJob('scheduled/job.run', {
    jobId: job.id as string,
    // EL ESPACIO DE TRABAJO VA EN EL EVENTO, Y ES OBLIGATORIO.
    //
    // `schedule-run.ts` abre la base con un manejador acotado a esta
    // empresa, así que sin este campo hace `return { skipped: 'no
    // workspace on the event' }` y no corre nada. Faltaba, y el fallo era
    // del peor tipo: esta ruta devolvía `{ok: true}`, la pantalla decía que
    // sí, y la rutina no se ejecutaba. Nadie ve un error porque no hay
    // ninguno — simplemente no pasa nada.
    //
    // El despachador lo manda desde `job.organization_id`; aquí sale de la
    // sesión, que es la misma empresa contra la que se acaba de leer el job
    // con el manejador acotado.
    organizationId: user.organization.id,
    scheduledFor: new Date().toISOString(),
    manual: true,
  });
  if (!queued) {
    // Una rutina manual es la única encolada donde la persona está mirando:
    // aquí sí se reporta el fallo en vez de confiar en un barrido.
    return NextResponse.json({ error: 'Could not queue the run' }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
