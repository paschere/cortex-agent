import { pushEnabled, validSubscription, vapidConfig } from '@/lib/apps/push';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Las notificaciones push de la app principal (0220): «Tu día» y lo urgente en
 * este navegador.
 *
 *   GET     → { enabled, publicKey } (sin llaves VAPID: enabled false)
 *   POST    → guarda la suscripción de ESTE navegador para quien tiene la sesión
 *   DELETE  → la borra
 *
 * La persona sale de la sesión, nunca del cuerpo. La suscripción queda en la
 * empresa activa; si la misma persona usa otra empresa, activa los avisos allí.
 */

export async function GET() {
  await requireSession();
  return NextResponse.json(
    { enabled: pushEnabled(), publicKey: vapidConfig()?.publicKey ?? null },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function POST(req: NextRequest) {
  const user = await requireSession();
  if (!pushEnabled())
    return NextResponse.json(
      { error: 'Las notificaciones no están activas en este servidor.' },
      { status: 409 },
    );
  const body = (await req.json().catch(() => null)) as { subscription?: unknown } | null;
  const subscription = validSubscription(body?.subscription);
  if (!subscription)
    return NextResponse.json({ error: 'La suscripción no es válida.' }, { status: 400 });
  const db = getOrgScopedClient(user.organization.id);
  const { error } = await db.from('push_subscriptions').upsert(
    {
      app_id: null,
      subject_kind: 'member',
      member_id: user.id,
      app_user_id: null,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300),
    },
    { onConflict: 'endpoint' },
  );
  if (error) throw error;
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const user = await requireSession();
  const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (typeof body?.endpoint !== 'string')
    return NextResponse.json({ error: 'Falta el endpoint.' }, { status: 400 });
  // Sólo borra la suya: el endpoint + la persona de la sesión.
  await getOrgScopedClient(user.organization.id)
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', body.endpoint)
    .eq('member_id', user.id);
  return NextResponse.json({ ok: true });
}
