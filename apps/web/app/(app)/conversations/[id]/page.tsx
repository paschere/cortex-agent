import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { conversationSurface } from '@/lib/conversation-surface';
import { relativeTime } from '@/lib/relative-time';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NO_OVERRIDES, listVisibleSpaces, loadOverrides, promptDigest } from '@cortex/agent-tools';
import { ArrowLeft, MessagesSquare, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SurfaceBadge } from '../_components/SurfaceBadge';
import { TranscriptMessage, type TranscriptMessageRow } from './_components/TranscriptMessage';
import { ContextAdjust } from './_components/context/ContextAdjust';
import type { SpaceOption } from './_components/context/types';
import { loadTurnViews } from './_lib/turn-context-view';

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
  const sb = getOrgScopedClient(user.organization.id);
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

  // What each turn was really handed. Everything below is best-effort by
  // construction — `loadTurnViews` swallows its own failures — because a
  // transcript that renders without its diagnostics is a far better page than a
  // transcript that does not render.
  //
  // The agent's prompt is fingerprinted as it stands NOW, so an old turn can
  // say whether the instructions it ran under are still the ones on file.
  const { data: agentRow } = await sb
    .from('agents')
    .select('system_prompt')
    .eq('id', conv.agent_id)
    .maybeSingle();
  const livePromptDigest = agentRow?.system_prompt
    ? promptDigest(agentRow.system_prompt as string)
    : null;

  const [{ byMessage: turnsByMessage }, overrides, visibleSpaces] = await Promise.all([
    loadTurnViews(sb, { conversationId: id, viewerId: user.id, livePromptDigest }),
    // Only the owner may change anything, so only the owner needs the current
    // settings read at all.
    isOwner ? loadOverrides(sb, id) : Promise.resolve(NO_OVERRIDES),
    isOwner ? listVisibleSpaces(sb, user.id).catch(() => []) : Promise.resolve([]),
  ]);

  const spaceOptions: SpaceOption[] = visibleSpaces.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
  }));

  // The families this conversation has actually seen, rather than an abstract
  // catalogue: a control offering to mute something that has never come up here
  // is a control nobody can reason about.
  const familiesSeen = [
    ...new Set(
      [...turnsByMessage.values()].flatMap((t) => t.tools.families.map((f) => f.family)),
    ),
  ].sort();

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
            <TranscriptMessage
              key={m.id}
              message={m}
              agentName={agentName}
              turn={turnsByMessage.get(m.id)}
            />
          ))}
        </div>
      )}

      {/* The controls sit AFTER the transcript, not before it. They change the
          next turn, so they belong at the end of the evidence rather than at
          the top of it — you should have read what happened before you reach
          for a knob. Absent entirely for an org admin reading somebody else's
          conversation: seeing why it answered is oversight, changing how
          another person's assistant behaves is not. */}
      {messages.length > 0 && isOwner && (
        <div className="mt-4">
          <ContextAdjust
            conversationId={conv.id}
            initial={{
              fragmentLimit: overrides.fragmentLimit,
              spaceIds: overrides.spaceIds,
              mutedFamilies: overrides.mutedFamilies,
            }}
            spaces={spaceOptions}
            families={familiesSeen}
            canEdit
          />
        </div>
      )}
    </>
  );
}
