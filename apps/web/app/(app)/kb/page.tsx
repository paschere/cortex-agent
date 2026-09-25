import { PageHeader } from '@/components/ui/page-header';
import { WhatsappInBrain } from '@/components/whatsapp/WhatsappInBrain';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { COMPANY_MEMORY_KIND_LABEL, listMemoryProposals } from '@cortex/agent-tools';
import { BookOpen } from 'lucide-react';
import { KnowledgeBase } from './_components/KnowledgeBase';
import { PendingMemories, type PendingMemory } from './_components/PendingMemories';
import { ago } from './_components/format';
import type { SpaceSummary } from './_components/types';
import { readBrain } from './_lib/brain';
import { readConstellation } from './_lib/constellation';
import { readFragmentHealth, readShape, readStale } from './_lib/inspect';
import { livingSubtitle } from './_lib/view';

export const dynamic = 'force-dynamic';

export default async function KnowledgeBasePage({
  searchParams,
}: {
  searchParams: Promise<{ document?: string | string[] }>;
}) {
  const user = await requireSession();
  const params = await searchParams;
  const initialDocumentId =
    typeof params.document === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.document)
      ? params.document
      : null;
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

  // Lo que Cortex propuso guardar desde el chat (0157). Sólo se muestran los
  // que esta persona podría decidir: los de espacios donde aporta, o todos si
  // administra la empresa. Si la tabla aún no existe, la página sigue igual.
  const writable = new Set(
    spaces.filter((s) => s.level === 'contribute' || s.level === 'admin').map((s) => s.id),
  );
  const proposals = await listMemoryProposals(db, { status: 'pending', limit: 30 }).catch(() => []);
  const decidable = proposals.filter((p) =>
    p.target_space_id ? writable.has(p.target_space_id) : isAdmin,
  );
  const proposerIds = [...new Set(decidable.map((p) => p.proposed_by))];
  const proposers = new Map<string, string>();
  if (proposerIds.length) {
    const { data: rows, error: proposerError } = await db
      .from('users')
      .select('id, name, email')
      .in('id', proposerIds);
    if (!proposerError)
      for (const r of (rows ?? []) as Array<{ id: string; name: string | null; email: string }>)
        proposers.set(r.id, r.name?.trim() || r.email);
  }
  const pendingMemories: PendingMemory[] = decidable.map((p) => ({
    id: p.id,
    kindLabel: COMPANY_MEMORY_KIND_LABEL[p.kind] ?? 'Dato',
    subject: p.subject,
    statement: p.statement,
    quote: p.quote,
    proposer: proposers.get(p.proposed_by) ?? 'alguien del equipo',
    when: ago(p.created_at),
    space: spaces.find((s) => s.id === p.target_space_id)?.name ?? null,
  }));

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
      // Lo que puede hacer aquí sale del nivel efectivo que resolvió la base de
      // datos (0123), no de una regla escrita otra vez en el navegador: si esta
      // página dedujera «común ⇒ sólo el admin escribe» seguiría pintando un
      // botón que el servidor rechaza en cuanto alguien concede 'contribute' a
      // un equipo.
      canWrite: s.level === 'contribute' || s.level === 'admin',
      canShare: s.level === 'admin',
      everyone: s.kind === 'global',
      sharedWith: s.grantCount,
      chunkCount: f?.chunkCount ?? null,
      spokenSeconds: f?.spokenSeconds ?? 0,
      intake: f?.intake ?? { upload: 0, record: 0, meeting: 0, drive: 0 },
    };
  });

  return (
    <>
      <PageHeader
        title="Brain Knowledge"
        subtitle={livingSubtitle({
          chunks: stats.chunks,
          spaces: summaries.length,
          lastAdded: stats.lastAddedAt ? ago(stats.lastAddedAt) : null,
        })}
        icon={<BookOpen className="h-5 w-5" />}
      />
      {/* A view, not a control panel: WhatsApp is configured in Integrations,
          and this only says which conversations are arriving from there. */}
      <WhatsappInBrain organizationId={user.organization.id} />
      <PendingMemories items={pendingMemories} />
      <KnowledgeBase
        key={`${user.organization.id}:${initialDocumentId ?? 'index'}`}
        initialDocumentId={initialDocumentId}
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
