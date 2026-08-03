import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { type ToolContext, driveGet } from '@cortex/agent-tools';
import { NotFoundError } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  type DriveContext,
  crawlSubtree,
  createGdriveDocument,
  getDriveContext,
  requireCollectionWriteAccess,
} from '../_lib';

const LinkFolderBody = z.object({
  spaceId: z.string().uuid(),
  folderId: z.string().min(1),
  folderName: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const session = await requireSession();
  const sb = getSupabaseServiceClient();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = LinkFolderBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const { spaceId: collectionId, folderId } = parsed.data;

  // Authorize: 404 when the space is missing or not the caller's, 403 when it
  // exists for them but they may not add to it.
  let canWrite: boolean;
  try {
    canWrite = await requireCollectionWriteAccess(sb, session, collectionId);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: 'Space not found' }, { status: 404 });
    }
    throw err;
  }
  if (!canWrite) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Read the current linked folder so we can detect a change-of-folder.
  const { data: collection, error: colErr } = await sb
    .from('kb_collections')
    .select('gdrive_folder_id')
    .eq('id', collectionId)
    .single();
  if (colErr || !collection) {
    return NextResponse.json({ error: 'Space not found' }, { status: 404 });
  }
  const priorFolderId = (collection.gdrive_folder_id as string | null) ?? null;

  const ctx: DriveContext = await getDriveContext(session);

  // Crawl the new folder subtree up front: we need the full file set both for the
  // change-of-folder cleanup (which docs survive) and for the import below.
  const { files } = await crawlSubtree(ctx, folderId);
  const keepRefs = new Set(files.map((f) => f.id));

  // Change-folder default: when re-pointing to a DIFFERENT folder, drop the prior
  // folder's gdrive documents that are not reachable in the new tree. Individually
  // imported docs that still live somewhere in the new tree are kept. Chunks cascade.
  if (priorFolderId && priorFolderId !== folderId) {
    const { data: existingDocs, error: existingErr } = await sb
      .from('kb_documents')
      .select('id, source_ref')
      .eq('collection_id', collectionId)
      .eq('source', 'gdrive');
    if (existingErr) {
      return NextResponse.json({ error: existingErr.message }, { status: 500 });
    }
    const staleIds = (existingDocs ?? [])
      .filter((d) => !keepRefs.has(d.source_ref as string))
      .map((d) => d.id as string);
    if (staleIds.length > 0) {
      const { error: delErr } = await sb.from('kb_documents').delete().in('id', staleIds);
      if (delErr) {
        return NextResponse.json({ error: delErr.message }, { status: 500 });
      }
    }
  }

  // Point the collection at the new folder.
  const { error: updErr } = await sb
    .from('kb_collections')
    .update({ gdrive_folder_id: folderId })
    .eq('id', collectionId);
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  // Upsert sync state. Cursor-clobber rule: page_token is seeded ONLY on insert;
  // an existing row keeps its cursor and only refreshes owner + tracked folders.
  const { data: syncRow, error: syncSelErr } = await sb
    .from('gdrive_sync_state')
    .select('collection_id')
    .eq('collection_id', collectionId)
    .maybeSingle();
  if (syncSelErr) {
    return NextResponse.json({ error: syncSelErr.message }, { status: 500 });
  }

  if (syncRow) {
    const { error: syncUpdErr } = await sb
      .from('gdrive_sync_state')
      .update({
        owner_user_id: session.id,
        tracked_folder_ids: [folderId],
      })
      .eq('collection_id', collectionId);
    if (syncUpdErr) {
      return NextResponse.json({ error: syncUpdErr.message }, { status: 500 });
    }
  } else {
    const { startPageToken } = await driveGet<{ startPageToken: string }>(
      ctx as ToolContext,
      '/changes/startPageToken',
      { supportsAllDrives: 'true' },
    );
    const { error: syncInsErr } = await sb.from('gdrive_sync_state').insert({
      collection_id: collectionId,
      owner_user_id: session.id,
      tracked_folder_ids: [folderId],
      page_token: startPageToken,
    });
    if (syncInsErr) {
      return NextResponse.json({ error: syncInsErr.message }, { status: 500 });
    }
  }

  // Import every non-folder file (createGdriveDocument dedupes on source_ref).
  let importedCount = 0;
  for (const file of files) {
    await createGdriveDocument(sb, {
      collectionId,
      fileId: file.id,
      name: file.name,
      driveMimeType: file.mimeType,
      uploadedBy: session.id,
    });
    importedCount += 1;
  }

  return NextResponse.json({ linked: true, importedCount });
}
