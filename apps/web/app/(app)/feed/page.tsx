import type { FeedEntry } from '@/lib/feed/shared';
import { ownedFeed } from '@/lib/feed/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { Feed } from './Feed';

export const metadata = { title: 'Feed · Cortex' };

export default async function FeedPage() {
  const user = await requireSession();
  const { data, error } = await ownedFeed(getOrgScopedClient(user.organization.id), user.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error('No se pudo cargar Feed. Revisa que la migración 0128 esté aplicada.');
  return (
    <Feed
      key={user.organization.id}
      workspaceId={user.organization.id}
      initialEntries={(data ?? []) as FeedEntry[]}
    />
  );
}
