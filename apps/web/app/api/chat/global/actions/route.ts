import { auth } from '@/lib/auth';
import { decideGlobalAction, listGlobalActions } from '@/lib/global-chat/actions';
import { headers } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
export const runtime = 'nodejs';
export const maxDuration = 300;
const Decision = z.object({
  proposalId: z.string().uuid(),
  decision: z.enum(['approve', 'reject']),
});
async function account() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) throw new Error('Sin sesión.');
  return session.user.id;
}
export async function GET(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('conversationId');
    if (!id || !z.string().uuid().safeParse(id).success)
      return NextResponse.json({ error: 'Conversación inválida.' }, { status: 400 });
    return NextResponse.json({ proposals: await listGlobalActions(await account(), id) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'No autorizado.' },
      { status: 403 },
    );
  }
}
export async function POST(req: NextRequest) {
  const parsed = Decision.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Decisión inválida.' }, { status: 400 });
  try {
    return NextResponse.json({
      proposal: await decideGlobalAction({ accountId: await account(), ...parsed.data }),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'No se pudo decidir.' },
      { status: 409 },
    );
  }
}
