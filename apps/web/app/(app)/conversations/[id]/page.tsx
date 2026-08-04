import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { conversationSurface } from '@/lib/conversation-surface';
import { relativeTime } from '@/lib/relative-time';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { ArrowLeft, MessagesSquare, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SurfaceBadge } from '../_components/SurfaceBadge';
import { TranscriptMessage, type TranscriptMessageRow } from './_components/TranscriptMessage';

interface ConversationRow {
  id: string;
  title: string | null;
  user_id: string;
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
    .select(
      'id, title, user_id, agent_id, surface, external_key, created_at, updated_at, agents(name)',
    )
    .eq('id', id)
    .single();

  const conv = convData as unknown as ConversationRow | null;
  // Ownership stays exactly as strict as it was. Org admins are the one
  // exception, and only because that role already gates /admin (see
  // app/(app)/admin/layout.tsx) — they can already read this from the audit log.
  const isOwner = !!conv && conv.user_id === user.id;
  const asAdmin = !!conv && !isOwner && user.role === 'org_admin';
  if (!conv || (!isOwner && !asAdmin)) notFound();

  const { data: msgData } = await sb
    .from('messages')
    .select('id, role, content, tool_calls, tool_results, created_at')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true });

  const messages = (msgData ?? []) as unknown as TranscriptMessageRow[];
  const agentName = relName(conv.agents) ?? 'Cortex';
  const surface = conversationSurface(conv);
  const title = conv.title?.trim() || 'Conversación sin título';

  return (
    <>
      <Link
        href="/conversations"
        className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Todas las conversaciones
      </Link>

      <PageHeader
        title={title}
        subtitle={`${agentName} · ${messages.length} ${messages.length === 1 ? 'mensaje' : 'mensajes'} · empezó ${relativeTime(conv.created_at)}`}
        icon={<MessagesSquare className="h-5 w-5" />}
        actions={
          <>
            <SurfaceBadge surface={surface} size="md" />
            <Link href={`/chat/${conv.id}`}>
              <Button>Retomar en el chat</Button>
            </Link>
          </>
        }
      />

      {asAdmin && (
        <Panel className="mb-4 flex items-center gap-2 border-amber/40 bg-amber-soft px-4 py-2.5 text-[12.5px] font-semibold text-amber">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          Estás viendo la conversación de otra persona como administrador de la organización.
        </Panel>
      )}

      {messages.length === 0 ? (
        <Panel className="p-10 text-center text-[13px] text-ink-muted">
          <MessagesSquare className="mx-auto mb-3 h-7 w-7 text-primary" />
          <p className="text-[14px] font-bold text-ink">Aquí no se dijo nada</p>
          <p className="mx-auto mt-1 max-w-sm leading-relaxed">
            La conversación se creó pero no llegó ningún mensaje. Retómala en el chat para empezarla.
          </p>
        </Panel>
      ) : (
        <div className="space-y-3">
          {messages.map((m) => (
            <TranscriptMessage key={m.id} message={m} agentName={agentName} />
          ))}
        </div>
      )}
    </>
  );
}
