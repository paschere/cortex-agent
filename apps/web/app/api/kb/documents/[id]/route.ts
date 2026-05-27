import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  const { id } = await params;
  const sb = getSupabaseServiceClient();

  // Fetch document to verify ownership / existence
  const { data: doc, error: fetchErr } = await sb
    .from('kb_documents')
    .select('id, uploaded_by, collection_id')
    .eq('id', id)
    .single();

  if (fetchErr || !doc) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  }

  // Only the uploader or an org_admin may delete
  if (doc.uploaded_by !== session.id && session.role !== 'org_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { error } = await sb.from('kb_documents').delete().eq('id', id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
