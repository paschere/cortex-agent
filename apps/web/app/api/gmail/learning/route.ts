import { enqueueJob } from '@/lib/jobs';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  BACKFILL_WINDOWS,
  type BackfillWindow,
  createIntegrationsClient,
  ensurePersonalSpace,
  fetchProfile,
  getSyncState,
  setPaused,
  startTraining,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * EL INTERRUPTOR DEL BUZÓN, desde la pantalla.
 *
 * No hay parámetro de persona y no puede haberlo: el buzón que se lee es el de
 * quien pide, sale de la sesión, y el sitio donde aterriza es su espacio
 * personal — el que sólo esa persona puede leer. Encender esto para otro no es
 * algo que esta ruta pueda expresar.
 *
 * La misma decisión que ya toma `inbox.priorities`: un correo es el objeto más
 * privado que toca este producto, y la manera de que nadie lea el de nadie no
 * es una comprobación de permisos, es que no haya dónde escribir el nombre.
 */

const WINDOWS = Object.keys(BACKFILL_WINDOWS) as BackfillWindow[];

export async function GET(): Promise<NextResponse> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const state = await getSyncState(db, user.id);
  return NextResponse.json({ state });
}

export async function POST(request: Request): Promise<NextResponse> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const body = (await request.json().catch(() => ({}))) as {
    action?: 'start' | 'stop';
    window?: string;
  };

  if (body.action === 'stop') {
    await setPaused(db, user.id, true, 'Apagado desde Integraciones.');
    return NextResponse.json({ ok: true, paused: true });
  }

  const window = (body.window ?? '12m') as BackfillWindow;
  if (!WINDOWS.includes(window)) {
    return NextResponse.json(
      { error: `Ventana no válida. Las que hay: ${WINDOWS.join(', ')}.` },
      { status: 400 },
    );
  }

  // El espacio personal se crea en el primer uso, igual que en cualquier otra
  // cosa que Cortex guarda sin que le digan dónde. Que el destino por defecto
  // sea el privado no es una preferencia: lo que debía ser compartido se mueve
  // con un clic, lo que debía ser privado y no lo fue no se despublica.
  const space = await ensurePersonalSpace(db, user.id);

  const integrations = createIntegrationsClient(db, user.id, logger);
  let profile: { emailAddress: string; historyId: string | null };
  try {
    profile = await fetchProfile({ integrations, signal: undefined });
  } catch (err) {
    // El caso normal aquí es «la cuenta de Google no está conectada, o no dio
    // el permiso de lectura». Se dice con esas palabras y con el sitio donde se
    // arregla, en vez de con el código de estado de Google.
    return NextResponse.json(
      {
        error:
          'No pude entrar a tu Gmail. Conecta tu cuenta de Google (o vuelve a conectarla si le quitaste permisos) y lo intento otra vez.',
        detail: (err as Error).message,
      },
      { status: 400 },
    );
  }

  const state = await startTraining(db, {
    userId: user.id,
    emailAddress: profile.emailAddress,
    spaceId: space.id,
    window,
    historyId: profile.historyId,
  });

  const queued = await enqueueJob('gmail/backfill.user', {
    userId: user.id,
    organizationId: user.organization.id,
  });

  return NextResponse.json({ ok: true, state, spaceName: space.name, queued });
}
