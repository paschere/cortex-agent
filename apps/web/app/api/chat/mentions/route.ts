import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { listVisibleSpaces } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * WHAT `@` CAN REACH, AND WHY IT IS THESE THREE.
 *
 * The reference calls this "sources". Here it is narrower on purpose: the three
 * things a person in this company points at when they are about to ask
 * something, and which Cortex can then look up by name.
 *
 *   CLIENTS    — the axis everything else hangs off. "@Coltrans" is how you say
 *                "the one I mean" when three counterparties have similar names,
 *                and it is the single most common disambiguation in this
 *                product.
 *   DOCUMENTS  — a specific file already in Brain Knowledge, when the question
 *                is about that contract and not about contracts.
 *   SPACES     — a whole slice of the brain, when the question is "what do we
 *                know in here".
 *
 * What is deliberately NOT here: tools, agents and models. Naming a tool is
 * asking the product to do its own job for it — the ranker picks tools per turn
 * from the question itself, and letting somebody pin one by hand would route
 * around the measurement that makes that work. And the model is not the
 * person's decision at all (see the composer).
 *
 * A mention expands to plain text in the question — `@Coltrans` becomes the
 * client's name, which is what a person would have typed. It is a typing aid,
 * not a hidden parameter: nothing about the request changes shape because a
 * mention was used, so a question typed by hand and the same question composed
 * with `@` produce exactly the same turn. That also means there is nothing here
 * that can silently widen what the model can see.
 *
 * Only the workspace's own rows can come back: `getOrgScopedClient` filters
 * every read, and spaces additionally go through `listVisibleSpaces`, which
 * shows a person the company spaces plus their own and nobody else's notes.
 */

const PER_KIND = 5;

export interface MentionHit {
  kind: 'client' | 'document' | 'space';
  id: string;
  /** What gets inserted into the composer. */
  label: string;
  /** One line of context under it, so two similar names can be told apart. */
  detail: string | null;
}

/** Postgres `ilike` treats these as wildcards; a person typing them means them. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get('q') ?? '').trim();
  const user = await requireSession();

  // One character matches nearly everything and the list is noise. Two is where
  // a name starts to narrow.
  if (raw.length < 2) return NextResponse.json({ hits: [] });

  const db = getOrgScopedClient(user.organization.id);
  const pattern = `%${escapeLike(raw)}%`;

  // Each lookup degrades on its own. A workspace with no `clients` rows, or a
  // failing space read, should cost that section of the menu and not the menu:
  // a composer whose autocomplete throws is worse than one that offers less.
  const clients = async (): Promise<MentionHit[]> => {
    const { data, error } = await db
      .from('clients')
      .select('id, name, city')
      .ilike('name', pattern)
      .neq('status', 'blocked')
      .order('name')
      .limit(PER_KIND);
    if (error || !data) return [];
    return data.map((c) => ({
      kind: 'client' as const,
      id: c.id as string,
      label: c.name as string,
      detail: (c.city as string | null) ?? null,
    }));
  };

  const documents = async (): Promise<MentionHit[]> => {
    const { data, error } = await db
      .from('kb_documents')
      .select('id, title')
      .ilike('title', pattern)
      // A document still being read cannot be quoted yet, so offering it would
      // promise something the next turn cannot deliver.
      .eq('status', 'ready')
      .order('created_at', { ascending: false })
      .limit(PER_KIND);
    if (error || !data) return [];
    return data.map((d) => ({
      kind: 'document' as const,
      id: d.id as string,
      label: d.title as string,
      detail: 'en Brain Knowledge',
    }));
  };

  const spaces = async (): Promise<MentionHit[]> => {
    try {
      const all = await listVisibleSpaces(db, user.id);
      const needle = raw.toLowerCase();
      return all
        .filter((s) => s.name.toLowerCase().includes(needle))
        .slice(0, PER_KIND)
        .map((s) => ({
          kind: 'space' as const,
          id: s.id,
          label: s.name,
          detail: s.kind === 'personal' ? 'tus propias notas' : 'espacio de la empresa',
        }));
    } catch {
      return [];
    }
  };

  const groups = await Promise.all([clients(), documents(), spaces()]);

  return NextResponse.json({ hits: groups.flat() });
}
