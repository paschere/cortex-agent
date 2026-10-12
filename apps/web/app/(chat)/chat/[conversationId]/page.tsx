import { ChatRoot } from '@/components/chat/ChatRoot';
import { toBanner } from '@/lib/background-tasks/banner';
import { TASK_COLUMNS } from '@/lib/background-tasks/repository';
import { type BrainSource, parseBrainSources } from '@/lib/brain-sources-shape';
import { toChatMessages } from '@/lib/conversation-messages';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { readWaitingNotice } from '@/lib/waiting';
import { listVisibleSpaces, loadOverrides } from '@cortex/agent-tools';
import { listAgents } from '@cortex/agents';
import type { Message } from 'ai';

export default async function ResumeChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ conversationId: string }>;
  searchParams: Promise<{ prompt?: string }>;
}) {
  const { conversationId } = await params;
  const { prompt } = await searchParams;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const agents = listAgents().map((a) => ({
    slug: a.id,
    name: a.name,
    greeting: a.greeting,
  }));

  // A workspace member may know a colleague's conversation id through founder
  // supervision or an audit trail. Resolve ownership before reading a single
  // message; tenant scope alone still includes every colleague in the company.
  const { data: conv } = await db
    .from('conversations')
    .select('id, title, agents(slug)')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!conv) return <ChatRoot agents={agents} />;

  // Load messages from DB — only user/assistant roles for useChat
  const { data: msgs, error: msgsError } = await db
    .from('messages')
    // `followups` rides along with the transcript rather than in a query of its
    // own. That is the whole reason they live on the message row (migration
    // 0090): reopening a conversation now costs the same one read it always
    // did, and no model call at all.
    // `screen_glance_at` rides along for the same reason `followups` does
    // (migration 0092): it is a property of the message and is only ever wanted
    // with it, so annotating a reopened thread costs no additional query.
    // `brain_sources` viaja igual (migración 0105): es una propiedad del mensaje
    // y sólo se quiere junto a él, así que reabrir un hilo con su procedencia
    // sigue costando la misma lectura de siempre.
    // `parts` viaja aquí también (migración 0110): la cronología completa del
    // mensaje —texto, razonamiento y llamadas entrelazados— por la misma
    // lectura de siempre.
    .select(
      'id, role, content, tool_calls, tool_results, parts, followups, screen_glance_at, brain_sources, created_at',
    )
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  // A transcript that CANNOT be read must never render as a transcript that is
  // EMPTY. They look identical on screen and mean opposite things, and the
  // difference is what somebody needs in order to report the problem.
  //
  // This is not hypothetical: the select above names `followups` and
  // `screen_glance_at`, added by migrations 0090 and 0092. A deploy that ships
  // the code before the migration lands — exactly what happened — makes
  // PostgREST reject the whole query for one unknown column, and every
  // conversation in the product silently reads as brand new. Nothing in the
  // build, the tests or the types can catch it, because the column is real in
  // the repo and missing only in the database that is running.
  //
  // Throwing hands it to the error boundary, which says something is wrong
  // instead of quietly implying the messages were never there.
  if (msgsError) {
    throw new Error(
      `No se pudo leer la conversación ${conversationId}: ${msgsError.message}. Suele ser una migración sin aplicar en esta base de datos.`,
    );
  }

  // Map DB rows to AI SDK Message shape; skip 'tool' role (internal). La regla
  // (parts recortadas, hora con el mensaje…) vive en lib/conversation-messages.ts:
  // la comparte la ruta que el chat consulta mientras una tarea en segundo plano escribe.
  const initialMessages: Message[] = toChatMessages(msgs ?? []);

  const convAgents = conv.agents as { slug: string } | { slug: string }[] | null;
  const convAgentSlug = Array.isArray(convAgents) ? convAgents[0]?.slug : convAgents?.slug;

  /**
   * The follow-ups already written for the LAST answer, and only for it.
   *
   * A transcript with a strip of chips after every message is a transcript of
   * chips, so the composer only ever shows the newest one's — and passing the
   * rest down would be handing the client twenty lists it is going to throw
   * away. `undefined` for that message (never generated) is left out of the map
   * entirely, which is exactly the signal `FollowUps` reads as "ask the server
   * once". A stored `[]` IS included: it means somebody already asked and there
   * was nothing, and that is the answer that must never be paid for twice.
   */
  const lastAnswer = [...(msgs ?? [])].reverse().find((m) => m.role === 'assistant');
  const storedFollowups =
    lastAnswer && Array.isArray(lastAnswer.followups)
      ? { [lastAnswer.id as string]: lastAnswer.followups as string[] }
      : undefined;

  /**
   * Which questions were asked while Cortex was looking at a shared tab.
   *
   * Two weeks later this line is the difference between a legible thread and a
   * confusing one: «¿qué significa este error?» followed by a precise answer
   * about a DIAN screen reads as invention unless the transcript says what was
   * being looked at. The image was never stored — this timestamp is the entire
   * footprint of a screen question, and it is on screen rather than only in the
   * database on purpose. See migration 0092.
   */
  const initialGlances: Record<string, string> = {};
  for (const m of msgs ?? []) {
    if (m.screen_glance_at) initialGlances[m.id as string] = m.screen_glance_at as string;
  }

  /**
   * Qué documentos del cerebro se leyeron para cada respuesta de este hilo.
   *
   * A DIFERENCIA de los seguimientos, esto se pasa para TODAS las respuestas y
   * no sólo para la última. Un seguimiento es una sugerencia sobre qué preguntar
   * ahora, y sólo tiene sentido al final del hilo; la procedencia es la prueba
   * de dónde salió una cifra, y la cifra que alguien va a discutir dos semanas
   * después está en mitad de la conversación, no al final.
   *
   * No cuesta ninguna consulta: la columna viene en el mismo `select` de arriba.
   * Las respuestas sin fuentes se quedan fuera del mapa entero, que es lo que
   * `BrainSources` lee como «no dibujes nada».
   */
  const initialBrainSources: Record<string, BrainSource[]> = {};
  for (const m of msgs ?? []) {
    const sources = parseBrainSources(m.brain_sources);
    if (sources.length > 0) initialBrainSources[m.id as string] = sources;
  }

  /**
   * The memory filter this conversation was left on, resolved back into names.
   *
   * NAMES, NOT IDS, AND RESOLVED THROUGH `listVisibleSpaces`. The strip in the
   * composer has to say "Aduanas" — an id would be worse than nothing, because
   * the point of the strip is that somebody reads it and remembers. Resolving
   * through the visibility rule also means a space that was deleted, or that
   * stopped being visible to this person, simply drops off the strip instead of
   * showing a name for something retrieval will no longer reach.
   *
   * Both queries only happen when there IS a filter, which is the rare case, so
   * a normal chat loads exactly the queries it always did plus one.
   */
  /**
   * La línea de la cabecera, también en un hilo reabierto.
   *
   * Los conteos son los del rail (`countNavSignals`). El nombre propio —si hay
   * algo parado— es una lectura más, la del primer asunto, ver
   * `readWaitingNotice`. Un hilo de hace tres semanas se abre casi igual de
   * rápido que antes y encima dice qué está parado hoy.
   */
  const waiting = await readWaitingNotice(user.organization.id, user.id);

  // La tarea en segundo plano de esta conversación, si sigue viva (0222): al reabrirla desde
  // otro aparato el chat la retoma y se ve avanzar a Cortex.
  const { data: liveTask } = await db
    .from('background_tasks')
    .select(TASK_COLUMNS)
    .eq('conversation_id', conversationId)
    .in('status', ['queued', 'working', 'needs_you'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const overrides = await loadOverrides(db, conversationId).catch(() => null);
  const scopedIds = overrides?.spaceIds ?? null;
  const initialScope =
    scopedIds && scopedIds.length > 0
      ? (await listVisibleSpaces(db, user.id).catch(() => []))
          .filter((s) => scopedIds.includes(s.id))
          .map((s) => ({ id: s.id, name: s.name, kind: s.kind }))
      : [];

  return (
    <ChatRoot
      initialDraft={typeof prompt === 'string' ? prompt.slice(0, 4000) : undefined}
      agents={agents}
      conversationId={conversationId}
      initialMessages={initialMessages}
      initialAgentSlug={convAgentSlug}
      {...(conv.title ? { title: conv.title as string } : {})}
      initialScope={initialScope}
      waiting={waiting}
      {...(liveTask ? { initialTask: toBanner(liveTask as Record<string, unknown>) } : {})}
      {...(storedFollowups ? { initialFollowups: storedFollowups } : {})}
      {...(Object.keys(initialGlances).length > 0 ? { initialGlances } : {})}
      {...(Object.keys(initialBrainSources).length > 0 ? { initialBrainSources } : {})}
    />
  );
}
