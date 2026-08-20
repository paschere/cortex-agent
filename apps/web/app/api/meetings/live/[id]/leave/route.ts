import { requireSession } from '@/lib/session';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/** El botón «salir de la reunión»: le dice al bot que cuelgue. */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await ctx.params;
  const base = process.env.MEET_SERVICE_URL?.replace(/\/+$/, '');
  const token = process.env.MEET_SERVICE_TOKEN;
  if (!base || !token) return NextResponse.json({ error: 'no configurado' }, { status: 503 });
  await fetch(`${base}/session/${encodeURIComponent(id)}/leave`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => undefined);
  return NextResponse.json({ ok: true });
}
