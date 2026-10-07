import { openApp } from '@/lib/apps/access';
import { pushEnabled, saveSubscription, validSubscription, vapidConfig } from '@/lib/apps/push';
import { createLimiter } from '@/lib/apps/rate-limit';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Las notificaciones push de una app (0210).
 *
 *   GET     → { enabled, publicKey }: si el servidor tiene llaves VAPID y la
 *             clave pública que el navegador necesita para suscribirse. Sin
 *             llaves, `enabled: false` y la pantalla explica que los avisos
 *             llegan por correo.
 *   POST    → guarda (o cambia de dueño) la suscripción de ESTE navegador para
 *             quien está abierto: un usuario externo de la app o un miembro.
 *   DELETE  → la borra.
 *
 * La puerta es `openApp` (sesión de Cortex o cookie de la app): el navegador
 * nunca dice de quién es la suscripción. Tiene su gemela bajo
 * `/api/apps/public/…` (PUBLIC_PATHS del middleware) para los usuarios sin
 * cuenta de Cortex.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const perUser = createLimiter(30, 3_600_000);

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openApp(decodeURIComponent(id));
  if (!opened) return NextResponse.json({ error: 'No existe.' }, { status: 404 });
  return NextResponse.json(
    { enabled: pushEnabled(), publicKey: vapidConfig()?.publicKey ?? null },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openApp(decodeURIComponent(id));
  if (!opened) return NextResponse.json({ error: 'No existe.' }, { status: 404 });
  if (opened.readOnly)
    return NextResponse.json({ error: 'En «Ver como…» no se activan avisos.' }, { status: 400 });
  if (!pushEnabled())
    return NextResponse.json(
      {
        error:
          'Las notificaciones no están activas en este servidor; los avisos llegan por correo.',
      },
      { status: 409 },
    );
  if (!perUser.take(`${opened.actor.id}`))
    return NextResponse.json({ error: 'Demasiados intentos. Espera un rato.' }, { status: 429 });
  const body = (await req.json().catch(() => null)) as { subscription?: unknown } | null;
  const subscription = validSubscription(body?.subscription);
  if (!subscription)
    return NextResponse.json({ error: 'La suscripción no es válida.' }, { status: 400 });
  await saveSubscription(opened.db, {
    appId: opened.access.app.id,
    subject: opened.external
      ? { kind: 'app_user', appUserId: opened.actor.id }
      : { kind: 'member', memberId: opened.actor.id },
    subscription,
    userAgent: req.headers.get('user-agent') ?? '',
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openApp(decodeURIComponent(id));
  if (!opened) return NextResponse.json({ error: 'No existe.' }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (typeof body?.endpoint !== 'string' || body.endpoint.length > 2000)
    return NextResponse.json({ error: 'Falta el endpoint.' }, { status: 400 });
  // Sólo borra la suya: se filtra por quien está abierto.
  const column = opened.external ? 'app_user_id' : 'member_id';
  await opened.db
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', body.endpoint)
    .eq(column, opened.actor.id);
  return NextResponse.json({ ok: true });
}
