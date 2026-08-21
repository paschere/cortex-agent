import { requireSession } from '@/lib/session';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Snapshot del transcript y el estado. La sala en vivo lo consulta en poll
 * corto porque el SSE proxied por Vercel se bufferiza y llega tarde.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await ctx.params;
  const base = process.env.MEET_SERVICE_URL?.replace(/\/+$/, '');
  const token = process.env.MEET_SERVICE_TOKEN;
  if (!base || !token) {
    return NextResponse.json(
      { error: 'El bot de reuniones no está configurado.' },
      { status: 503 },
    );
  }
  const upstream = await fetch(
    `${base}/session/${encodeURIComponent(id)}?owner=${encodeURIComponent(user.organization.id)}`,
    {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    },
  ).catch(() => null);
  if (!upstream || !upstream.ok) {
    return NextResponse.json({ error: 'Esa reunión ya no está en vivo.' }, { status: 410 });
  }
  return NextResponse.json(await upstream.json(), {
    headers: { 'cache-control': 'no-store' },
  });
}
