import { loadDetail } from '@/lib/errands/repository';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Everything about one errand, for the screen to poll.
 *
 * A poll rather than SSE, and that is a deliberate difference from the
 * orchestrator's console. The console tails an append-only log at 2 Hz because
 * it is watching individual tool calls land; an errand changes state a handful
 * of times over forty minutes. Holding a connection open for that would be
 * expensive theatre. What a person actually wants to watch second by second —
 * which sub-agent is doing what right now — already has a live console, and
 * the errand screen links straight into it rather than building a second one.
 *
 * Scoped to the active workspace, so an errand id from another tenant is a 404
 * and not a document.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await requireSession();
  const { id } = await params;
  const detail = await loadDetail(
    getOrgScopedClient(user.organization.id),
    id,
    user.organization.id,
  );
  if (!detail) return NextResponse.json({ error: 'No existe ese encargo.' }, { status: 404 });
  return NextResponse.json(detail);
}
