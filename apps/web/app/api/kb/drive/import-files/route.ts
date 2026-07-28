import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { type ToolContext, driveGet } from '@zipdev/agent-tools';
import { NotFoundError } from '@zipdev/core';
import { type NextRequest, NextResponse } from 'next/server';
import {
  type DriveContext,
  createGdriveDocument,
  getDriveContext,
  requireCollectionWriteAccess,
} from '../_lib';

interface ImportFile {
  id: string;
  name: string;
  mimeType: string;
}

interface ImportFilesBody {
  spaceId?: unknown;
  files?: unknown;
}

function parseFiles(files: unknown): ImportFile[] | null {
  if (!Array.isArray(files)) return null;
  const parsed: ImportFile[] = [];
  for (const f of files) {
    if (
      !f ||
      typeof f !== 'object' ||
      typeof (f as ImportFile).id !== 'string' ||
      typeof (f as ImportFile).name !== 'string' ||
      typeof (f as ImportFile).mimeType !== 'string'
    ) {
      return null;
    }
    const { id, name, mimeType } = f as ImportFile;
    parsed.push({ id, name, mimeType });
  }
  return parsed;
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  const sb = getSupabaseServiceClient();

  let body: ImportFilesBody;
  try {
    body = (await req.json()) as ImportFilesBody;
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 });
  }

  const { spaceId: collectionId } = body;
  if (!collectionId || typeof collectionId !== 'string') {
    return NextResponse.json({ error: 'Missing spaceId' }, { status: 422 });
  }

  const files = parseFiles(body.files);
  if (!files) {
    return NextResponse.json(
      { error: 'files must be an array of { id, name, mimeType }' },
      { status: 422 },
    );
  }

  try {
    const allowed = await requireCollectionWriteAccess(sb, session, collectionId);
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: 'Space not found' }, { status: 404 });
    }
    throw err;
  }

  let importedCount = 0;
  let skippedCount = 0;

  for (const file of files) {
    const { data: existing } = await sb
      .from('kb_documents')
      .select('id')
      .eq('collection_id', collectionId)
      .eq('source', 'gdrive')
      .eq('source_ref', file.id)
      .maybeSingle();

    if (existing) {
      skippedCount += 1;
      continue;
    }

    await createGdriveDocument(sb, {
      collectionId,
      fileId: file.id,
      name: file.name,
      driveMimeType: file.mimeType,
      uploadedBy: session.id,
    });
    importedCount += 1;
  }

  // Ensure a gdrive_sync_state row exists for this collection. Insert-only: an
  // existing row's page_token is a live changes cursor that must not be reset.
  const { data: syncState } = await sb
    .from('gdrive_sync_state')
    .select('collection_id')
    .eq('collection_id', collectionId)
    .maybeSingle();

  if (!syncState) {
    const driveCtx: DriveContext = await getDriveContext(session);
    const { startPageToken } = await driveGet<{ startPageToken: string }>(
      driveCtx as ToolContext,
      '/changes/startPageToken',
      { supportsAllDrives: 'true' },
    );

    await sb.from('gdrive_sync_state').insert({
      collection_id: collectionId,
      page_token: startPageToken,
      owner_user_id: session.id,
      tracked_folder_ids: [],
    });
  }

  return NextResponse.json({ importedCount, skippedCount });
}
