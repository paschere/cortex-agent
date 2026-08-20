import { isControlHandoffMessage } from '@/lib/confirmation-notes';
import { buildToolContext } from '@/lib/agent';
import {
  ASK_CHOICE_DESCRIPTION,
  ASK_CHOICE_TOOL_ID,
  ASK_CHOICE_TOOL_NAME,
  AskChoiceSchema,
  askChoiceResult,
} from '@/lib/ask-choice';
import { type BrainSource, collectBrainSources } from '@/lib/brain-sources-shape';
import { loadTurnAttachments, renderTurnAttachmentBlock } from '@/lib/chat-attachments';
import { CITATION_RULE } from '@/lib/citations';
import { EVENT_ERRAND_ADVANCE } from '@/lib/errands/contract';
import { enqueueJobs } from '@/lib/jobs';
// Solo para la persistencia de `onFinish`: la cronología del mensaje, recortada
// a sus topes (100 KB por resultado, ~1 MB por mensaje — ver lib/message-parts.ts).
import { buildStoredParts, capStoredParts } from '@/lib/message-parts';
import {
  POINT_AT_DESCRIPTION,
  POINT_AT_TOOL_ID,
  POINT_AT_TOOL_NAME,
  PointAtSchema,
  ScreenGlanceSchema,
  attachScreenFrame,
  glanceTokens,
  pointAtResult,
  screenBlock,
} from '@/lib/screen-glance';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { LIVE_BROWSING_BLOCK, buildSystemPrompt } from '@/lib/system-prompt';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { buildTurnMessages } from '@/lib/turn-messages';
import { NO_THINKING, chatModel, utilityModel } from '@cortex/agent-tools';
import {
  type AnyTool,
  CUSTOM_TOOL_FAMILY,
  type EnabledExternalServer,
  type ExternalServerRow,
  type RetrievalObservation,
  TurnClock,
  TurnContextRecorder,
  callExternalTool,
  checkMeter,
  combineStickySelection,
  customToolDef,
  familiesFrom,
  fetchEnabledCustomTools,
  fetchEnabledExternalTools,
  filterTools,
  fragmentKey,
  hasOverrides,
  isRefused,
  kbSearch,
  listVisibleSpaces,
  loadOverrides,
  loadStickyToolIds,
  readWorkspacePlan,
  runTool,
  saveStickyToolIds,
  selectToolsForTurn,
  toolErrorDetail,
  toolErrorMessage,
  toolIdAllowed,
} from '@cortex/agent-tools';
import { loadAgent } from '@cortex/agents';
import { ConfirmationRequiredError, logger } from '@cortex/core';
import { type CoreMessage, type CoreTool, generateText, jsonSchema, streamText, tool } from 'ai';
import { type NextRequest, NextResponse, after } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * How many Brain Knowledge fragments get pasted above the question when nobody
 * has said otherwise. Unchanged from the number this route has always used; it
 * is a named constant now only because a conversation may override it.
 */
const DEFAULT_FRAGMENTS = 3;

const ACKNOWLEDGMENT_RE =
  /^(ok|yes|no|sure|thanks|got it|sounds good|proceed|continue|sí|claro|dale|perfecto|de acuerdo)[.!?]?$/i;

function shouldRunRag(message: string): boolean {
  const wordCount = message.trim().split(/\s+/).length;
  if (wordCount < 8) return false;
  if (ACKNOWLEDGMENT_RE.test(message.trim())) return false;
  // Los avisos que nuestras propias tarjetas escriben por la persona
  // («aprobé», «ya terminé en la página») son control, no preguntas — largos
  // solo porque cargan un id de pestaña. Ver isControlHandoffMessage.
  if (isControlHandoffMessage(message)) return false;
  return true;
}

/**
 * A tool the model may be offered this turn, in the one shape
 * `selectToolsForTurn` needs to rank it. `ref` carries whatever the executor
 * needs afterwards, so the selection result can be turned straight back into
 * AI SDK tools without a second lookup.
 *
 * Built-in and external MCP tools are ranked TOGETHER and in one list. That is
 * the fix: they used to be two paths, and the external one had no scoping at
 * all because there was no regex anyone could write for a server a user
 * connected five minutes ago.
 */
type Candidate =
  | { id: string; family: string; description: string; kind: 'registry'; ref: AnyTool }
  | {
      id: string;
      family: string;
      description: string;
      kind: 'external';
      ref: {
        server: EnabledExternalServer['server'];
        entry: EnabledExternalServer['tools'][number];
      };
    };

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
});

const Body = z.object({
  agentSlug: z.string().default('cortex'),
  conversationId: z.string().uuid().optional(),
  messages: z.array(MessageSchema).min(1),
  /**
   * "Contéstame sólo con lo de aduanas."
   *
   * A NARROWING AND ONLY A NARROWING. It reaches Brain Knowledge through
   * `ToolContext.kbSpaceIds`, which `kb_search_scoped` INTERSECTS with the
   * spaces this person can already see — so a forged id here buys nothing, and
   * an id for somebody else's personal space contributes exactly zero rows. The
   * ids are re-checked against `listVisibleSpaces` below anyway, so that a
   * stale one fails visibly instead of quietly narrowing retrieval to nothing.
   *
   * Absent means unchanged: a request without this field produces the same turn
   * it produced before the field existed. See components/chat/MemoryScope.tsx.
   */
  spaceIds: z.array(z.string().uuid()).max(32).optional(),
  /**
   * ONE FRAME of the tab this person is sharing, taken at the instant they
   * pressed send. See components/chat/ScreenView.tsx and migration 0092.
   *
   * It rides on the request and dies with it: nothing below writes it anywhere,
   * and the only trace a screen question leaves is a timestamp and a token
   * count on the user's message row.
   *
   * Absent means unchanged — a request without this field produces byte for
   * byte the turn it produced before the field existed.
   */
  screen: ScreenGlanceSchema.optional(),
});

