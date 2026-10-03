import type { FeedEntry } from '@/lib/feed/shared';
import { ownedFeed } from '@/lib/feed/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { Feed } from './Feed';

export const metadata = { title: 'Bandeja de archivos · Cortex' };

export default async function FeedPage({
  searchParams,
}: { searchParams: Promise<{ mode?: string; vista?: string }> }) {
  const user = await requireSession();
  const { mode, vista } = await searchParams;
  const initialMode = mode === 'url' || mode === 'text' || mode === 'api' ? mode : 'file';
  const initialView = vista === 'fuentes' ? 'sources' : vista === 'cruzar' ? 'cross' : 'entries';
  const db = getOrgScopedClient(user.organization.id);
  const [feed, syncs] = await Promise.all([
    ownedFeed(db, user.id).order('created_at', { ascending: false }).limit(100),
    // Qué fuentes llenan una tabla: sus entradas dicen «En tabla».
    db
      .from('tracker_syncs')
      .select('source_id')
      .limit(500),
  ]);
  if (feed.error)
    throw new Error('No se pudo cargar la bandeja de archivos. Vuelve a intentarlo en un momento.');
  // Es una etiqueta, no el contenido: si no se pudo leer, las entradas salen sin «En tabla».
  const tableSourceIds = syncs.error
    ? []
    : [...new Set(((syncs.data ?? []) as Array<{ source_id: string }>).map((r) => r.source_id))];
  return (
    <Feed
      key={`${user.organization.id}:${initialMode}`}
      workspaceId={user.organization.id}
      initialMode={initialMode}
      initialView={initialView}
      tableSourceIds={tableSourceIds}
      initialEntries={(feed.data ?? []) as FeedEntry[]}
    />
  );
}
