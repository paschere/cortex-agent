import { PageHeader } from '@/components/ui/page-header';
import { WhatsappInBrain } from '@/components/whatsapp/WhatsappInBrain';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { BookOpen } from 'lucide-react';
import { KnowledgeBase } from './_components/KnowledgeBase';
import type { SpaceSummary } from './_components/types';
import { readBrain } from './_lib/brain';
import { readConstellation } from './_lib/constellation';
import { readFragmentHealth, readShape, readStale } from './_lib/inspect';

export const dynamic = 'force-dynamic';

export default async function KnowledgeBasePage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  // Everything on this page — the map, the figures, the analysis — comes out of
  // one reading, so nothing on screen can disagree with anything else.
  const { spaces, facts, stats } = await readBrain(db, user.id, { perSpaceChunks: true });

  // The analyses run together rather than one after another: none of them
  // needs another's answer, and in series they would add their latencies to a
  // page somebody is waiting on. Each returns null or an empty list on failure,
  // so one slow or missing reading costs its own panel and nothing else. La
  // constelación viaja como datos planos y serializables — la escena 3D es un
  // client component y la regla node:dns prohíbe que importe nada de
  // @cortex/agent-tools; el servidor resuelve todo y le baja props.
  const [health, shape, stale, constellation] = await Promise.all([
    readFragmentHealth(db, user.id),
    readShape(db, user.id),
    readStale(db, user.id),
    readConstellation(db, user.id, spaces),
  ]);

  // "Who owns it" is a name on a row, so resolve the ids here — the client
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
        subtitle="El archivo de la empresa. Entra, encuentra, lee."
        icon={<BookOpen className="h-5 w-5" />}
      />
      {/* A view, not a control panel: WhatsApp is configured in Integrations,
          and this only says which conversations are arriving from there. */}
      <WhatsappInBrain organizationId={user.organization.id} />
      <KnowledgeBase
        spaces={summaries}
        stats={stats}
        health={health}
        shape={shape}
        stale={stale}
        constellation={constellation}
        isAdmin={isAdmin}
        viewerName={user.name ?? user.email}
      />
    </>
  );
}
