import { DRIVE_READONLY } from '@/app/api/kb/drive/_lib';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { DRIVE_FULL, createIntegrationsClient, getVisibleSpace } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const session = await requireSession();
  const sb = getOrgScopedClient(session.organization.id);

  const collectionId = new URL(req.url).searchParams.get('spaceId');
  if (!collectionId) {
    return NextResponse.json({ error: 'Missing spaceId query param' }, { status: 400 });
  }

  // Sync state is metadata about a space, so it needs the same visibility gate
  // as the space itself — otherwise an id is enough to learn that someone has a
  // private space wired to a Drive folder, and how much is in it.
  try {
    await getVisibleSpace(sb, session.id, collectionId);
  } catch {
    return NextResponse.json({ error: 'Space not found' }, { status: 404 });
  }

  const { data: collection, error: colErr } = await sb
    .from('kb_collections')
    .select('id, gdrive_folder_id')
    .eq('id', collectionId)
    .single();
  if (colErr || !collection) {
    return NextResponse.json({ error: 'Space not found' }, { status: 404 });
  }

  const integrations = createIntegrationsClient(sb, session.id, logger);
  const connected = await integrations.hasScopes('google', [DRIVE_READONLY]);
  // Permiso OPCIONAL de escritura (gdrive.upload_file); ver api/integrations/google.
  const canWrite = await integrations.hasScopes('google', [DRIVE_FULL]);

  const folderId = collection.gdrive_folder_id as string | null;
  const folder = folderId ? { id: folderId, name: null } : null;

  const { data: syncState, error: syncError } = await sb
    .from('gdrive_sync_state')
    .select('last_completed_at, last_error')
    .eq('collection_id', collectionId)
    .maybeSingle();
  if (syncError) {
    return NextResponse.json({ error: 'Could not load Drive sync status' }, { status: 500 });
  }
  const lastSyncedAt = (syncState?.last_completed_at as string | undefined) ?? null;
  const lastError = (syncState?.last_error as string | undefined) ?? null;

  const countDocuments = (status?: string) => {
    let query = sb
      .from('kb_documents')
      .select('id', { count: 'exact', head: true })
      .eq('collection_id', collectionId)
      .eq('source', 'gdrive');
    if (status) query = query.eq('status', status);
    return query;
  };
  const [all, failed, pending] = await Promise.all([
    countDocuments(),
    countDocuments('failed'),
    countDocuments('pending'),
  ]);
  if (all.error || failed.error || pending.error) {
    return NextResponse.json({ error: 'Could not load Drive sync status' }, { status: 500 });
  }

  return NextResponse.json({
    connected,
    canWrite,
    folder,
    lastSyncedAt,
    lastError,
    gdriveDocCount: all.count ?? 0,
    failedCount: failed.count ?? 0,
    pendingCount: pending.count ?? 0,
  });
}
