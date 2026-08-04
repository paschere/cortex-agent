import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import {
  conversationSurface,
  matchesSurfaceFilter,
  parseSurfaceFilter,
  storedSurfaceFor,
} from '@/lib/conversation-surface';
import { relativeTime } from '@/lib/relative-time';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { MessagesSquare } from 'lucide-react';
import Link from 'next/link';
import { ConversationFilters } from './_components/ConversationFilters';
import { DeleteConversationButton } from './_components/DeleteConversationButton';
import { SurfaceBadge } from './_components/SurfaceBadge';

interface ConversationRow {
  id: string;
  title: string | null;
  agent_id: string;
  surface: string;
  external_key: string | null;
  created_at: string;
  updated_at: string;
  agents: { name: string } | { name: string }[] | null;
}

/** Supabase returns a to-one embed as an object; older joins hand back an array. */
function relName(rel: { name: string } | { name: string }[] | null): string | undefined {
  return Array.isArray(rel) ? rel[0]?.name : rel?.name;
}

export const dynamic = 'force-dynamic';

const PAGE_LIMIT = 50;

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ surface?: string; q?: string }>;
}) {
  const user = await requireSession();
  const sp = await searchParams;
  const surface = parseSurfaceFilter(sp.surface);
  const q = (sp.q ?? '').trim();

  const sb = getSupabaseServiceClient();
  let query = sb
    .from('conversations')
    .select('id, title, agent_id, surface, external_key, created_at, updated_at, agents(name)')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(PAGE_LIMIT);

  const stored = storedSurfaceFor(surface);
  if (stored?.op === 'eq') query = query.eq('surface', stored.value);
  else if (stored?.op === 'neq') query = query.neq('surface', stored.value);
  // PostgREST `ilike` needs the wildcards inline; escape the ones a user could
  // type so a title search for "50%" is not read as a pattern.
  if (q) query = query.ilike('title', `%${q.replace(/[%_\\]/g, '\\$&')}%`);

  const { data } = await query;

  // Google Chat and routines share their stored `surface` with another origin,
  // so the last narrowing has to happen here on the derived value.
  const conversations = ((data ?? []) as unknown as ConversationRow[])
    .map((c) => ({ ...c, derived: conversationSurface(c) }))
    .filter((c) => matchesSurfaceFilter(surface, c.derived));

  // Message counts come from their own read: if this PostgREST cannot do the
  // embedded aggregate, the list still renders — it just loses the counts.
  let counts = new Map<string, number>();
  if (conversations.length > 0) {
    const { data: countRows } = await sb
      .from('conversations')
      .select('id, messages(count)')
      .in(
        'id',
        conversations.map((c) => c.id),
      );
    counts = new Map(
      ((countRows ?? []) as unknown as Array<{ id: string; messages: { count: number }[] }>).map(
        (r) => [r.id, r.messages?.[0]?.count ?? 0],
      ),
    );
  }

  const subtitle = q
    ? `${conversations.length} ${conversations.length === 1 ? 'coincidencia' : 'coincidencias'} para “${q}”`
    : `${conversations.length} ${conversations.length === 1 ? 'conversación' : 'conversaciones'}`;

  return (
    <>
      <PageHeader
        title="Conversaciones"
        subtitle={subtitle}
        icon={<MessagesSquare className="h-5 w-5" />}
      />

      <ConversationFilters surface={surface} q={q} />

      <Panel className="overflow-hidden">
        {conversations.length === 0 ? (
          <div className="p-10 text-center text-[13px] text-ink-muted">
            {q ? (
              <>
                <p className="mb-1 text-[14px] font-bold text-ink">
                  Ninguna conversación se llama así
                </p>
                <p className="mx-auto max-w-sm leading-relaxed">
                  La búsqueda solo mira el título de la conversación. Prueba con otra palabra.
                </p>
                <Link
                  href="/conversations"
                  className="mt-4 inline-flex rounded-card border border-border-strong px-4 py-2 text-[12.5px] font-semibold text-ink transition-colors hover:bg-surface-2"
                >
                  Limpiar la búsqueda
                </Link>
              </>
            ) : (
              <>
                <p className="mb-1 text-[14px] font-bold text-ink">Todavía no hay conversaciones</p>
                <p className="mx-auto max-w-sm leading-relaxed">
                  Aquí queda todo lo que le has preguntado a Cortex, con las herramientas que usó
                  para responderte.
                </p>
                <Link
                  href="/chat"
                  className="mt-4 inline-flex rounded-card bg-primary px-4 py-2 text-[12.5px] font-semibold text-white transition-colors hover:bg-primary-strong"
                >
                  Abrir el chat
                </Link>
              </>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {conversations.map((c) => {
              const count = counts.get(c.id);
              return (
                <li
                  key={c.id}
                  className="group flex items-center gap-2 pr-2 transition-colors hover:bg-surface-2"
                >
                  <Link
                    href={`/conversations/${c.id}`}
                    className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5"
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-card border border-border bg-surface-2 text-ink-muted">
                      <MessagesSquare className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold text-ink">
                        {c.title?.trim() || 'Conversación sin título'}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-faint">
                        <SurfaceBadge surface={c.derived} />
                        <span className="truncate">{relName(c.agents) ?? 'Cortex'}</span>
                        {count !== undefined && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="tabular">
                              {count} {count === 1 ? 'mensaje' : 'mensajes'}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <span className="tabular shrink-0 text-[11.5px] text-ink-faint">
                      {relativeTime(c.updated_at)}
                    </span>
                  </Link>
                  <div className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
                    <DeleteConversationButton id={c.id} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
