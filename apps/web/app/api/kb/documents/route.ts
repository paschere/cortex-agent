import { createHash, randomUUID } from 'node:crypto';
import { readBrain } from '@/app/(app)/kb/_lib/brain';
import { putFileDirect, removeFilesDirect } from '@/lib/files-db';
import { enqueueJob } from '@/lib/jobs';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { assertCanWriteToSpace, ensurePersonalSpace, getVisibleSpace } from '@cortex/agent-tools';
import { ForbiddenError, NotFoundError } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
]);

/**
 * Audio is held to a different rule than text, so it gets its own set rather
 * than more entries in the one above. Both x-m4a and mp4 are listed because
 * the same .m4a is labelled one way by Safari and the other by Chrome, and
 * audio/webm is what the browser recorder produces.
 */
const AUDIO_MIME_TYPES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/ogg',
  'audio/x-m4a',
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * An hour-long call is tens of megabytes compressed. Was the bucket's own
 * limit (0058) when files lived in Storage; now that they live in app_files
 * (0109) this check IS the ceiling, and it still rejects an oversized upload
 * with a sentence before the bytes are pushed anywhere.
 */
const MAX_AUDIO_SIZE = 200 * 1024 * 1024; // 200MB

/** MediaRecorder labels its output `audio/webm;codecs=opus`. */
function baseMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * List the documents in one space. Polled while an upload is being indexed, so
 * it stays a REST route rather than a server action.
 *
 * `?digest=1` answers a different question with the same data: how much of the
 * whole Knowledge Base is still being swallowed. The Brain Knowledge page polls
 * it while anything is in flight, so the counts on screen move as documents
 * finish rather than only on a reload. It never widens what a caller can see —
 * `readBrain` starts from `listVisibleSpaces`, exactly like the page does.
 */
export async function GET(req: NextRequest) {
  const session = await requireSession();
  const sb = getOrgScopedClient(session.organization.id);
  const url = new URL(req.url);
  const spaceId = url.searchParams.get('spaceId');

  if (url.searchParams.get('digest') === '1') {
    const { stats } = await readBrain(sb, session.id);
    return NextResponse.json({ stats });
  }

  if (!spaceId) {
    return NextResponse.json({ error: 'Missing spaceId query param' }, { status: 400 });
  }

  // The space id comes off the query string, so it has to be checked. Without
  // this the titles of every private document in the workspace are one guessed
  // uuid away.
  try {
    await getVisibleSpace(sb, session.id, spaceId);
  } catch {
    return NextResponse.json({ error: 'Space not found' }, { status: 404 });
  }

  const { data, error } = await sb
    .from('kb_documents')
    .select(
      'id, title, mime, status, error_message, source, created_at, media_kind, duration_seconds, transcript_status, transcript_error, speakers, recorded_at',
    )
    .eq('collection_id', spaceId)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ documents: data ?? [] });
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  const sb = getOrgScopedClient(session.organization.id);

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }

  const file = formData.get('file');
  const requestedSpace = formData.get('space_id') ?? formData.get('spaceId');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file field' }, { status: 422 });
  }

  const mime = baseMime(file.type) || 'application/octet-stream';
  const isAudio = AUDIO_MIME_TYPES.has(mime);
  if (!isAudio && !ALLOWED_MIME_TYPES.has(mime)) {
    return NextResponse.json({ error: `Unsupported file type: ${mime}` }, { status: 422 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const sizeLimit = isAudio ? MAX_AUDIO_SIZE : MAX_FILE_SIZE;
  if (buffer.byteLength > sizeLimit) {
    return NextResponse.json(
      {
        error: isAudio
          ? 'That recording is over the 200MB limit. An hour of compressed audio is well under it — an uncompressed WAV is not, so export it as MP3 or M4A first.'
          : 'File exceeds 10MB limit',
      },
      { status: 422 },
    );
  }

  // No space named means "mine": a file dropped into a chat belongs to the
  // person who dropped it until they decide otherwise.
  let spaceId: string;
  try {
    if (typeof requestedSpace === 'string' && requestedSpace) {
      await assertCanWriteToSpace(sb, session.id, requestedSpace);
      spaceId = requestedSpace;
    } else {
      spaceId = (await ensurePersonalSpace(sb, session.id)).id;
    }
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: 'Space not found' }, { status: 404 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const documentId = randomUUID();
  const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${session.id}/${documentId}/${safeFileName}`;

  // Por pg directo y no por la capa PostgREST de agent-tools: este camino
  // acepta audio de hasta 200MB, que en hex serían 400MB de JSON — ver el
  // argumento en lib/files-db.ts. La ruta se conserva idéntica a la que usaba
  // Storage, así que todo lo que la lee (ingest, la mudanza) sigue igual.
  try {
    await putFileDirect({
      organizationId: session.organization.id,
      bucket: 'kb-uploads',
      path: storagePath,
      content: buffer,
      contentType: mime,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Storage upload failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  // "Recorded in the browser just now" and "a file someone already had" are
  // different provenance and the answer should be able to say which. Only the
  // recorder sends this flag; everything else is an ordinary upload.
  const capturedHere = formData.get('captured') === 'recording';

  // The conversation almost never happened when the file was uploaded — a call
  // exported on Monday may be from last Thursday, and that is the date an
  // answer should cite. The client sends what it knows; a browser recording
  // knows it exactly, an uploaded file usually does not.
  const recordedAtRaw = formData.get('recorded_at');
  const recordedAt =
    typeof recordedAtRaw === 'string' && !Number.isNaN(Date.parse(recordedAtRaw))
      ? new Date(recordedAtRaw).toISOString()
      : new Date().toISOString();

  const { data: doc, error: insertError } = await sb
    .from('kb_documents')
    .insert({
      id: documentId,
      collection_id: spaceId,
      source: isAudio ? (capturedHere ? 'recording' : 'audio') : 'upload',
      source_ref: storagePath,
      title: file.name,
      mime,
      sha256,
      uploaded_by: session.id,
      status: 'pending',
      // media_kind is what the ingestion worker branches on. It is set here
      // rather than inferred there so that one place decides what a file is.
      ...(isAudio
        ? {
            media_kind: 'audio',
            media_path: storagePath,
            transcript_status: 'pending',
            recorded_at: recordedAt,
          }
        : {}),
    })
    .select('*')
    .single();

  if (insertError) {
    // Attempt to clean up orphaned file row
    await removeFilesDirect('kb-uploads', [storagePath]).catch(() => {});
    return NextResponse.json(
      { error: `DB insert failed: ${insertError.message}` },
      { status: 500 },
    );
  }

  await enqueueJob('kb/document.ingest', { documentId });

  return NextResponse.json({ document: doc }, { status: 201 });
}
