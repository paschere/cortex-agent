import { canSeeTask } from '@/lib/background-tasks/scope';
import { taskViewerFor } from '@/lib/background-tasks/viewer';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { canRevokeShare } from '@/lib/task-share/shape';
import { loadShare, loadTaskById, revokeShare } from '@/lib/task-share/store';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const ID = /^[0-9a-f-]{36}$/i;

/** Revocar: el enlace deja de abrir ya, y se borran sus capturas. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; shareId: string }> },
) {
  const user = await requireSession();
  const { id, shareId } = await params;
  const notFound = NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  if (!ID.test(id) || !ID.test(shareId)) return notFound;
  const db = getOrgScopedClient(user.organization.id);
  const task = await loadTaskById(db, id);
  const viewer = await taskViewerFor(user);
  if (!task || !canSeeTask(viewer, task)) return notFound;
  const share = await loadShare(db, shareId);
  if (!share || share.taskId !== task.id) return notFound;
  if (!canRevokeShare(viewer, share, task)) {
    return NextResponse.json({ error: 'No puedes revocar este enlace.' }, { status: 403 });
  }
  const ok = await revokeShare(db, {
    shareId,
    actorId: user.id,
    conversationId: task.conversationId,
  });
  return ok ? NextResponse.json({ ok: true }) : notFound;
}