export async function POST(req: NextRequest) {
  // The clock starts before anything else happens, including the session
  // lookup, because the person's wait started before that too. Constructing it
  // is one `performance.now()`; it holds no handle to anything and writes
  // nothing until the answer has already been delivered. See
  // packages/agent-tools/src/latency.
  const started = performance.now();

  const user = await requireSession();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { agentSlug, messages } = parsed.data;

  const db = getOrgScopedClient(user.organization.id);

  // THE GATE, AND WHERE IT IS.
  //
  // Here — before the conversation row, before the user's message is persisted,
  // and a long way before the model is called. That position IS the policy: a
  // turn that has started always finishes, because there is no point after this
  // one at which the plan is consulted again. Nothing can truncate an answer
  // somebody is already reading.
  //
  // It only ever refuses the START of a new turn, and only once the plan's limit
  // AND its courtesy margin are both spent. Crossing the limit mid-conversation
  // puts a banner on the screen and keeps answering; see the long note in
  // packages/agent-tools/src/billing/plans.ts.
  //
  // Nothing is persisted on the refusal path, so a refused turn costs the person
  // nothing and is not metered — the meter counts answers, and there was none.
  const answers = await checkMeter(db, 'answers');
  if (isRefused(answers)) {
    const { plan } = await readWorkspacePlan(db);
    return NextResponse.json(
      {
        error:
          `Se acabaron las respuestas de tu plan ${plan.name} en este mes: ` +
          `${answers.used} de ${answers.limit}` +
          (answers.perSeat !== null
            ? ` (${answers.perSeat} por persona × ${answers.seats} personas)`
            : '') +
          ', con el margen de cortesía ya incluido. ' +
          'Todo lo que ya está adentro se sigue guardando y se sigue consultando. ' +
          'Para que Cortex vuelva a responder, amplía el plan o suma a quien falte, ' +
          'en Plan y consumo.',
        reason: 'plan_limit',
        meter: 'answers',
      },
      { status: 402 },
    );
  }

  // Load agent from DB (gets UUID + system prompt stored in DB)
  let agent: Awaited<ReturnType<typeof loadAgent>>;
  try {
    agent = await loadAgent(db, agentSlug);
  } catch {
    return NextResponse.json({ error: `Agent '${agentSlug}' not found` }, { status: 404 });
  }

  // Resolve or create conversation
  let conversationId = parsed.data.conversationId;
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');

  if (!conversationId) {
    const title = (lastUserMessage?.content ?? 'New conversation').slice(0, 60);
    const { data: conv, error: convErr } = await db
      .from('conversations')
      .insert({
        user_id: user.id,
        agent_id: agent.id,
        surface: 'web',
        title,
      })
      .select('id')
      .single();
    if (convErr || !conv) {
      return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 });
    }
    conversationId = conv.id as string;
  }

  // Persist the user's last message
  const glance = parsed.data.screen;
  if (lastUserMessage) {
    await db.from('messages').insert({
      conversation_id: conversationId,
      role: 'user',
      content: lastUserMessage.content,
      // The whole footprint of a screen question: when it was looked at and
      // what the looking cost. Never the picture — see migration 0092. Written
      // on the same insert the message was already making, so a glance adds no
      // round-trip to the turn.
      ...(glance
        ? {
            screen_glance_at: glance.takenAt,
            screen_glance_tokens: glanceTokens(glance.width, glance.height),
          }
        : {}),
    });
  }

  // What this turn handed the model, written down as it is assembled and saved
  // once the answer has already been delivered. Accumulating is pure assignment
  // — no I/O, nothing awaited — so nothing here is on the path of the reply.
  // See packages/agent-tools/src/turn-context.
  const recorder = new TurnContextRecorder({
    organizationId: user.organization.id,
    conversationId,
    userId: user.id,
    agentId: agent.id,
    model: agent.defaultModel,
    logger,
  });
  // How long this turn takes, and where the time goes. Same contract as the
  // recorder above and for the same reason: it accumulates in memory and writes
  // one row from `onFinish`, so measuring how slow the product is can never be
  // the thing that makes it slow. `started` was taken on the first line of the
  // handler — everything up to here is the person's wait too.
  const clock = new TurnClock({
    organizationId: user.organization.id,
    conversationId,
    userId: user.id,
    agentId: agent.id,
    model: agent.defaultModel,
    surface: 'web',
    startedAt: started,
    logger,
  });
  // Session, plan check, agent row, conversation row, the user's message. All
  // of it before a single decision about the answer has been made.
  clock.setup();
  // The retrieval as it really came back, near-misses included. It can only be
  // taken from inside the search that ran: kb.search drops everything below the
  // floor before returning, and running a second search later would answer a
  // different question with today's thresholds. See ToolContext.onRetrieval.
  let retrievalSeen: RetrievalObservation | null = null;

  const ctx = buildToolContext({
    organizationId: user.organization.id,
    userId: user.id,
    agentId: agent.id,
    conversationId,
    onRetrieval: (observation) => {
      retrievalSeen = observation;
    },
  });

  // RAG prepend: kb.search top 3 on the last user message (conditional).
  // Skipped entirely while the KB has no indexed chunks — saves an embedding
  // round-trip per message on fresh workspaces.
  const ragQuery = lastUserMessage?.content ?? '';
  let ragBlock = '';
  /**
   * Los documentos que se pegaron encima de esta pregunta, para escribirlos con
   * la respuesta y poder decir en pantalla de dónde salió.
   *
   * Se llena en el mismo sitio donde se arma `ragBlock` y por el mismo criterio:
   * lo que de verdad vio el modelo, no lo que la búsqueda puntuó. Ver
   * `lib/brain-sources-shape.ts` y la migración 0105.
   */
  let ragSources: BrainSource[] = [];
  // "Does this workspace know anything yet?" — counted on kb_documents rather
  // than kb_chunks. Two reasons, and the second is the real one: chunks have no
  // organization_id (they inherit it from their document, see migration 0064
  // § 12), so a count across every chunk in the install used to make a brand-new
  // company run retrieval because SOMEBODY ELSE had uploaded a file.
  //
  // The per-conversation adjustments ride along with the count that was already
  // being awaited here. Concurrent on purpose: it is one indexed lookup by
  // primary key and it hides entirely behind a query the turn was making
  // anyway, so the knobs cost the chat no wall-clock at all. `loadOverrides`
  // never throws — a diagnostics setting that fails to load costs the default
  // behaviour, never the answer.
  const requestedSpaceIds =
    parsed.data.spaceIds && parsed.data.spaceIds.length > 0 ? parsed.data.spaceIds : null;

  const [{ count: chunkCount }, overrides, visibleSpaces] = await Promise.all([
    db.from('kb_documents').select('id', { count: 'exact', head: true }),
    loadOverrides(db, conversationId),
    // Only when the person asked for a filter, and folded in here so it costs
    // the turn no wall-clock: it hides entirely behind two queries the turn was
    // already making. Needed for two things — checking the ids are real, and
    // getting the NAMES, which is what the model is told below.
    requestedSpaceIds ? listVisibleSpaces(db, user.id).catch(() => []) : Promise.resolve([]),
  ]);

  // ---------------------------------------------------------------------------
  // WHICH SPACES THIS TURN MAY RETRIEVE FROM
  //
  // Two sources say so and they are the same storage: the composer's filter,
  // which arrives on the request because a brand-new chat has no row to read
  // from yet, and `turn_context_settings.space_ids`, which is where that filter
  // is written down the moment a conversation exists (and what the diagnostics
  // panel at /conversations/[id] edits). The request wins when it is present,
  // because it is the more recent gesture by definition.
  //
  // THE ONE CASE WORTH ARGUING: every id sent is unknown — the space was
  // deleted, or shared out from under this person. The choice is between
  // retrieving NOTHING and dropping the filter. Nothing is the worse failure by
  // a distance: the assistant would answer "no hay nada sobre eso" forever,
  // truthfully, about a full brain, with no way for anybody to find out why. So
  // an entirely stale filter is dropped, and the strip in the composer is
  // rebuilt from the visible set on the next load, which is where it disappears
  // from the screen too.
  // ---------------------------------------------------------------------------
  const allowedSpaces = requestedSpaceIds
    ? visibleSpaces.filter((s) => requestedSpaceIds.includes(s.id))
    : [];
  const scopeSpaceIds =
    allowedSpaces.length > 0 ? allowedSpaces.map((s) => s.id) : overrides.spaceIds;
  const scopeNames = allowedSpaces.map((s) => s.name);

  // "Was this turn answered under an adjustment?" — the flag the capture uses
  // to mark a turn that did not behave like the default. A filter chosen in the
  // composer counts even on the very first turn, before there is a row to store
  // it in, or the one turn that is hardest to explain later would be the one
  // that looks untouched.
  recorder.adjusted(hasOverrides(overrides) || scopeNames.length > 0);

  /**
   * The filter, said out loud to the model.
   *
   * This is the part that stops the feature from being a trap. A person who
   * narrowed to "Aduanas" on Monday and asks about payroll on Thursday must not
   * read "la empresa no tiene nada sobre eso" — that sentence is false, they
   * cannot tell it is false, and it is how somebody concludes the brain is
   * empty and stops using it. Naming the spaces and demanding the distinction
   * puts the true sentence in the only place they are certainly looking: the
   * answer itself.
   *
   * It is a section of its own rather than part of the retrieved context so it
   * is there even on turns where retrieval never ran — a short question is
   * exactly as capable of coming back empty.
   */
  const scopeBlock =
    scopeNames.length > 0
      ? '<memory-scope>\n' +
        `La persona limitó Brain Knowledge a: ${scopeNames.join(', ')}.\n` +
        'No busques ni cites nada fuera de esos espacios. Si la respuesta no está ahí, ' +
        'dilo exactamente así: que buscaste SÓLO en esos espacios y que puede quitar el ' +
        'filtro para buscar en todo. Nunca digas que la empresa no tiene información ' +
        'sobre el tema, porque no lo sabes: sólo miraste una parte.\n' +
        '</memory-scope>'
      : '';

  // Spread conditionally because `undefined` means "no restriction" while `[]`
  // would mean "no space at all" — see ToolContext.kbSpaceIds. With no filter
  // this is `ctx` itself, so nothing about an ordinary turn changes.
  const scopedCtx = scopeSpaceIds ? { ...ctx, kbSpaceIds: scopeSpaceIds } : ctx;
  const fragmentLimit = overrides.fragmentLimit ?? DEFAULT_FRAGMENTS;
  if ((chunkCount ?? 0) === 0) {
    recorder.retrievalSkipped('Todavía no hay nada indexado en Brain Knowledge.', fragmentLimit);
  } else if (fragmentLimit === 0) {
    recorder.retrievalSkipped(
      'Alguien puso en cero los fragmentos para esta conversación.',
      fragmentLimit,
    );
  } else if (!shouldRunRag(ragQuery)) {
    recorder.retrievalSkipped(
      'El mensaje es muy corto o es un acuse de recibo, así que no valía la pena buscar.',
      fragmentLimit,
    );
  }
  // ---------------------------------------------------------------------------
  // THE TWO EMBEDDINGS, SIDE BY SIDE
  //
  // Retrieval and the semantic tool ranking each spend one round-trip to Voyage,
  // and neither reads a thing the other produces. They ran one after the other
  // because that is the order they were written in, and measured over real
  // turns that cost 496 ms + 247 ms of an 840 ms prelude (p50) — a quarter of a
  // second of pure waiting, on the part of the turn that happens before anything
  // at all is on the screen.
  //
  // Started here, awaited together below. Nothing inside either block changed:
  // same calls, same order within each, same values handed to the recorder. What
  // changed is only that the second no longer waits for the first. The stage
  // offsets in `turn_latencies.stages` are what proves it stayed that way — two
  // stages that begin at the same `at` really ran at once, and a future edit that
  // quietly re-serialises them will show up there.
  //
  // The transcript read joins them: it is pure I/O, it depends on neither, and
  // it was costing its 9 ms in a queue behind both.
  // ---------------------------------------------------------------------------
  const closeRetrieval = clock.open('retrieval');
  const retrieving = (async (): Promise<string> => {
    if ((chunkCount ?? 0) > 0 && fragmentLimit > 0 && shouldRunRag(ragQuery)) {
      // The relevance cut used to live here, as `score >= 0.65` on the blended
      // rank — a number that could not be interpreted and that, measured against
      // a real corpus, never got there at all: semantic matching alone tops out
      // around 0.49, so this block was discarding every correct result it was
      // ever handed. kb.search now applies the cut on cosine similarity, where a
      // threshold means something, and reports what it concluded in `coverage`.
      // See packages/agent-tools/src/kb/relevance.ts for the measurement.
      const ragOut = ragQuery
        ? await runTool(
            kbSearch,
            { query: ragQuery, limit: fragmentLimit },
            // The same narrowed context the tools get, so the fragments pasted
            // above the question and anything `kb.search` fetches mid-turn come
            // from the same set of spaces. They used to differ: the filter
            // reached the prepend and not the tool, so a model that decided to
            // look something up quietly searched the whole brain and cited a
            // space the person had excluded.
            scopedCtx,
          ).catch(() => null)
        : null;

      if (ragOut && ragOut.coverage === 'nothing') {
        // The empty case is now stated instead of skipped. An absent <context>
        // block is indistinguishable from "RAG did not run", so the model used to
        // answer from nothing with no idea it was doing so; being told, in words,
        // that the brain holds nothing on the subject is what lets it say so.
        ragBlock = `<context>\n${ragOut.summary}\n</context>`;
      } else if (ragOut && ragOut.hits.length > 0) {
        ragBlock =
          '<context>\n' +
          `${ragOut.summary}\n\n` +
          ragOut.hits
            .map(
              (h, i) =>
                // A chunk of a recording is located by its offset, not by a chunk
                // number, and its text already opens with the speaker — so this
                // reads "[12:34] Ana: …" and can be quoted straight back. The age
                // and the "coincidencia débil" marker travel with the citation
                // because they change what it is worth: a rate from a year ago is
                // a different claim from the same rate quoted last week.
                `[^${i + 1}] ${h.documentTitle} ${h.spokenAt ? `at ${h.spokenAt}` : `chunk ${h.chunkIndex}`}` +
                `${h.age ? ` · ${h.age}` : ''}${h.relevance === 'weak' ? ' · coincidencia débil' : ''}:\n` +
                `${h.spokenAt ? `[${h.spokenAt}] ` : ''}${h.content}`,
            )
            .join('\n\n') +
          (ragOut.conflicts && ragOut.conflicts.length > 0
            ? `\n\n${ragOut.conflicts.map((c) => `⚠ CONFLICTO: ${c.note}`).join('\n')}`
            : '') +
          // La regla que pide USAR los números de arriba. Vivía en ninguna
          // parte: este bloque lleva numerando los fragmentos desde siempre y
          // nada se lo pedía al modelo ni los dibujaba en pantalla — la
          // numeración se mandaba al vacío y se pagaba en tokens. Va aquí,
          // pegada a los números que describe y sólo en la rama que los
          // produce, en lugar de en el prompt del agente: el argumento entero
          // está en `CITATION_RULE`, en lib/citations.ts.
          `\n\n${CITATION_RULE}` +
          '\n</context>';

        // Sólo en esta rama, y ésa es la decisión. `coverage === 'nothing'`
        // también escribe un bloque —para que el modelo SEPA que no hay nada y
        // pueda decirlo— pero ahí no se leyó ningún documento, así que no hay
        // ninguna procedencia que enseñar. Un chip de procedencia vacío
        // devalúa todos los reales; lo dice `docs/design-system.md` y es la
        // misma regla, aplicada aquí.
        ragSources = collectBrainSources(ragOut.hits);
      }

      // Written down from the block that was just built, not from the scores.
      // `ragOut.hits` IS what got pasted above the question — anything the floor
      // dropped never appears in it — so this set is the ground truth for which
      // fragments the model really saw, and `retrievalSeen` supplies the ones it
      // did not. Neither is re-derived: see ToolContext.onRetrieval.
      if (retrievalSeen) {
        const prepended = new Set(
          ragBlock && ragOut ? ragOut.hits.map((h) => fragmentKey(h.documentId, h.chunkIndex)) : [],
        );
        recorder.retrieved(retrievalSeen, prepended);
      } else if (!ragOut) {
        recorder.retrievalSkipped(
          'La búsqueda en Brain Knowledge falló en este turno.',
          fragmentLimit,
        );
      }
    }
    return ragBlock;
  })().finally(closeRetrieval);

  const recentText = messages
    .filter((m) => m.role === 'user')
    .slice(-4)
    .map((m) => m.content)
    .join('\n');

  // The permissions, the connected servers, the workspace's own tools and the
  // ranking that chooses between them are one stage: everything the turn does to
  // work out which tools the model is offered. Runs beside retrieval — see the
  // note above the two of them.
  const closeSelection = clock.open('selection');
  const selecting = (async () => {
    // Team tool permissions are a deny-list layered on the agent's tools:
    // anything blocked by ANY of the user's teams never reaches the model. Run
    // alongside the external-MCP fetch — neither depends on the other, and both
    // have to finish before anything can be ranked.
    //
    // Per-user MCP failures must never break the turn, so that fetch is
    // best-effort.
    const [deniedPatterns, externalServers, customRows, stickyIds] = await Promise.all([
      deniedToolPatterns(db, user.id),
      fetchEnabledExternalTools(db, user.id).catch(() => []),
      fetchEnabledCustomTools(db).catch(() => []),
      // Lo ya ofrecido en esta conversación, para que la lista de este turno
      // conserve el prefijo de los anteriores — ver el combine más abajo y la
      // cabecera de tool-selection/sticky.ts. Nunca lanza; fallar aquí cuesta
      // una reescritura de caché, no el turno.
      loadStickyToolIds(db, conversationId),
    ]);

    const registryCandidates: Candidate[] = filterTools(agent.allowedTools)
      .filter((t) => deniedPatterns.length === 0 || !isToolDenied(t.id, deniedPatterns))
      .map((t) => ({
        id: t.id,
        family: t.id.split('.')[0] ?? t.id,
        description: t.description,
        kind: 'registry' as const,
        ref: t,
      }));

    // The workspace's own tools (migration 0067). They are `kind: 'registry'`
    // candidates on purpose: a custom tool IS an ordinary ToolDef by the time it
    // gets here, so it takes the same execute path below and therefore the same
    // runTool guarantees — audit, confirmation, rate limit, risk classification.
    // The only thing that differs is where the definition came from.
    //
    // They pass through the identical access gates: the agent's grant patterns
    // (`toolIdAllowed`, the same matcher `filterTools` uses on the registry) and
    // the team deny-list. A tool a company wrote for itself is not exempt from
    // the permissions that company configured.
    //
    // One family for all of them, not one per tool. Ranking promotes whole
    // families (see tool-selection/rank.ts), and one custom tool proving relevant
    // pulling in the handful of others costs a few declarations — while a family
    // per tool would compete for the six situational slots against gmail, kb and
    // the rest, and start pushing real families out on vague requests.
    const customCandidates: Candidate[] = customRows
      .map((row) => customToolDef(row))
      .filter(
        (t) =>
          toolIdAllowed(agent.allowedTools, t.id) &&
          (deniedPatterns.length === 0 || !isToolDenied(t.id, deniedPatterns)),
      )
      .map((t) => ({
        id: t.id,
        family: CUSTOM_TOOL_FAMILY,
        description: t.description,
        kind: 'registry' as const,
        ref: t as AnyTool,
      }));

    const externalCandidates: Candidate[] = externalServers.flatMap(({ server, tools }) =>
      tools.map((entry) => ({
        // Namespaced by server so two servers exposing `search` stay distinct,
        // and stable across turns so the stored vector keeps matching.
        id: `mcp:${server.id}:${entry.tool_name}`,
        // One connected server is one family: its tools were designed to be used
        // together, exactly like `hubspot` was.
        family: `mcp:${server.id}`,
        description: entry.tool_description ?? '',
        kind: 'external' as const,
        ref: { server, entry },
      })),
    );

    // Semantic scoping. This replaced a hand-written regex per family, which was
    // wrong the moment anyone shipped a family or connected an MCP server without
    // editing this file — see packages/agent-tools/src/tool-selection. Everything
    // it can fail on (Voyage, the vector table, an unindexed tool) degrades to
    // sending MORE tools, never fewer.
    const allCandidates = [...registryCandidates, ...customCandidates, ...externalCandidates];
    const selection = await selectToolsForTurn({
      db,
      tools: allCandidates,
      query: recentText,
    });
    return { selection, allCandidates, stickyIds };
  })().finally(closeSelection);

  // The transcript. Fired alongside the two above and joined with them: it
  // reads a table neither of them touches and was previously queued behind both.
  const closeHistory = clock.open('history');
  const loadingHistory = (async () => {
    if (!conversationId) return null;
    try {
      const { data } = await db
        .from('messages')
        .select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(20);
      return data;
    } catch {
      // non-fatal, use client messages
      return null;
    }
  })().finally(closeHistory);

  // Files attached to this conversation that the person chose NOT to remember
  // (migration 0088). Joined with the three above rather than awaited on its
  // own: it is one indexed lookup by conversation_id, it depends on nothing,
  // and run here it costs the prelude no wall-clock at all. It never throws —
  // see lib/chat-attachments.ts.
  const loadingAttachments = loadTurnAttachments(db, conversationId);

  const [ragBlockResolved, { selection, allCandidates, stickyIds }, dbMessages, turnAttachments] =
    await Promise.all([retrieving, selecting, loadingHistory, loadingAttachments]);
  // Taken from the resolved value rather than left to the closure's assignment,
  // so the block is provably finished before anything downstream reads it.
  ragBlock = ragBlockResolved;
  const attachmentBlock = renderTurnAttachmentBlock(turnAttachments);

  // A conversation may withhold a whole family. Applied AFTER ranking rather
  // than by removing candidates before it, so the capture can still show what
  // the muted family would have scored — "you turned this off and it was the
  // best match" is the thing somebody needs to see to undo the decision. It
  // only ever removes: nothing here can offer a tool the agent's grants and the
  // team deny-list did not already allow.
  const mutedFamilies = new Set(overrides.mutedFamilies);
  const dropMuted = (list: Candidate[]) =>
    mutedFamilies.size === 0 ? list : list.filter((t) => !mutedFamilies.has(t.family));

  // ESTABILIZAR ANTES DE DECLARAR. El caché de prompts de Anthropic es un
  // prefijo y las herramientas se serializan antes del system prompt, así que
  // una lista que cambia entre turnos de la misma conversación invalida el
  // prefijo entero y convierte cada turno en una ESCRITURA al 125 % en vez de
  // una lectura al 10 % — que es exactamente lo que medía turn_latencies. La
  // selección semántica sigue decidiendo QUÉ entra; esto sólo decide DÓNDE va:
  // lo ya ofrecido conserva su posición y lo nuevo se agrega al final. Política
  // completa (tope, congelación, cola transitoria) en la cabecera de
  // packages/agent-tools/src/tool-selection/sticky.ts.
  //
  // Los candidatos van filtrados por mute igual que la selección: una familia
  // silenciada a mitad de conversación deja de materializarse aunque esté en la
  // lista persistida (y recupera su posición si la des-silencian).
  const sticky = combineStickySelection({
    previousIds: stickyIds,
    offered: dropMuted(selection.tools),
    candidates: dropMuted(allCandidates),
    // Las familias sin indexar duran un turno por diseño (el backfill las hace
    // rankeables al siguiente), así que viajan en la cola y no quedan pegadas.
    transientFamilies: new Set(selection.unrankedFamilies),
    // Un turno en el que la selección no midió nada manda el catálogo entero;
    // ofrecerlo sí, persistirlo no — congelaría el presupuesto sin criterio.
    freeze: selection.reason === 'no-query' || selection.reason === 'embedding-unavailable',
  });
  const selectedTools = sticky.tools;
  if (sticky.changed) {
    // Sin await: la respuesta no depende de esta escritura, y perderla cuesta
    // una reescritura de caché en el próximo turno, no el turno.
    void saveStickyToolIds(db, { conversationId, userId: user.id, ids: sticky.persistIds });
  }
  logger.debug('chat tool selection', {
    reason: selection.reason,
    offered: selectedTools.length,
    of: allCandidates.length,
    families: selection.selectedFamilies,
    unranked: selection.unrankedFamilies,
  });

  // The ranking as it happened. It cannot be recovered afterwards even in
  // principle — the query vector is not kept and a tool's vector is re-embedded
  // the moment somebody edits its description — so it is written down here or
  // it is lost. `offered` is read off the declarations actually built, below,
  // rather than from this list, so the record is of what the model saw.
  recorder.toolOffer({
    reason: selection.reason,
    candidates: allCandidates.length,
    // The pointing tool is appended rather than ranked: it is declared below on
    // turns that carry a frame and on no others, so it never went through the
    // selection this record is otherwise about. It is in the list all the same,
    // because this column is what somebody reads to find out what the model was
    // holding when it answered, and a tool missing from it is a tool nobody can
    // account for later.
    offered: [
      ...selectedTools.map((t) => t.id),
      ...(glance ? [POINT_AT_TOOL_ID] : []),
      // Por el mismo motivo que la de señalar: esta columna es lo que alguien
      // lee para saber qué tenía el modelo en la mano cuando contestó, y una
      // herramienta que falta de ella es una herramienta de la que nadie puede
      // dar cuenta después.
      ASK_CHOICE_TOOL_ID,
    ],
    families: familiesFrom({
      scores: selection.familyScores,
      alwaysFamilies: selection.alwaysFamilies,
      selected: selection.selectedFamilies,
      unranked: selection.unrankedFamilies,
      muted: overrides.mutedFamilies,
    }),
  });

  const aiTools: Record<string, CoreTool> = {};
  for (const candidate of selectedTools) {
    if (candidate.kind === 'registry') {
      const t = candidate.ref;
      // AI SDK requires tool names matching ^[a-zA-Z0-9_-]+$ — replace dots with underscores
      aiTools[t.id.replaceAll('.', '_')] = tool({
        description: t.description,
        parameters: t.inputSchema,
        execute: async (args, { abortSignal }) => {
          // Counted and summed here; the per-tool breakdown already exists, one
          // row per call with its own latency, in `audit_events`. What that
          // table cannot say is how much of ONE TURN was spent in tools, because
          // it has no notion of a turn — so only the count and the sum are kept.
          const toolStarted = performance.now();
          try {
            return await runTool(t, args, { ...scopedCtx, signal: abortSignal });
          } catch (err) {
            if (err instanceof ConfirmationRequiredError) {
              // Return a sentinel value the client can detect to show a confirmation prompt
              return {
                __requires_confirmation: true,
                toolId: t.id,
                input: err.input,
              } as unknown as never;
            }
            // Never throw: a failed tool must not kill the turn. Return a
            // structured error so (a) the model can read it, explain it, and
            // keep going, and (b) the UI renders it as a failed tool card.
            //
            // The envelope is capped for the model; the whole failure — SQL
            // state, hint, stack — goes to the log, because the envelope is the
            // only trace a tool failure leaves and it is not enough to debug on.
            logger.error('tool failed', { tool: t.id, ...toolErrorDetail(err) });
            return {
              __error: true,
              tool: t.id,
              message: toolErrorMessage(err),
            } as unknown as never;
          } finally {
            // In `finally` so a tool that failed still counts. A turn that spent
            // eleven seconds discovering it had no Gmail scope spent them.
            clock.toolFinished(performance.now() - toolStarted);
          }
        },
      });
      continue;
    }

    const { server, entry } = candidate.ref;
    const prefix = 'mcp_' + server.id.replace(/-/g, '').slice(0, 16) + '_';
    const sdkName = (prefix + entry.tool_name).slice(0, 64);
    aiTools[sdkName] = tool({
      description: (entry.tool_description ?? '').slice(0, 500),
      parameters: jsonSchema(
        (entry.input_schema_json ?? {
          type: 'object',
          properties: {},
        }) as Parameters<typeof jsonSchema>[0],
      ),
      execute: async (args, { abortSignal }) => {
        if (!server.trusted) {
          return {
            __requires_confirmation: true,
            toolId: sdkName,
            input: args,
          } as unknown as never;
        }
        // A connected MCP server is somebody else's network, and it is the most
        // likely source of a turn that hangs. Timed on the same footing as the
        // built-in tools so a slow server shows up in the same number.
        const toolStarted = performance.now();
        try {
          return await callExternalTool(
            server as unknown as ExternalServerRow,
            entry.tool_name,
            args,
            {
              userId: user.id,
              db,
              signal: abortSignal,
            },
          );
        } catch (err) {
          logger.error('external tool failed', {
            server: server.name,
            tool: entry.tool_name,
            ...toolErrorDetail(err),
          });
          return {
            __error: true,
            tool: `${server.name}/${entry.tool_name}`,
            message: toolErrorMessage(err),
          } as unknown as never;
        } finally {
          clock.toolFinished(performance.now() - toolStarted);
        }
      },
    });
  }

  /**
   * SEÑALAR. Offered only when there is something to point at.
   *
   * The `if` is the design, not a guard. Every other tool in this map earned its
   * place through the ranker; this one is declared on exactly the turns that
   * carry a frame and withheld on every other, which is a decision the ranker
   * could not make — it ranks by what the question is ABOUT, and whether a
   * picture came is a property of the request. A model that cannot see a screen
   * cannot be tempted to draw a box on one.
   *
   * `execute` calls nothing and reaches nothing: it hands back the model's own
   * rectangles with the impossible ones removed, so the tool result that lands
   * on the client is already safe to paint. See lib/screen-glance.ts for why
   * this is a tool at all rather than a block of structured output, and
   * lib/screen-marks.ts for what "impossible" means here.
   *
   * It does NOT go through `runTool`, and it is the only entry in this map that
   * does not: there is no side effect to audit, no rate limit that means
   * anything on a pure function, and nothing to confirm. It also does not touch
   * `clock.toolFinished` — the arithmetic runs in microseconds, and counting it
   * as a tool call would put a zero into the median that measures how long real
   * tools take.
   */
  if (glance) {
    aiTools[POINT_AT_TOOL_NAME] = tool({
      description: POINT_AT_DESCRIPTION,
      parameters: PointAtSchema,
      execute: async (args) => pointAtResult(args),
    });
  }

  /**
   * PREGUNTAR. Declarada en todos los turnos de esta superficie, y en ninguna
   * otra parte.
   *
   * Se parece a la de señalar en todo salvo en la condición. Aquélla se ofrece
   * sólo cuando llegó un cuadro, porque no se puede señalar sobre nada; ésta se
   * ofrece siempre, porque cualquier turno puede toparse con una ambigüedad que
   * sólo una persona resuelve. Lo que comparten es lo importante: no pasan por
   * `runTool` —no hay efecto que auditar, ni límite de frecuencia que signifique
   * algo sobre una función pura, ni nada que confirmar—, no están en el
   * registro, y por tanto no las puede conceder un agente, levantarlas un
   * mandato ni ofrecerlas el rankeador.
   *
   * `preguntadas` ES EL LÍMITE DURO DE UNA POR TURNO, y vive aquí porque aquí es
   * donde existe la noción de turno. Un contador en el manejador de la
   * herramienta no podría distinguir dos preguntas del mismo turno de dos
   * preguntas de dos turnos seguidos, que son cosas distintas: la segunda es
   * legítima (la persona contestó y siguió apareciendo ambigüedad), la primera
   * es una tarjeta tapando a otra.
   *
   * NO CONFIRMA NADA Y NO PUEDE. Ver la cabecera entera de lib/ask-choice.ts: la
   * puerta de una herramienta peligrosa la sigue abriendo `ConfirmationRequired-
   * Error` y la política de riesgo, y elegir una opción sólo escribe un mensaje
   * de la persona en el hilo.
   */
  let preguntadas = 0;
  aiTools[ASK_CHOICE_TOOL_NAME] = tool({
    description: ASK_CHOICE_DESCRIPTION,
    parameters: AskChoiceSchema,
    execute: async (args) => askChoiceResult(args, { alreadyAsked: preguntadas++ > 0 }),
  });

  // Read far above, alongside retrieval and the tool ranking. Merged here, where
  // it always was — the merge is pure array work and belongs next to what uses
  // it, not next to the query that fetched the rows. Vive en `lib/turn-messages.ts`
  // para que se pueda probar: el fallo que arregla («the conversation must end
  // with a user message», en producción, al escribir) no lo habría cazado nada
  // desde dentro de esta ruta.
  let coreMessages: CoreMessage[] = buildTurnMessages(
    messages.map((m) => ({ role: m.role, content: m.content })),
    (dbMessages ?? null) as { role: string; content: string }[] | null,
  );

  // Shared with Google Chat and MCP so a person's standing instructions cannot
  // apply on one surface and silently not on another. See lib/system-prompt.ts.
  //
  // SIN `sections` EN ESTA SUPERFICIE, Y ES A PROPÓSITO. Esos bloques (el
  // filtro de espacios, los fragmentos de Brain Knowledge, los adjuntos, la
  // nota de pantalla con su timestamp) cambian en cada turno, y el breakpoint
  // del caché de prompts se marca al FINAL del system (ver markCacheBreakpoint
  // en packages/agent-tools/src/model.ts): un byte volátil aquí invalidaba el
  // prefijo entero — tools incluidas — y cada turno pagaba una ESCRITURA de
  // caché al 125 % en vez de una lectura al 10 %. Ahora el system queda con lo
  // estable de la conversación (prompt del agente, ficha de la empresa,
  // memorias) y lo volátil viaja pegado al último mensaje, después del
  // breakpoint — ver `turnBlocks` más abajo.
  const { system, memories, memoryBlock, companyBlock } = await clock.span(
    'prompt',
    buildSystemPrompt({
      organizationId: user.organization.id,
      userId: user.id,
      basePrompt: agent.systemPrompt,
    }),
  );

  // Weigh the turn from the strings that were really concatenated — every one
  // of these is the exact text that went into the request, so `chars` is a
  // measurement and not a guess. (Tokens are derived from it and are labelled
  // as an estimate on screen; the provider's true count is recorded below.)
  //
  // The tool part is measured as the ids and descriptions the model reads. The
  // JSON envelope around them is not counted, because serialising every
  // parameter schema per turn is real work on the hot path for a number the
  // descriptions already dominate — a catalogue's descriptions run to hundreds
  // of characters each. The page says so rather than implying the breakdown is
  // the whole request.
  recorder.basePrompt(agent.systemPrompt);
  recorder.memory(memories.map((m) => ({ id: m.id, text: m.content })));
  // The live-tab block travels glued to the base prompt on every surface (see
  // LIVE_BROWSING_BLOCK in lib/system-prompt.ts), so it is weighed with the
  // instructions it extends — leaving it out would understate every turn by
  // exactly its length.
  recorder.part('instructions', `${agent.systemPrompt}\n\n${LIVE_BROWSING_BLOCK}`);
  recorder.part('memory', memoryBlock);
  // Su propia etiqueta y no sumado a 'memory': lo escribe un admin una vez y lo
  // paga todo el mundo en cada turno, así que si un día pesa demasiado la
  // pantalla tiene que poder señalar la ficha de la empresa y no las memorias de
  // quien está mirando —que no puede podar lo que no es suyo—. Sin esta línea la
  // barra mentiría por exactamente la longitud del bloque.
  recorder.part('company', companyBlock);
  // The filter is weighed with the knowledge it filters, because that is the
  // string that really went in and this measurement is of characters sent, not
  // of features used.
  recorder.part('knowledge', scopeBlock ? `${scopeBlock}\n${ragBlock}` : ragBlock);
  recorder.part(
    'tools',
    [
      ...selectedTools.map((t) => `${t.id}: ${t.description}`),
      // Declared just above and not part of the ranking, so it has to be added
      // by hand or the weight of a screen turn is understated by the length of
      // its description. This measurement is of characters really sent.
      ...(glance ? [`${POINT_AT_TOOL_ID}: ${POINT_AT_DESCRIPTION}`] : []),
      // Se declara siempre, así que pesa siempre. Sin esta línea la barra
      // subestimaría todos los turnos por la longitud de su descripción.
      `${ASK_CHOICE_TOOL_ID}: ${ASK_CHOICE_DESCRIPTION}`,
    ].join('\n'),
  );
  // Split at the last message rather than by role, so the two parts are exactly
  // the array that was sent and cannot double-count a single character.
  recorder.part(
    'history',
    coreMessages
      .slice(0, -1)
      .map((m) => String(m.content))
      .join('\n'),
  );
  recorder.part('question', String(coreMessages[coreMessages.length - 1]?.content ?? ''));

  /**
   * The frame goes in LAST, after the turn has been weighed.
   *
   * Two reasons it is here and not up where `coreMessages` is built. The
   * measurement above counts CHARACTERS of text that really went in, and a
   * message whose content became an array of parts would have been stringified
   * into "[object Object]" — a made-up number in a table whose whole purpose is
   * that its numbers are measured. And putting it at the very end means the
   * image is the last thing added before the call, so nothing between here and
   * `streamText` can accidentally read a message shape it was not written for.
   *
   * It attaches to the LAST user message rather than to a message of its own:
   * the picture is part of the question, not a separate turn, and a model that
   * receives it as its own message has to guess which question it belongs to.
   */
  // LO VOLÁTIL DEL TURNO, DESPUÉS DEL BREAKPOINT. Estos bloques vivían en el
  // system prompt y cambiaban en cada turno (los fragmentos dependen de la
  // última pregunta; la nota de pantalla lleva un timestamp), así que rompían
  // el prefijo del caché por delante del breakpoint — ver la nota sobre
  // `buildSystemPrompt` arriba. Van encima de la pregunta, que es como los
  // describía este archivo desde siempre («pasted above the question»), y como
  // el historial del próximo turno se relee de la tabla `messages` — donde la
  // pregunta se guardó limpia, más arriba — no se acumulan turno tras turno.
  //
  // El bloque de adjuntos sigue deliberadamente separado de `ragBlock`: un
  // archivo efímero no debe parecer algo que vive en el cerebro, o la
  // respuesta cita un documento que nadie puede abrir. Ver lib/chat-attachments.ts.
  //
  // Después de pesar el turno (los `recorder.part` de arriba ya cuentan estos
  // bloques bajo 'knowledge' y compañía; sumarlos también a 'question' los
  // contaría dos veces) y antes del fotograma, que debe seguir siendo lo
  // último que se agrega.
  const turnBlocks = [
    scopeBlock,
    ragBlock,
    attachmentBlock,
    glance ? screenBlock(glance.takenAt) : '',
  ]
    .filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
    .join('\n\n');
  if (turnBlocks) {
    const last = coreMessages[coreMessages.length - 1];
    // `buildTurnMessages` garantiza que la conversación termina en mensaje de
    // usuario; el guard es por si esa garantía se moviera algún día.
    if (last && last.role === 'user' && typeof last.content === 'string') {
      coreMessages = [
        ...coreMessages.slice(0, -1),
        { ...last, content: `${turnBlocks}\n\n${last.content}` },
      ];
    }
  }
  if (glance) coreMessages = attachScreenFrame(coreMessages, glance);

  // Everything before this line is Cortex's own work, and it is the only part
  // of the wait that can be shortened without touching the model or the answer.
  clock.handedToModel();

  const result = streamText({
    model: chatModel(agent.defaultModel),
    system,
    messages: coreMessages,
    tools: aiTools,
    toolChoice: 'auto',
    maxSteps: 12,
    // The one measurement that has to happen mid-stream, because it is the only
    // moment that matters and it is over before `onFinish` runs. The callback is
    // a comparison and an assignment — the SDK pauses the stream until it
    // resolves, so anything more here would literally slow the answer down in
    // order to time it.
    //
    // Reasoning counts as visible: `sendReasoning` is on, the client draws it in
    // the reasoning trail, and a person watching words appear is not watching a
    // blank screen. It is recorded apart from the answer all the same — see
    // TurnLatency.firstAnswerMs.
    onChunk: ({ chunk }) => {
      if (chunk.type === 'text-delta') clock.visible('answer');
      else if (chunk.type === 'reasoning' || chunk.type === 'tool-call') clock.visible('reasoning');
    },
    // One round-trip finished. Recorded per step and not per turn because the
    // prompt cache works per request: on a turn that calls tools, the first
    // request writes the prefix and the rest should read it back. A per-turn
    // figure would blur exactly the distinction that says whether it works.
    onStepFinish: ({ usage, providerMetadata }) => {
      clock.modelStep(usage, providerMetadata);
    },
  });

  /**
   * LA RESPUESTA SE ESCRIBE DESPUÉS DE DEVOLVER EL STREAM.
   *
   * En Vercel la función puede terminar en cuanto cierra el HTTP aunque el
   * `onFinish` del SDK todavía tenga un insert pendiente — la persona ve la
   * respuesta en vivo (viene del stream) pero al reabrir el hilo sólo están
   * sus prompts. `after()` es el mismo patrón que `/api/chat-app/google`:
   * Next mantiene la invocación viva hasta que este bloque termina.
   */
  after(async () => {
    try {
      const [text, steps, toolCalls, toolResults, usage] = await Promise.all([
        result.text,
        result.steps,
        result.toolCalls,
        result.toolResults,
        result.usage,
      ]);
      clock.finished(usage);

      const startedErrands = (toolResults ?? []).flatMap((r) => {
        const call = r as { toolName?: string; result?: { errandId?: unknown } };
        if (call.toolName !== 'errands_start') return [];
        const id = call.result?.errandId;
        return typeof id === 'string' && id ? [id] : [];
      });
      if (startedErrands.length > 0) {
        await enqueueJobs(
          startedErrands.map((errandId) => ({
            name: EVENT_ERRAND_ADVANCE,
            data: {
              errandId,
              organizationId: user.organization.id,
              userId: user.id,
              because: 'created' as const,
            },
          })),
        );
      }

      const storedParts = (() => {
        try {
          const built = buildStoredParts(steps ?? []);
          return built ? capStoredParts(built) : null;
        } catch {
          return null;
        }
      })();

      const baseRow = {
        conversation_id: conversationId,
        role: 'assistant' as const,
        content: text,
        tool_calls: toolCalls as unknown as object,
        tool_results: toolResults as unknown as object,
      };

      let assistantMessageId: string | null = null;
      const { data: assistantRow, error: insertError } = await db
        .from('messages')
        .insert({
          ...baseRow,
          parts: storedParts as unknown as object,
          brain_sources: ragSources.length > 0 ? ragSources : null,
        })
        .select('id')
        .single();

      if (insertError) {
        logger.error('chat: assistant message insert failed', {
          conversationId,
          message: insertError.message,
          code: insertError.code,
        });
        const { data: fallbackRow, error: fallbackError } = await db
          .from('messages')
          .insert(baseRow)
          .select('id')
          .single();
        if (fallbackError) {
          logger.error('chat: assistant message fallback insert failed', {
            conversationId,
            message: fallbackError.message,
            code: fallbackError.code,
          });
        } else {
          assistantMessageId = (fallbackRow?.id as string | undefined) ?? null;
        }
      } else {
        assistantMessageId = (assistantRow?.id as string | undefined) ?? null;
      }

      if (assistantMessageId) {
        const isFirstTurn = coreMessages.filter((m) => m.role === 'assistant').length <= 1;
        if (isFirstTurn && lastUserMessage) {
          void (async () => {
            try {
              const { text: titleText } = await generateText({
                model: utilityModel(),
                prompt: `Summarize this sales conversation starter in 5 words or fewer, no punctuation: "${lastUserMessage.content.slice(0, 200)}"`,
                providerOptions: NO_THINKING,
                maxTokens: 256,
              });
              await db
                .from('conversations')
                .update({ title: titleText.trim() })
                .eq('id', conversationId);
            } catch {
              /* non-fatal */
            }
          })();
        }

        await db.from('audit_events').insert({
          user_id: user.id,
          agent_id: agent.id,
          conversation_id: conversationId,
          tool_id: '__agent_turn',
          input_hash: 'turn',
          status: 'ok',
          latency_ms: Math.round(performance.now() - started),
          metadata: {
            model: agent.defaultModel,
            tokensIn: usage?.promptTokens ?? 0,
            tokensOut: usage?.completionTokens ?? 0,
            firstVisibleMs: clock.snapshot().firstVisibleMs,
          },
        });
      }

      await Promise.all([
        recorder.save(db, {
          messageId: assistantMessageId,
          usage: {
            promptTokens: usage?.promptTokens,
            completionTokens: usage?.completionTokens,
          },
        }),
        clock.save(db, { messageId: assistantMessageId }),
      ]);
    } catch (err) {
      logger.error('chat: post-turn persistence failed', {
        conversationId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return result.toDataStreamResponse({
    headers: { 'X-Conversation-Id': conversationId },
    // Send the model's reasoning to the client. Opus 5 thinks before it writes,
    // and on a turn that calls tools that thinking is the only account of why it
    // chose them — without it the user watches a long silence and then a result,
    // with no way to judge whether the route taken was sensible.
    sendReasoning: true,
    // An error part on the data stream makes useChat drop the assistant message
    // it was building, so a hiccup the model itself recovered from wiped the
    // whole answer from the screen — the reply was in the database and only
    // reappeared on reload. Surfacing the real reason turns a silent
    // "An error occurred." into something both the user and we can act on.
    getErrorMessage: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('chat stream error', { message });
      return message.slice(0, 300);
    },
  });
}
