import { NextResponse, type NextRequest } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { inngest } from '@/lib/inngest';

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export async function GET(req: NextRequest) {
  await requireSession();
  const sb = getSupabaseServiceClient();
  const url = new URL(req.url);
  const collectionId = url.searchParams.get('collectionId');

  if (!collectionId) {
    return NextResponse.json({ error: 'Missing collectionId query param' }, { status: 400 });
  }

  const { data, error } = await sb
    .from('kb_documents')
    .select('id, title, mime, status, error_message, created_at')
    .eq('collection_id', collectionId)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ documents: data ?? [] });
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  const sb = getSupabaseServiceClient();

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }

  const file = formData.get('file');
  const collectionId = formData.get('collection_id') ?? formData.get('collectionId');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file field' }, { status: 422 });
  }
  if (!collectionId || typeof collectionId !== 'string') {
    return NextResponse.json({ error: 'Missing collection_id field' }, { status: 422 });
  }

  const mime = file.type || 'application/octet-stream';
  if (!ALLOWED_MIME_TYPES.has(mime)) {
    return NextResponse.json(
      { error: `Unsupported file type: ${mime}` },
      { status: 422 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.byteLength > MAX_FILE_SIZE) {
    return NextResponse.json({ error: 'File exceeds 10MB limit' }, { status: 422 });
  }

  // Verify collection exists
  const { data: collection, error: colErr } = await sb
    .from('kb_collections')
    .select('id, scope, scope_id')
    .eq('id', collectionId)
    .single();
  if (colErr || !collection) {
    return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
  }

  // Enforce scope write authority — mirror RLS policy logic
  const userId = session.id;
  let hasWriteAccess = false;

  if (collection.scope === 'global') {
    hasWriteAccess = session.role === 'org_admin';
  } else if (collection.scope === 'team') {
    // user must be team_admin on that team (or org_admin)
    const { data: membership } = await sb
      .from('team_members')
      .select('role')
      .eq('team_id', collection.scope_id as string)
      .eq('user_id', userId)
      .maybeSingle();
    hasWriteAccess = membership?.role === 'team_admin' || session.role === 'org_admin';
  } else if (collection.scope === 'user') {
    hasWriteAccess = collection.scope_id === userId;
  } else if (collection.scope === 'conversation') {
    // user must own the conversation
    const { data: conv } = await sb
      .from('conversations')
      .select('user_id')
      .eq('id', collection.scope_id as string)
      .maybeSingle();
    hasWriteAccess = conv?.user_id === userId;
  }

  if (!hasWriteAccess) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const documentId = randomUUID();
  const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${session.id}/${documentId}/${safeFileName}`;

  // Upload to Supabase storage
  const { error: uploadError } = await sb.storage
    .from('kb-uploads')
    .upload(storagePath, buffer, {
      contentType: mime,
      upsert: false,
    });
  if (uploadError) {
    return NextResponse.json(
      { error: `Storage upload failed: ${uploadError.message}` },
      { status: 500 },
    );
  }

  // Insert kb_documents row
  const { data: doc, error: insertError } = await sb
    .from('kb_documents')
    .insert({
      id: documentId,
      collection_id: collectionId,
      source: 'upload',
      source_ref: storagePath,
      title: file.name,
      mime,
      sha256,
      uploaded_by: session.id,
      status: 'pending',
    })
    .select('*')
    .single();

  if (insertError) {
    // Attempt to clean up orphaned storage object
    await sb.storage.from('kb-uploads').remove([storagePath]);
    return NextResponse.json(
      { error: `DB insert failed: ${insertError.message}` },
      { status: 500 },
    );
  }

  // Emit ingest event to Inngest
  await inngest.send({
    name: 'kb/document.ingest',
    data: { documentId },
  });

  return NextResponse.json({ document: doc }, { status: 201 });
}
