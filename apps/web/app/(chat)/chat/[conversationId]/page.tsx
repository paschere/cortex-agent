import { ChatRoot } from '@/components/chat/ChatRoot';
import { type BrainSource, parseBrainSources } from '@/lib/brain-sources-shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { toToolInvocations } from '@/lib/tool-invocations';
import { readWaitingNotice } from '@/lib/waiting';
import { listVisibleSpaces, loadOverrides } from '@cortex/agent-tools';
import { listAgents } from '@cortex/agents';
import type { Message } from 'ai';

export default async function ResumeChatPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const agents = listAgents().map((a) => ({
    slug: a.id,
    name: a.name,
    greeting: a.greeting,
  }));

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
    .select(
      'id, role, content, tool_calls, tool_results, followups, screen_glance_at, brain_sources, created_at',
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
      `No se pudo leer la conversación ${conversationId}: ${msgsError.message}. ` +
        'Suele ser una migración sin aplicar en esta base de datos.',
    );
  }

  // Verify conversation ownership (and recover its agent so a resumed chat
  // stays on the same agent instead of defaulting to the first in the list).
  const { data: conv } = await db
    .from('conversations')
    .select('id, agents(slug)')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!conv) {
    // conversation not found or not owned — render a fresh chat
    return <ChatRoot agents={agents} />;
  }

  // Map DB rows to AI SDK Message shape; skip 'tool' role (internal)
  const initialMessages: Message[] = (msgs ?? [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const toolInvocations = toToolInvocations(m.tool_calls, m.tool_results);
      /**
       * LA HORA VIAJA CON EL MENSAJE, y hasta hoy no viajaba.
       *
       * `created_at` estaba en el `select` desde siempre y se tiraba aquí. La
       * consecuencia no era sólo que la transcripción no tuviera hora: es que
       * `MessageActions` construye la procedencia de una cita con
       * `message.createdAt ?? Date.now()`, así que copiar con su fuente una
       * frase de hace tres semanas la fechaba HOY. Un producto cuya promesa es
       * que puedes citar esto dentro de dos semanas no puede inventarse la
       * fecha de la cita.
       *
       * Una línea, ninguna consulta nueva.
       */
      const createdAt = m.created_at ? new Date(m.created_at as string) : null;
      return {
        id: m.id as string,
        role: m.role as 'user' | 'assistant',
        content: (m.content as string) ?? '',
        ...(toolInvocations ? { toolInvocations } : {}),
        ...(createdAt && !Number.isNaN(createdAt.getTime()) ? { createdAt } : {}),
      };
    });

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
   * Son los mismos conteos que el layout ya hace para los badges del rail
   * (`countNavSignals`), no una lectura de las cuatro listas — ver
   * `readWaitingNotice`. Un hilo de hace tres semanas se abre igual de rápido
   * que antes y encima dice qué está parado hoy.
   */
  const waiting = await readWaitingNotice(user.organization.id, user.id);

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
      agents={agents}
      conversationId={conversationId}
      initialMessages={initialMessages}
      initialAgentSlug={convAgentSlug}
      initialScope={initialScope}
      waiting={waiting}
      {...(storedFollowups ? { initialFollowups: storedFollowups } : {})}
      {...(Object.keys(initialGlances).length > 0 ? { initialGlances } : {})}
      {...(Object.keys(initialBrainSources).length > 0 ? { initialBrainSources } : {})}
    />
  );
}
