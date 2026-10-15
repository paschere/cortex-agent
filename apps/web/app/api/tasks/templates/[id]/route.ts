import { taskViewerFor } from '@/lib/background-tasks/viewer';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/** Archivar una plantilla de la empresa (no se borra: queda en la base). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
  const viewer = await taskViewerFor(user);
  if (!viewer.isManager) {
    return NextResponse.json(
      { error: 'Sólo quien administra puede quitar plantillas.' },
      { status: 403 },
    );
  }
  const db = getOrgScopedClient(user.organization.id);
  const { data } = await db
    .from('task_templates')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)
    .is('archived_at', null)
    .select('id')
    .maybeSingle();
  if (!data) return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
  await db
    .from('audit_events')
    .insert({
      user_id: user.id,
      tool_id: 'task.template_remove',
      input_hash: id,
      status: 'ok',
      latency_ms: 0,
      metadata: {},
    })
    .then(undefined, () => undefined);
  return NextResponse.json({ ok: true });
}
