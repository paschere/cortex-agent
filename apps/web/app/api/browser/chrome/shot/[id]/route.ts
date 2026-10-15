import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { chromeDevice } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 15;

/** La foto chica de un paso en tu Chrome. Solo la ve su dueño. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await ctx.params;
  const b64 = await chromeDevice.getShot(getOrgScopedClient(user.organization.id), user.id, id);
  if (!b64) return NextResponse.json({ error: 'Esa foto ya no está.' }, { status: 404 });
  return new NextResponse(Buffer.from(b64, 'base64'), {
    status: 200,
    headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=21600, immutable' },
  });
}
