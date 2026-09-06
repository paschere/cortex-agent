import { browserService } from '@/lib/browser-service';
import { requireSession } from '@/lib/session';
import { type NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await ctx.params;
  const offset = Number(req.nextUrl.searchParams.get('offset') ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0)
    return NextResponse.json({ error: 'Posición inválida.' }, { status: 400 });
  try {
    return NextResponse.json(
      await browserService(session, `/session/${encodeURIComponent(id)}/content?offset=${offset}`),
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
