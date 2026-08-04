import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { BookOpen } from 'lucide-react';
import { KnowledgeBase } from './_components/KnowledgeBase';
import type { SpaceSummary } from './_components/types';
import { readBrain } from './_lib/brain';

export const dynamic = 'force-dynamic';

export default async function KnowledgeBasePage() {
  const user = await requireSession();
  const db = getSupabaseServiceClient();

  // Everything on this page — the cycle, the figures, the space cards — comes
  // out of one reading, so nothing on screen can disagree with anything else.
  const { spaces, facts, stats } = await readBrain(db, user.id, { perSpaceChunks: true });

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
    const f = facts.get(s.id);
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
      documentCount: f?.documentCount ?? 0,
      pendingCount: f?.pendingCount ?? 0,
      failedCount: f?.failedCount ?? 0,
      lastAddedAt: f?.lastAddedAt ?? null,
      // Everyone reads the company spaces; only an admin adds to them.
      canWrite: s.kind === 'global' ? isAdmin : isMine,
      chunkCount: f?.chunkCount ?? null,
      spokenSeconds: f?.spokenSeconds ?? 0,
      intake: f?.intake ?? { upload: 0, record: 0, meeting: 0, drive: 0 },
    };
  });

  return (
    <>
      <PageHeader
        title="Brain Knowledge"
        subtitle="La memoria de la empresa. Lo que entra aquí es lo que Cortex puede recordar."
        icon={<BookOpen className="h-5 w-5" />}
      />
      <KnowledgeBase
        spaces={summaries}
        stats={stats}
        isAdmin={isAdmin}
        viewerName={user.name ?? user.email}
      />
    </>
  );
}
