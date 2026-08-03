import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { listVisibleSpaces } from '@cortex/agent-tools';
import { BookOpen } from 'lucide-react';
import { KnowledgeBase } from './_components/KnowledgeBase';
import type { SpaceSummary } from './_components/types';

export const dynamic = 'force-dynamic';

export default async function KnowledgeBasePage() {
  const user = await requireSession();
  const db = getSupabaseServiceClient();

  // One rule for "what can this person see", shared with retrieval. The page
  // cannot show a space Cortex would refuse to search, or vice versa.
  const spaces = await listVisibleSpaces(db, user.id);

  const counts = new Map<
    string,
    { total: number; pending: number; failed: number; lastAddedAt: string | null }
  >();
  if (spaces.length > 0) {
    const { data: docs } = await db
      .from('kb_documents')
      .select('collection_id, status, created_at')
      .in(
        'collection_id',
        spaces.map((s) => s.id),
      );
    for (const d of docs ?? []) {
      const id = d.collection_id as string;
      const entry = counts.get(id) ?? { total: 0, pending: 0, failed: 0, lastAddedAt: null };
      entry.total += 1;
      const status = d.status as string;
      if (status === 'failed') entry.failed += 1;
      else if (status !== 'ready') entry.pending += 1;
      const created = d.created_at as string;
      if (!entry.lastAddedAt || created > entry.lastAddedAt) entry.lastAddedAt = created;
      counts.set(id, entry);
    }
  }

  // "Who owns it" is a name on a card, so resolve the ids here — the client
  // never sees a user id it would have to look up.
  const ownerIds = [
    ...new Set(spaces.flatMap((s) => [s.ownerId, s.createdBy].filter(Boolean) as string[])),
  ];
  const names = new Map<string, string>();
  if (ownerIds.length > 0) {
    const { data: people } = await db.from('users').select('id, name, email').in('id', ownerIds);
    for (const p of people ?? []) {
      names.set(p.id as string, (p.name as string | null) ?? (p.email as string));
    }
  }

  const isAdmin = user.role === 'org_admin';

  const summaries: SpaceSummary[] = spaces.map((s) => {
    const c = counts.get(s.id);
    const isMine = s.kind === 'personal' && s.ownerId === user.id;
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      description: s.description,
      ownerName:
        s.kind === 'personal'
          ? (names.get(s.ownerId ?? '') ?? null)
          : (names.get(s.createdBy ?? '') ?? null),
      isMine,
      documentCount: c?.total ?? 0,
      pendingCount: c?.pending ?? 0,
      failedCount: c?.failed ?? 0,
      lastAddedAt: c?.lastAddedAt ?? null,
      // Everyone reads the company spaces; only an admin adds to them.
      canWrite: s.kind === 'global' ? isAdmin : isMine,
    };
  });

  return (
    <>
      <PageHeader
        title="Knowledge Base"
        subtitle="What Cortex knows. Company spaces answer everyone's questions; your own spaces answer only yours."
        icon={<BookOpen className="h-5 w-5" />}
      />
      <KnowledgeBase spaces={summaries} isAdmin={isAdmin} viewerName={user.name ?? user.email} />
    </>
  );
}
