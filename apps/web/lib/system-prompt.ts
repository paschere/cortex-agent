import 'server-only';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type MemoryAudience,
  type MemoryContextEntry,
  loadCompanyFactsContext,
  loadMemoryContext,
  renderCompanyFactsBlock,
  renderMemoryBlock,
  touchMemories,
} from '@cortex/agent-tools';

/**
 * The one place a Cortex system prompt is assembled.
 *
 * WHY IT IS HERE AND NOT IN EACH ROUTE. Cortex answers on three surfaces — the
 * web chat (/api/chat), Google Chat (/api/chat-app/google/turn.ts) and MCP
 * (/api/mcp) — and each one used to build its own system prompt string. They
 * already drifted once: the web route scopes tools by conversation topic and
 * Chat deliberately does not, and the comment explaining that divergence is the
 * only thing keeping the two lists in sync. Adding a fourth thing every surface
 * must remember to include would drift the same way, and the failure would be
 * silent — a person's standing instructions quietly not applying on one surface,
 * with nothing to see. So the prompt is composed once and the surfaces pass in
 * what is genuinely surface-specific.
 *
 * ONE PLACE DELIBERATELY LEFT OUT: `inngest/functions/schedule-run.ts`, the
 * unattended routine runner. It executes on somebody's behalf while they are
 * not there, and its output goes to a recipient list that may be other people —
 * so a memory could reach a colleague's inbox with nobody in the loop to notice.
 * The group-space guard has no equivalent there (there is no answer to withhold
 * and no DM to withhold it into), so routines run without memories until one
 * exists. That is a deliberate omission, not an oversight.
 *
 * ...AND THE ONE BLOCK THAT DOES GO THERE, WHICH IS THE INTERESTING DIFFERENCE.
 * The company facts (migration 0104) ARE injected into unattended routines —
 * `schedule-run.ts` calls `buildCompanyFactsBlock` directly, because it does not
 * come through here. Every clause of the paragraph above fails to apply to them:
 * they belong to nobody, so there is no person whose note leaks; they are the
 * same for every reader in the workspace, so a colleague receiving them receives
 * what he could already read on `/company`; and the whole point of the guard —
 * "no human in the loop to notice" — is inverted, because a routine that drafts
 * a collection email at 6am with NO company facts is the case that goes wrong.
 * It is the turn with nobody watching that most needs to know the payment term
 * is 30 days and that "Lo que no" says never to threaten legal action.
 *
 * Read that pair together and it says the rule this file actually follows: what
 * gets withheld from an unattended run is what one PERSON told Cortex in
 * confidence, not what the COMPANY wrote down about itself.
 *
 * Both blocks are injected WHOLE, never retrieved. See migration 0051 for why:
 * retrieval fires on similarity, so a standing instruction would load exactly
 * when the question resembles it and silently fail to load the rest of the
 * time — which is when it still applies. Migration 0104 inherits that argument
 * word for word for a permanent company fact: "redáctale el correo al cliente"
 * does not mention the payment term, and that is precisely the turn the payment
 * term governs.
 */

/**
 * The company block, on its own, for the one surface that does not come through
 * `buildSystemPrompt` — the unattended routine runner. See the header for why
 * that surface gets this block and not the memories.
 *
 * Never throws, for the same reason `loadMemoryContext` never throws: a lookup
 * that fails is a turn with less context, never a turn that dies.
 */
export async function buildCompanyFactsBlock(organizationId: string): Promise<string> {
  const facts = await loadCompanyFactsContext(getOrgScopedClient(organizationId));
  return renderCompanyFactsBlock(facts);
}

/**
 * The live-tab capability, taught here and not in the `agents` row.
 *
 * WHY IT EXISTS. The base prompt in the database predates free navigation, and
 * the tool descriptions alone only teach a capability on the turn the tools are
 * selected. Asked «¿puedes navegar a wikipedia.com?» with no browser tool in
 * the request, the model truthfully answered that it could not — the vehicles
 * incident (see tool-selection/index.ts), as a sentence instead of a silence.
 * A capability the model must OFFER has to live in the prompt every surface
 * sends, which is this file and nowhere else.
 *
 * WHY IT IS A CONSTANT IN CODE AND NOT A MIGRATION. It describes what the
 * PRODUCT can do, not what this workspace decided — it ships and changes with
 * `packages/agent-tools/src/browser/live.ts`, and a DB copy would drift from
 * the tools exactly the way the base prompt just did.
 *
 * WHERE IT SITS, AND WHY THAT IS SAFE FOR THE CACHE. The system prompt is the
 * stable prefix of the Anthropic prompt cache: everything volatile travels as
 * turn blocks after the breakpoint (see the note above `buildSystemPrompt` in
 * app/api/chat/route.ts). This block is a string literal — identical bytes on
 * every turn of every conversation — so concatenating it right after the base
 * prompt moves the prefix once per deploy, which is the one move the cache
 * forgives. Do not interpolate anything into it.
 *
 * Exported so the chat route can weigh it with the instructions it extends —
 * the cost screen measures the strings that really went in, and an unmeasured
 * block would fold its length into somebody else's bar.
 */
