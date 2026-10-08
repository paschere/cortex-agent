import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/** Renombrar: sólo el título, sólo de una conversación propia. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const body = (await req.json().catch(() => null)) as { title?: unknown } | null;
  const title = typeof body?.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : '';
  if (!title || title.length > 120) {
    return NextResponse.json({ error: 'Título inválido' }, { status: 400 });
  }
  const db = getOrgScopedClient(user.organization.id);
  const { data: conv, error: readError } = await db
    .from('conversations')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (readError) {
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }
  if (!conv) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { error } = await db
    .from('conversations')
    .update({ title })
    .eq('id', id)
    .eq('user_id', user.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, title });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  // Ownership check — only delete the caller's own conversation.
  const { data: conv } = await db
    .from('conversations')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!conv) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // messages cascade-delete via FK (on delete cascade).
  const { error } = await db.from('conversations').delete().eq('id', id).eq('user_id', user.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
