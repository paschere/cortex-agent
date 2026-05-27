import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import Link from 'next/link';

interface ConversationRow {
  id: string;
  title: string | null;
  agent_id: string;
  surface: string;
  created_at: string;
  updated_at: string;
  agents: { name: string }[] | null;
}

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
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Conversations</h1>
      <div className="rounded-2xl border bg-white dark:bg-neutral-900 divide-y">
        {conversations.map((c) => (
          <Link
            key={c.id}
            href={`/conversations/${c.id}`}
            className="block p-4 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            <div className="flex justify-between">
              <span className="font-medium">{c.title ?? '(untitled)'}</span>
              <span className="text-xs text-neutral-500">
                {new Date(c.updated_at).toLocaleString()}
              </span>
            </div>
            <div className="text-sm text-neutral-500 mt-1">
              {c.agents?.[0]?.name ?? 'Agent'} &middot; {c.surface}
            </div>
          </Link>
        ))}
        {conversations.length === 0 && (
          <div className="p-6 text-sm text-neutral-500">
            No conversations yet. Start chatting at /chat.
          </div>
        )}
      </div>
    </div>
  );
}
