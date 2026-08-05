import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';

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
