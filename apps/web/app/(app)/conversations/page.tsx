import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import Link from 'next/link';
import { MessagesSquare } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
import { DeleteConversationButton } from './_components/DeleteConversationButton';

interface ConversationRow {
  id: string;
  title: string | null;
  agent_id: string;
  surface: string;
  created_at: string;
  updated_at: string;
  agents: { name: string }[] | null;
}

export const dynamic = 'force-dynamic';

export default async function ConversationsPage() {
  const user = await requireSession();
  const sb = getSupabaseServiceClient();
  const { data } = await sb
    .from('conversations')
    .select('id, title, agent_id, surface, created_at, updated_at, agents(name)')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(50);

  const conversations = (data ?? []) as unknown as ConversationRow[];

  return (
    <>
      <PageHeader
        title="Conversations"
        subtitle={`${conversations.length} conversation${conversations.length === 1 ? '' : 's'}`}
        icon={<MessagesSquare className="h-5 w-5" />}
      />

      <Panel className="overflow-hidden">
        {conversations.length === 0 ? (
          <div className="p-10 text-center text-[13px] text-ink-faint">
            No conversations yet.{' '}
            <Link href="/chat" className="font-semibold text-primary hover:text-primary-strong">
              Start chatting
            </Link>
            .
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {conversations.map((c) => (
              <li key={c.id} className="group flex items-center gap-2 pr-2 transition-colors hover:bg-surface-2">
                <Link href={`/conversations/${c.id}`} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-primary">
                    <MessagesSquare className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold text-ink">{c.title?.trim() || 'Untitled conversation'}</div>
                    <div className="truncate text-xs text-ink-faint">
                      {c.agents?.[0]?.name ?? 'Agent'} · {c.surface}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-ink-faint">{relativeTime(c.updated_at)}</span>
                </Link>
                <div className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
                  <DeleteConversationButton id={c.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
