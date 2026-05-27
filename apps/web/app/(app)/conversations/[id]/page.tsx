import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

interface ConversationRow {
  id: string;
  title: string | null;
  user_id: string;
  agent_id: string;
  surface: string;
  created_at: string;
  agents: { name: string }[] | null;
}

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSession();
  const sb = getSupabaseServiceClient();
  const { id } = await params;

  const { data: convData } = await sb
    .from('conversations')
    .select('id, title, user_id, agent_id, surface, created_at, agents(name)')
    .eq('id', id)
    .single();

  const conv = convData as unknown as ConversationRow | null;
  if (!conv || conv.user_id !== user.id) notFound();

  const { data: msgData } = await sb
    .from('messages')
    .select('id, role, content, created_at')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true });

  const messages = (msgData ?? []) as unknown as MessageRow[];

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-semibold">
            {conv.title ?? 'Untitled conversation'}
          </h1>
          <div className="text-sm text-neutral-500 mt-1">
            {conv.agents?.[0]?.name ?? 'Agent'} &middot; {conv.surface} &middot;{' '}
            {new Date(conv.created_at).toLocaleString()}
          </div>
        </div>
        <Link href={`/chat/${id}`}>
          <Button>Resume in chat</Button>
        </Link>
      </div>
      <div className="rounded-2xl border bg-white dark:bg-neutral-900 divide-y">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`p-4 text-sm ${m.role === 'user' ? 'bg-neutral-50 dark:bg-neutral-800/50' : ''}`}
          >
            <div className="text-xs text-neutral-500 uppercase mb-1">
              {m.role} &middot; {new Date(m.created_at).toLocaleString()}
            </div>
            <div className="whitespace-pre-wrap">{m.content}</div>
          </div>
        ))}
        {messages.length === 0 && (
          <div className="p-6 text-sm text-neutral-500">No messages in this conversation.</div>
        )}
      </div>
    </div>
  );
}
