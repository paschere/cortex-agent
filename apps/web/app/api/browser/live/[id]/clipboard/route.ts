import { browserService } from '@/lib/browser-service';
import { requireSession } from '@/lib/session';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
export const runtime = 'nodejs';
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await ctx.params;
  const parsed = z
    .object({
      op: z.enum(['copy', 'paste', 'select_all', 'clear']),
      text: z.string().max(100000).optional(),
    })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: 'Acción de portapapeles inválida.' }, { status: 400 });
  try {
    return NextResponse.json(
      await browserService(
        session,
        `/session/${encodeURIComponent(id)}/clipboard`,
        'POST',
        parsed.data,
      ),
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
