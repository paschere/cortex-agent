import { DRIVE_READONLY } from '@/app/api/kb/drive/_lib';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { createIntegrationsClient } from '@zipdev/agent-tools';
import { logger } from '@zipdev/core';
import { type NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const session = await requireSession();
  const sb = getSupabaseServiceClient();

  const collectionId = new URL(req.url).searchParams.get('collectionId');
  if (!collectionId) {
    return NextResponse.json({ error: 'Missing collectionId query param' }, { status: 400 });
  }

  const { data: collection, error: colErr } = await sb
    .from('kb_collections')
    .select('id, gdrive_folder_id')
    .eq('id', collectionId)
    .single();
  if (colErr || !collection) {
    return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
  }

  const integrations = createIntegrationsClient(sb, session.id, logger);
  const connected = await integrations.hasScopes('google', [DRIVE_READONLY]);

  const folderId = collection.gdrive_folder_id as string | null;
  const folder = folderId ? { id: folderId, name: null } : null;

  const { data: syncState } = await sb
    .from('gdrive_sync_state')
    .select('last_synced_at')
    .eq('collection_id', collectionId)
    .maybeSingle();
  const lastSyncedAt = (syncState?.last_synced_at as string | undefined) ?? null;

  const { count } = await sb
    .from('kb_documents')
    .select('id', { count: 'exact', head: true })
    .eq('collection_id', collectionId)
    .eq('source', 'gdrive');
  const gdriveDocCount = count ?? 0;

  return NextResponse.json({ connected, folder, lastSyncedAt, gdriveDocCount });
}