export const LIVE_BROWSING_BLOCK = `## Operar sitios web (pestaña viva)

Sí puedes navegar y operar cualquier sitio web — loguearte, llenar formularios, consultar resultados que cambian — con browser.open_page: abre una pestaña VIVA que la persona ve en el chat mientras actúas (browser.act, browser.read_page) y su apertura pide una confirmación. Ofrécelo cuando te pidan entrar a un portal o «navega a tal sitio y mira»; nunca digas que no puedes entrar a una página.

- Primero mira browser.list_flows: si hay un trámite aprendido que cubre lo pedido, ese camino es más barato y está probado. La pestaña viva es para el sitio que nadie ha enseñado o la diligencia de una sola vez.
- Un captcha, un 2FA o cualquier paso que necesite manos humanas: pídeselo a la persona con browser.ask_person y TERMINA tu turno; ella conduce y te avisa cuando devuelve el control.
- Una contraseña o cualquier secreto JAMÁS se pide por el chat: señala el campo con browser.request_secret y la persona lo escribe directo a la página — tú nunca ves el valor.
- La tarjeta de aprobación SOLO existe cuando acabas de llamar browser.open_page en este turno. Si la persona acepta abrir un sitio («sí», «dale», «abre esa»), LLAMA la herramienta de una vez — eso es lo que hace aparecer la tarjeta. Nunca la mandes a buscar una tarjeta vieja ni le digas que su «sí» no basta sin haber llamado nada.
- Los avisos «Aprobé…», «Ya terminé en la página…» y «Ya escribí…» los genera la propia tarjeta: son señales de control, no preguntas. Retoma la pestaña (browser.read_page con el id que traen) y sigue — sin preámbulos y sin comentar qué hay o no hay en la memoria de la empresa.
- Esto es para OPERAR un sitio. Leer una página estática es web.scrape y buscar en internet es web.search.`;

export interface SystemPromptResult {
  /** The composed system prompt, ready to hand to the model. */
  system: string;
  /**
   * The memories that went in. Returned, not just used, because the Google Chat
   * surface has to check the finished answer against them before posting it
   * into a room — see `findMemoryEcho`.
   */
  memories: MemoryContextEntry[];
  /**
   * The rendered memory block, exactly as it was concatenated into `system`.
   *
   * Returned so a caller weighing what the turn cost can measure the real
   * string rather than re-rendering it or subtracting lengths. Empty when the
   * person has no memories.
   */
  memoryBlock: string;
  /**
   * The rendered company block, exactly as it was concatenated into `system`.
   *
   * Returned for the same reason as `memoryBlock`: the chat route weighs the
   * turn from the strings that really went in (`recorder.part`), and a block
   * that is not returned is a block whose length the cost screen would silently
   * fold into somebody else's bar. Empty when the workspace has written no
   * facts.
   */
  companyBlock: string;
}

export interface SystemPromptOptions {
  /** The workspace the turn is happening in. Scopes the memory lookup. */
  organizationId: string;
  userId: string;
  /** The agent's own prompt, live from the `agents` row. */
  basePrompt: string;
  /**
   * Who will read the answer. 'group' adds the do-not-repeat rule for a room
   * with other people in it; it does NOT withhold the memories themselves,
   * because they still have to shape how Cortex behaves in that room.
   */
  audience?: MemoryAudience;
  /** Surface-specific blocks — the Chat surface note, a slash-command directive, retrieved context. */
  sections?: Array<string | null | undefined | false>;
}

export async function buildSystemPrompt(opts: SystemPromptOptions): Promise<SystemPromptResult> {
  const db = getOrgScopedClient(opts.organizationId);

  // A memory lookup that fails is a turn with less context, never a turn that
  // dies — loadMemoryContext already swallows its own errors and returns [].
  // The company facts obey the same contract and are fetched alongside rather
  // than after: they are two independent reads, and making the prompt wait for
  // one and then the other would add a round trip to every turn of every
  // surface for no reason.
  const [memories, facts] = await Promise.all([
    loadMemoryContext(db, opts.userId),
    loadCompanyFactsContext(db),
  ]);

  if (memories.length > 0) {
    // Fire-and-forget: this only feeds eviction ordering ("least recently
    // useful"), and no answer should wait on bookkeeping.
    touchMemories(
      db,
      opts.userId,
      memories.map((m) => m.id),
    );
  }

  const block = renderMemoryBlock(memories, opts.audience ?? 'private');
  const companyBlock = renderCompanyFactsBlock(facts);

  // ORDER MATTERS AND THIS ONE IS ARGUED. The company goes BEFORE the person:
  // the workspace's own rules are the frame, and what one person prefers is a
  // refinement inside it. Read the other way round — personal notes first — the
  // last thing before the surface sections would be one person's preferences,
  // which is not the thing that should be closest to the question on a surface
  // where several people share the same answer.
  //
  // Both blocks are empty strings when there is nothing to say, and the filter
  // below drops them. A workspace that has written no facts pays nothing.
  // The live-tab block goes right after the base prompt — it is an extension of
  // the agent's own instructions, and it is the only other piece here that is
  // identical for every workspace. Being a literal, it cannot break the cache
  // prefix; see the constant's header.
  const system = [
    opts.basePrompt,
    LIVE_BROWSING_BLOCK,
    companyBlock,
    block,
    ...(opts.sections ?? []),
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n\n');

  return { system, memories, memoryBlock: block, companyBlock };
}
