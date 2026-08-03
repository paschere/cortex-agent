import { type DriveContext, crawlSubtree, normalizeGdriveMime } from '@/app/api/kb/drive/_lib';
import { inngest } from '@/lib/inngest';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { type ToolContext, createIntegrationsClient, driveGet } from '@cortex/agent-tools';
import { logger } from '@cortex/core';

const GDRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

interface DriveChangeFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime?: string;
  trashed?: boolean;
  md5Checksum?: string;
}

interface DriveChange {
  removed?: boolean;
  fileId: string;
  file?: DriveChangeFile;
}

interface ChangesResponse {
  newStartPageToken?: string;
  nextPageToken?: string;
  changes?: DriveChange[];
}

/**
 * The revision key we persist on kb_documents.source_revision and compare against
 * on each change to decide whether a file actually changed. Google-native docs
 * (Docs/Sheets/Slides) have no md5Checksum, so fall back to modifiedTime.
 */
function revisionOf(file: DriveChangeFile): string {
  return file.md5Checksum ?? file.modifiedTime ?? '';
}

// Incremental Google Drive sync. Runs every 10 minutes and drains the Drive
// Changes API for every collection that has an owner. Each collection is synced
// in its own step.run so one collection's failure can't abort the batch.
export const driveSync = inngest.createFunction(
  { id: 'drive-sync-all' },
  { cron: '*/10 * * * *' },
  async ({ step }) => {
    const states = await step.run('load-sync-states', async () => {
      const db = getSupabaseServiceClient();
      const { data, error } = await db
        .from('gdrive_sync_state')
        .select('collection_id, page_token, owner_user_id, tracked_folder_ids')
        .not('owner_user_id', 'is', null);
      if (error) throw new Error(`Failed to load gdrive_sync_state: ${error.message}`);
      return data ?? [];
    });

    const results: { collectionId: string; ok: boolean; error?: string }[] = [];

    for (const state of states) {
      const collectionId = state.collection_id as string;
      const ownerUserId = state.owner_user_id as string;

      // Per-collection isolation: never let one collection abort the batch.
      const result = await step
        .run(`sync-${collectionId}`, async () => {
          const db = getSupabaseServiceClient();
          const integrations = createIntegrationsClient(db, ownerUserId, logger);
          const ctx: DriveContext = { integrations, signal: undefined };

          let trackedFolderIds = ((state.tracked_folder_ids as string[] | null) ?? []).slice();
          const trackedSet = new Set(trackedFolderIds);

          // Build the collection's known source_ref set (existing gdrive docs) so a
          // file that already has a row is recognized even if its parent left the
          // tracked set. Map fileId -> { id, source_revision }.
          const { data: existingDocs, error: docsErr } = await db
            .from('kb_documents')
            .select('id, source_ref, source_revision')
            .eq('collection_id', collectionId)
            .eq('source', 'gdrive');
          if (docsErr) throw new Error(`Failed to load kb_documents: ${docsErr.message}`);

          const docByRef = new Map<string, { id: string; source_revision: string | null }>();
          for (const d of existingDocs ?? []) {
            const ref = d.source_ref as string | null;
            if (ref) {
              docByRef.set(ref, {
                id: d.id as string,
                source_revision: (d.source_revision as string | null) ?? null,
              });
            }
          }

          // Drain the Changes API from the stored page_token until newStartPageToken.
          let pageToken: string = state.page_token as string;
          let newStartPageToken: string | undefined;

          do {
            const params: Record<string, string> = {
              pageToken,
              pageSize: '1000',
              includeRemoved: 'true',
              spaces: 'drive',
              supportsAllDrives: 'true',
              includeItemsFromAllDrives: 'true',
              fields:
                'newStartPageToken,nextPageToken,changes(removed,fileId,file(id,name,mimeType,parents,modifiedTime,trashed,md5Checksum))',
            };
            const page = await driveGet<ChangesResponse>(ctx as ToolContext, '/changes', params);

            for (const change of page.changes ?? []) {
              try {
                await applyChange({
                  db,
                  ctx,
                  collectionId,
                  ownerUserId,
                  change,
                  trackedSet,
                  trackedFolderIds,
                  docByRef,
                });
              } catch (fileErr) {
                // Per-file isolation: mark the doc failed (if known) but keep draining.
                const ref = change.fileId;
                const doc = docByRef.get(ref);
                if (doc) {
                  await db
                    .from('kb_documents')
                    .update({ status: 'failed', error_message: (fileErr as Error).message })
                    .eq('id', doc.id);
                }
                logger.error('drive-sync: change failed', {
                  collectionId,
                  fileId: ref,
                  error: (fileErr as Error).message,
                });
              }
            }

            newStartPageToken = page.newStartPageToken;
            pageToken = page.nextPageToken ?? '';
          } while (!newStartPageToken && pageToken);

          // Re-read the (possibly mutated) tracked array for persistence.
          trackedFolderIds = Array.from(trackedSet);

          // Persist the new cursor + tracked set + last_synced_at.
          const { error: updErr } = await db
            .from('gdrive_sync_state')
            .update({
              page_token: newStartPageToken ?? pageToken,
              tracked_folder_ids: trackedFolderIds,
              last_synced_at: new Date().toISOString(),
            })
            .eq('collection_id', collectionId);
          if (updErr) throw new Error(`Failed to persist gdrive_sync_state: ${updErr.message}`);

          return { collectionId, ok: true };
        })
        .catch((err: unknown) => {
          // Swallow per-collection errors so the batch continues.
          logger.error('drive-sync: collection sync failed', {
            collectionId,
            error: (err as Error).message,
          });
          return { collectionId, ok: false, error: (err as Error).message };
        });

      results.push(result);
    }

    return { ok: true, collections: results.length, results };
  },
);

