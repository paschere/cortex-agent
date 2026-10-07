import { type DriveContext, crawlSubtree, normalizeGdriveMime } from '@/app/api/kb/drive/_lib';
import { inngest } from '@/lib/inngest';
import { type JobContext, type JobHandler, enqueueJob } from '@/lib/jobs';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { type ToolContext, createIntegrationsClient, driveGet } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import {
  type ChangesResponse,
  type DriveChange,
  type DriveChangeFile,
  drainDriveChanges,
} from './drive-changes';

const GDRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

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
//
// TENANCY. The scan that finds work is install-wide and therefore unscoped —
// "every synced folder in the product" is not a question about one workspace.
// Everything after it is scoped: each sync state row names the workspace that
// owns the space, and the per-collection step builds its client from that, so a
// Drive change can only ever create, update or delete documents inside the
// workspace whose folder was being watched.
/** El cuerpo, extraído a la firma de la cola nueva; `event` no se usa. */
export const driveSyncJob: JobHandler = async ({ step }) => {
  const states = await step.run('load-sync-states', async () => {
    const db = getSupabaseServiceClient();
    const { data, error } = await db
      .from('gdrive_sync_state')
      .select(
        'collection_id, organization_id, page_token, owner_user_id, tracked_folder_ids, drive_id, drive_page_token',
      )
      .not('owner_user_id', 'is', null);
    if (error) throw new Error(`Failed to load gdrive_sync_state: ${error.message}`);
    return data ?? [];
  });

  const results: { collectionId: string; ok: boolean; error?: string }[] = [];

  for (const state of states) {
    const collectionId = state.collection_id as string;
    const organizationId = state.organization_id as string;
    const ownerUserId = state.owner_user_id as string;

    // Per-collection isolation: never let one collection abort the batch.
    const result = await step
      .run(`sync-${collectionId}`, async () => {
        const db = getOrgScopedClient(organizationId);
        const integrations = createIntegrationsClient(db, ownerUserId, logger);
        const ctx: DriveContext = { integrations, signal: undefined };

        let trackedFolderIds = ((state.tracked_folder_ids as string[] | null) ?? []).slice();
        const trackedSet = new Set(trackedFolderIds);

        // Build the collection's known source_ref set (existing gdrive docs) so a
        // file that already has a row is recognized even if its parent left the
        // tracked set. Failed rows must be retried even when the revision matches.
        const { data: existingDocs, error: docsErr } = await db
          .from('kb_documents')
          .select('id, source_ref, source_revision, status')
          .eq('collection_id', collectionId)
          .eq('source', 'gdrive');
        if (docsErr) throw new Error(`Failed to load kb_documents: ${docsErr.message}`);

        const docByRef = new Map<
          string,
          { id: string; source_revision: string | null; status: string }
        >();
        for (const d of existingDocs ?? []) {
          const ref = d.source_ref as string | null;
          if (ref) {
            docByRef.set(ref, {
              id: d.id as string,
              source_revision: (d.source_revision as string | null) ?? null,
              status: d.status as string,
            });
          }
        }

        async function drainChanges(startToken: string, driveId?: string): Promise<string> {
          return drainDriveChanges(
            startToken,
            (pageToken) => {
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
              if (driveId) params.driveId = driveId;
              return driveGet<ChangesResponse>(ctx as ToolContext, '/changes', params);
            },
            (change) =>
              applyChange({
                db,
                ctx,
                collectionId,
                ownerUserId,
                change,
                trackedSet,
                trackedFolderIds,
                docByRef,
              }),
            async (change, error) => {
              // Successful changes are idempotent, so replay the full page.
              const doc = docByRef.get(change.fileId);
              if (doc) {
                const { error: markErr } = await db
                  .from('kb_documents')
                  .update({ status: 'failed', error_message: (error as Error).message })
                  .eq('id', doc.id);
                if (markErr) throw markErr;
                doc.status = 'failed';
              }
              logger.error('drive-sync: change failed', {
                collectionId,
                fileId: change.fileId,
                error: (error as Error).message,
              });
            },
          );
        }

        let driveId = (state.drive_id as string | null) ?? null;
        let drivePageToken = (state.drive_page_token as string | null) ?? null;
        const rootFolderId = trackedFolderIds[0];
        // Existing linked folders predate the shared-drive cursor. Seed it
        // before a full crawl so the current files and concurrent edits are
        // both captured. The user feed alone omits some shared-drive changes.
        if (!drivePageToken && rootFolderId) {
          const meta = await driveGet<{ driveId?: string }>(
            ctx as ToolContext,
            `/files/${encodeURIComponent(rootFolderId)}`,
            { fields: 'driveId', supportsAllDrives: 'true' },
          );
          if (meta.driveId) {
            driveId = meta.driveId;
            const token = await driveGet<{ startPageToken: string }>(
              ctx as ToolContext,
              '/changes/startPageToken',
              { driveId, supportsAllDrives: 'true' },
            );
            drivePageToken = token.startPageToken;
            const tree = await crawlSubtree(ctx, rootFolderId);
            for (const id of tree.folderIds) trackedSet.add(id);
            for (const file of tree.files) {
              await applyChange({
                db,
                ctx,
                collectionId,
                ownerUserId,
                change: {
                  fileId: file.id,
                  file: {
                    ...file,
                    parents: [rootFolderId],
                    modifiedTime: file.modifiedTime ?? undefined,
                    md5Checksum: file.md5Checksum ?? undefined,
                  },
                },
                trackedSet,
                trackedFolderIds,
                docByRef,
              });
            }
          }
        }

        const userPageToken = await drainChanges(state.page_token as string);
        if (driveId && drivePageToken) drivePageToken = await drainChanges(drivePageToken, driveId);

        // Re-read the (possibly mutated) tracked array for persistence.
        trackedFolderIds = Array.from(trackedSet);

        // Persist the new cursor + tracked set + last_synced_at.
        const { error: updErr } = await db
          .from('gdrive_sync_state')
          .update({
            page_token: userPageToken,
            drive_id: driveId,
            drive_page_token: drivePageToken,
            tracked_folder_ids: trackedFolderIds,
            last_synced_at: new Date().toISOString(),
            last_completed_at: new Date().toISOString(),
            last_error: null,
          })
          .eq('collection_id', collectionId);
        if (updErr) throw new Error(`Failed to persist gdrive_sync_state: ${updErr.message}`);

        return { collectionId, ok: true };
      })
      .catch(async (err: unknown) => {
        // Swallow per-collection errors so the batch continues.
        logger.error('drive-sync: collection sync failed', {
          collectionId,
          error: (err as Error).message,
        });
        const { error: stateError } = await getOrgScopedClient(organizationId)
          .from('gdrive_sync_state')
          .update({ last_error: (err as Error).message.slice(0, 500) })
          .eq('collection_id', collectionId);
        if (stateError)
          logger.error('drive-sync: could not save failure status', {
            collectionId,
            error: stateError.message,
          });
        return { collectionId, ok: false, error: (err as Error).message };
      });

    results.push(result);
  }

  return { ok: true, collections: results.length, results };
};

