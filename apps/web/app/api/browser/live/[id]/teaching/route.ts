import { browserService } from '@/lib/browser-service';
import { requireSession } from '@/lib/session';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handle(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await ctx.params;
  const parsed =
    req.method === 'POST'
      ? z
          .discriminatedUnion('op', [
            z.object({ op: z.literal('start') }),
            z.object({ op: z.literal('stop') }),
            z.object({
              op: z.literal('navigate'),
              url: z
                .string()
                .url()
                .max(2000)
                .refine((s) => /^https?:\/\//.test(s)),
            }),
            z.object({
              op: z.literal('explain'),
              index: z.number().int().min(0).max(59),
              text: z.string().max(2000),
            }),
          ])
          .safeParse(await req.json().catch(() => null))
      : undefined;
  if (parsed && !parsed.success)
    return NextResponse.json({ error: 'Acción inválida.' }, { status: 400 });
  try {
    return NextResponse.json(
      await browserService(
        session,
        `/session/${encodeURIComponent(id)}/teaching`,
        req.method,
        parsed?.success ? parsed.data : undefined,
      ),
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
export const GET = handle;
export const POST = handle;
