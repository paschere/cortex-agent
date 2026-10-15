import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { chromeDevice } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

/** El estado de una sesión de tu Chrome, para el panel del chat. Solo la tuya. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await ctx.params;
  if (!chromeDevice.isChromeSessionId(id)) {
    return NextResponse.json({ error: 'Sesión inválida.' }, { status: 400 });
  }
  const db = getOrgScopedClient(user.organization.id);
  const session = await chromeDevice.getChromeSession(db, user.id, id);
  if (!session) return NextResponse.json({ error: 'No existe.' }, { status: 404 });
  const device = await chromeDevice.getDevice(db, user.id, session.deviceId);
  return NextResponse.json(
    {
      status: session.status,
      awaiting: session.awaiting,
      url: session.lastUrl,
      title: session.lastTitle,
      actions: session.actionsCount,
      cap: session.actionCap,
      deviceName: device?.name ?? null,
      deviceOnline: device?.online ?? false,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

/** «Detener» desde el chat: corta la sesión ya; la extensión se entera en su próxima espera. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await ctx.params;
  if (!chromeDevice.isChromeSessionId(id)) {
    return NextResponse.json({ error: 'Sesión inválida.' }, { status: 400 });
  }
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action !== 'stop')
    return NextResponse.json({ error: 'Acción inválida.' }, { status: 400 });
  const db = getOrgScopedClient(user.organization.id);
  const stopped = await chromeDevice.endChromeSession(db, user.id, id, {
    status: 'stopped',
    stoppedBy: 'person_panel',
  });
  return NextResponse.json({ ok: stopped });
}
