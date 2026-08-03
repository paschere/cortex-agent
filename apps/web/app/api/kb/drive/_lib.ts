import 'server-only';
import { inngest } from '@/lib/inngest';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  type ToolContext,
  assertCanWriteToSpace,
  createIntegrationsClient,
  driveGet,
} from '@cortex/agent-tools';
import { NotFoundError, type SessionUser, logger } from '@cortex/core';

type Db = ReturnType<typeof getSupabaseServiceClient>;

/** Google Drive read-only OAuth scope required to call the Drive API. */
export const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';

const GDRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Minimal context accepted by the Drive helpers below. `driveGet` only reads
 * `integrations` and `signal` off its ctx, so we narrow to those two fields and
 * cast to the full `ToolContext` at the call site.
 */
export type DriveContext = Pick<ToolContext, 'integrations' | 'signal'>;

/**
 * Build a Drive read context for a session: an integrations client (service-role
 * db + the user's id) plus the user's current Google access token. The returned
 * object is structurally assignable to {@link DriveContext} and can be passed
 * straight to {@link driveListChildren} / {@link crawlSubtree}.
 */
export async function getDriveContext(
  session: SessionUser,
): Promise<{ integrations: ToolContext['integrations']; token: string }> {
  const db = getSupabaseServiceClient();
  const integrations = createIntegrationsClient(db, session.id, logger);
  const { token } = await integrations.getAccessToken('google');
  return { integrations, token };
}

/**
 * Who may point a Drive folder at a space, which is the same question as who
 * may add documents to it: its owner for a personal space, an org admin for a
 * company-wide one. Delegates to the shared boundary so Drive sync cannot
 * develop its own opinion about visibility.
 *
 * Returns a boolean so callers can map allowed/denied to 200/403; throws
 * {@link NotFoundError} when the space does not exist OR is someone else's,
 * which are deliberately indistinguishable.
 */
export async function requireCollectionWriteAccess(
  db: Db,
  session: SessionUser,
  collectionId: string,
): Promise<boolean> {
  try {
    await assertCanWriteToSpace(db, session.id, collectionId);
    return true;
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    return false;
  }
}

export interface DriveFile {
  id: string;
  name: string;
  isFolder: boolean;
  mimeType: string;
  modifiedTime: string | null;
  size: string | null;
  md5Checksum: string | null;
}

interface DriveFilesResponse {
  nextPageToken?: string;
  files?: {
    id: string;
    name: string;
    mimeType: string;
    modifiedTime?: string;
    size?: string;
    md5Checksum?: string;
  }[];
}

/**
 * List the direct children of a Drive folder (one page). Pass `q` to additionally
 * filter by name-contains, and `pageToken` to fetch a subsequent page. Folders
 * sort before files, then by name.
 */
export async function driveListChildren(
  ctx: DriveContext,
  parentId: string,
  opts: { q?: string; pageToken?: string } = {},
): Promise<{ files: DriveFile[]; nextPageToken: string | null }> {
  const clauses = [`'${parentId.replace(/'/g, "\\'")}' in parents`, 'trashed = false'];
  if (opts.q) clauses.push(`name contains '${opts.q.replace(/'/g, "\\'")}'`);

  const params: Record<string, string> = {
    q: clauses.join(' and '),
    pageSize: '1000',
    fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,md5Checksum)',
    orderBy: 'folder,name',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  };
  if (opts.pageToken) params.pageToken = opts.pageToken;

  const r = await driveGet<DriveFilesResponse>(ctx as ToolContext, '/files', params);

  return {
    files: (r.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      isFolder: f.mimeType === GDRIVE_FOLDER_MIME,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime ?? null,
      size: f.size ?? null,
      md5Checksum: f.md5Checksum ?? null,
    })),
    nextPageToken: r.nextPageToken ?? null,
  };
}

/**
 * Breadth-first walk of a folder subtree. Returns every descendant folder id
 * (including the root) and every non-folder file in the subtree. Paginates fully
 * within each folder and guards against cycles via a visited set.
 */
export async function crawlSubtree(
  ctx: DriveContext,
  rootFolderId: string,
): Promise<{ folderIds: string[]; files: DriveFile[] }> {
  const folderIds: string[] = [];
  const files: DriveFile[] = [];
  const visited = new Set<string>();
  const queue: string[] = [rootFolderId];

  while (queue.length > 0) {
    const folderId = queue.shift() as string;
    if (visited.has(folderId)) continue;
    visited.add(folderId);
    folderIds.push(folderId);

    let pageToken: string | undefined;
    do {
      const { files: page, nextPageToken } = await driveListChildren(ctx, folderId, { pageToken });
      for (const f of page) {
        if (f.isFolder) {
          if (!visited.has(f.id)) queue.push(f.id);
        } else {
          files.push(f);
        }
      }
      pageToken = nextPageToken ?? undefined;
    } while (pageToken);
  }

  return { folderIds, files };
}

/**
 * Map a Google Drive mimeType to the content type that will be stored on the
 * kb_documents row (and thus what `parseDocument` receives after the worker
 * exports the file):
 *   google-apps.document / google-apps.presentation -> 'text/plain'
 *   google-apps.spreadsheet                          -> 'text/csv'
 *   anything else                                    -> the original mime
 */
export function normalizeGdriveMime(driveMimeType: string): string {
  switch (driveMimeType) {
    case 'application/vnd.google-apps.document':
    case 'application/vnd.google-apps.presentation':
      return 'text/plain';
    case 'application/vnd.google-apps.spreadsheet':
      return 'text/csv';
    default:
      return driveMimeType;
  }
}

/**
 * Insert a kb_documents row for a Drive file (source='gdrive', source_ref=fileId)
 * and emit the kb/document.ingest event so the worker exports + finalizes it
 * (sha256 is left as a placeholder for the worker). Dedupes on
 * (collection_id, source='gdrive', source_ref): if a row already exists it is
 * returned without re-inserting or re-emitting.
 */
export async function createGdriveDocument(
  db: Db,
  args: {
    collectionId: string;
    fileId: string;
    name: string;
    driveMimeType: string;
    uploadedBy: string;
  },
) {
  const { data: existing } = await db
    .from('kb_documents')
    .select('*')
    .eq('collection_id', args.collectionId)
    .eq('source', 'gdrive')
    .eq('source_ref', args.fileId)
    .maybeSingle();
  if (existing) return existing;

  const { data: doc, error } = await db
    .from('kb_documents')
    .insert({
      collection_id: args.collectionId,
      source: 'gdrive',
      source_ref: args.fileId,
      title: args.name,
      mime: normalizeGdriveMime(args.driveMimeType),
      sha256: '',
      uploaded_by: args.uploadedBy,
      status: 'pending',
    })
    .select('*')
    .single();

  if (error || !doc) {
    throw new Error(`Failed to insert kb_documents row: ${error?.message ?? 'unknown error'}`);
  }

  await inngest.send({
    name: 'kb/document.ingest',
    data: { documentId: doc.id as string },
  });

  return doc;
}
