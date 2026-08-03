import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { assertCanWriteToSpace, getVisibleDocument } from '@cortex/agent-tools';
import { NotFoundError } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const sb = getSupabaseServiceClient();

  // Visibility first: a document in someone else's personal space must read as
  // missing, not as forbidden.
  let doc: Awaited<ReturnType<typeof getVisibleDocument>>;
  try {
    doc = await getVisibleDocument(sb, session.id, id);
  } catch {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  }

  // Then authority: whoever put it there can take it back, and anyone who can
  // add to the space can tidy it.
  let canDelete = doc.uploadedBy === session.id;
  if (!canDelete) {
    try {
      await assertCanWriteToSpace(sb, session.id, doc.space.id);
      canDelete = true;
    } catch (err) {
      if (err instanceof NotFoundError) {
        return NextResponse.json({ error: 'Document not found' }, { status: 404 });
      }
    }
  }
  if (!canDelete) {
    return NextResponse.json(
      { error: 'Only the person who added this, or an org admin, can remove it.' },
      { status: 403 },
    );
  }

  const { error } = await sb.from('kb_documents').delete().eq('id', id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