export const driveSync = inngest.createFunction(
  { id: 'drive-sync-all' },
  { cron: '*/10 * * * *' },
  async (ctx) => driveSyncJob(ctx as unknown as JobContext),
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
  docByRef: Map<string, { id: string; source_revision: string | null; status: string }>;
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
    if (trackedSet.has(fileId)) {
      const root = args.trackedFolderIds[0];
      if (root) {
        const tree = await crawlSubtree(ctx, root);
        trackedSet.clear();
        for (const id of tree.folderIds) trackedSet.add(id);
      }
    }
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

  // 2) A new or moved subfolder may contain files that never emit an item
  //    change in the user's feed. Re-crawl the linked root and import its
  //    current files; the root is stored first in tracked_folder_ids.
  if (file.mimeType === GDRIVE_FOLDER_MIME && (trackedSet.has(fileId) || parentInTracked)) {
    const root = args.trackedFolderIds[0];
    if (root) {
      const { folderIds, files } = await crawlSubtree(ctx, root);
      trackedSet.clear();
      for (const id of folderIds) trackedSet.add(id);
      for (const child of files) {
        await applyChange({
          ...args,
          change: {
            fileId: child.id,
            file: {
              ...child,
              parents: [root],
              modifiedTime: child.modifiedTime ?? undefined,
              md5Checksum: child.md5Checksum ?? undefined,
            },
          },
        });
      }
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
    docByRef.set(fileId, { id: doc.id as string, source_revision: revision, status: 'pending' });
    await enqueueJob('kb/document.ingest', { documentId: doc.id as string });
    return;
  }

  // Existing file: skip the no-op, only re-ingest on a real revision change.
  if ((existing.source_revision ?? '') === revision && existing.status !== 'failed') return;

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
  existing.status = 'pending';
  await enqueueJob('kb/document.ingest', { documentId: existing.id });
}