/** Mutates trackedSet in place when a tracked folder moves. */
async function applyChange(args: {
  db: ReturnType<typeof getSupabaseServiceClient>;
  ctx: DriveContext;
  collectionId: string;
  ownerUserId: string;
  change: DriveChange;
  trackedSet: Set<string>;
  trackedFolderIds: string[];
  docByRef: Map<string, { id: string; source_revision: string | null }>;
}): Promise<void> {
  const { db, ctx, collectionId, ownerUserId, change, trackedSet, docByRef } = args;
  const fileId = change.fileId;
  const file = change.file;
  const existing = docByRef.get(fileId);

  const parents = file?.parents ?? [];
  const parentInTracked = parents.some((p) => trackedSet.has(p));

  // 1) DELETE: removed, trashed, or a known file moved out of the tracked set.
  //    The moved-out check (row exists AND parents no longer intersect tracked)
  //    MUST come before the source_ref fallback so moved files are deleted, not
  //    re-upserted.
  const removed = change.removed === true || file?.trashed === true;
  const movedOut = !removed && existing != null && parents.length > 0 && !parentInTracked;

  if (removed || movedOut) {
    if (existing) {
      // kb_chunks cascade on kb_documents delete (FK on delete cascade).
      const { error } = await db.from('kb_documents').delete().eq('id', existing.id);
      if (error) throw new Error(`Failed to delete kb_documents row: ${error.message}`);
      docByRef.delete(fileId);
    }
    return;
  }

  // No usable file metadata and not a delete -> nothing actionable.
  if (!file) return;

  // 2) Folder move: a tracked folder whose parents changed. Recompute the subtree
  //    from the tracked root and replace the tracked set. The root is assumed to
  //    be the first stored tracked folder id (crawlSubtree emits the root first
  //    on initial sync, so tracked_folder_ids[0] is the root).
  if (file.mimeType === GDRIVE_FOLDER_MIME && trackedSet.has(fileId)) {
    const root = args.trackedFolderIds[0];
    if (root) {
      const { folderIds } = await crawlSubtree(ctx, root);
      trackedSet.clear();
      for (const id of folderIds) trackedSet.add(id);
    }
    return;
  }

  // 3) UPSERT: file lives in the tracked set (parent tracked) or already has a row.
  if (!parentInTracked && existing == null) return;

  const revision = revisionOf(file);

  if (existing == null) {
    // New file: insert + emit ingest.
    const { data: doc, error } = await db
      .from('kb_documents')
      .insert({
        collection_id: collectionId,
        source: 'gdrive',
        source_ref: fileId,
        title: file.name,
        mime: normalizeGdriveMime(file.mimeType),
        sha256: '',
        source_revision: revision,
        uploaded_by: ownerUserId,
        status: 'pending',
      })
      .select('id')
      .single();
    if (error || !doc) {
      throw new Error(`Failed to insert kb_documents row: ${error?.message ?? 'unknown error'}`);
    }
    docByRef.set(fileId, { id: doc.id as string, source_revision: revision });
    await inngest.send({ name: 'kb/document.ingest', data: { documentId: doc.id as string } });
    return;
  }

  // Existing file: skip the no-op, only re-ingest on a real revision change.
  if ((existing.source_revision ?? '') === revision) return;

  const { error: updErr } = await db
    .from('kb_documents')
    .update({
      title: file.name,
      mime: normalizeGdriveMime(file.mimeType),
      source_revision: revision,
      status: 'pending',
      error_message: null,
    })
    .eq('id', existing.id);
  if (updErr) throw new Error(`Failed to update kb_documents row: ${updErr.message}`);
  existing.source_revision = revision;
  await inngest.send({ name: 'kb/document.ingest', data: { documentId: existing.id } });
}
