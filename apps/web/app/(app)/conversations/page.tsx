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
    ? `${conversations.length} match${conversations.length === 1 ? '' : 'es'} for “${q}”`
    : `${conversations.length} conversation${conversations.length === 1 ? '' : 's'}`;

  return (
    <>
      <PageHeader
        title="Conversations"
        subtitle={subtitle}
        icon={<MessagesSquare className="h-5 w-5" />}
      />

      <ConversationFilters surface={surface} q={q} />

      <Panel className="overflow-hidden">
        {conversations.length === 0 ? (
          <div className="p-10 text-center text-[13px] text-ink-faint">
            {q ? (
              <>
                Nothing matches “{q}”.{' '}
                <Link
                  href="/conversations"
                  className="font-semibold text-primary hover:text-primary-strong"
                >
                  Clear the search
                </Link>
                .
              </>
            ) : (
              <>
                No conversations yet.{' '}
                <Link href="/chat" className="font-semibold text-primary hover:text-primary-strong">
                  Start chatting
                </Link>
                .
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
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-primary">
                      <MessagesSquare className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold text-ink">
                        {c.title?.trim() || 'Untitled conversation'}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-faint">
                        <SurfaceBadge surface={c.derived} />
                        <span className="truncate">{relName(c.agents) ?? 'Zippy'}</span>
                        {count !== undefined && (
                          <>
                            <span aria-hidden>·</span>
                            <span>
                              {count} message{count === 1 ? '' : 's'}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-ink-faint">
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
