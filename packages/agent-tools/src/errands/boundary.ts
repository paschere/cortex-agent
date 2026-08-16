/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE LINE THIS ENGINE DOES NOT CROSS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Consígueme vuelos" is two requests wearing one sentence.
 *
 *   FIND AND PROPOSE — search the routes, compare the fares, lay out the
 *   trade-offs, hand a person the three options with their sources.
 *
 *   BOOK AND PAY — hold the seat, charge the card, sign the terms, send the
 *   confirmation to somebody outside the company.
 *
 * THIS ENGINE DOES THE FIRST AND NEVER THE SECOND. An errand searches,
 * compares and proposes. It does not buy, does not book, does not sign, does
 * not file, and does not send anything to a third party on its own account.
 *
 * That is not caution about model quality, and it does not get relaxed as the
 * models get better. An autonomous agent holding a company card is a legal
 * problem before it is a technical one: there is no consent, no audit of who
 * decided, nobody who can say what they agreed to, and no way to unwind it.
 * Cortex is sold on the opposite promise — that everything leaving the
 * building was seen and approved by a person — and a single errand that books
 * a flight by itself falsifies that promise for every customer at once.
 *
 * ── HOW THE PROMISE IS KEPT, MECHANICALLY ─────────────────────────────────
 *
 * Not by prompting. A system prompt that says "never send anything" is a
 * request, and the whole point of an unattended run is that nobody is there to
 * notice it was declined. The promise is kept by never handing the sub-agents
 * a tool that can send:
 *
 *   1. `ERRAND_TOOLS` below is an EXPLICIT ALLOW-LIST OF EXACT TOOL IDS. It is
 *      threaded into the orchestrator as `RunOptions.toolAllowlist`, and
 *      `openCatalogue` intersects it with the agent's grants and the team
 *      deny-list. A sub-agent in an errand is never offered anything else.
 *
 *   2. There are NO WILDCARDS in that list, and that is the load-bearing
 *      detail. `'gmail.*'` would have quietly absorbed `gmail.send_message`
 *      the day it was added. Every id is written out, so widening the surface
 *      is a diff somebody has to defend rather than a side effect of adding a
 *      tool to a family that already looked safe.
 *
 *   3. `assertProposalOnly` is called at launch, before the run row is even
 *      written. It refuses on anything outside the list, so a future caller
 *      that assembles its own toolset cannot route around the list by not
 *      using it.
 *
 *   4. Below all of that, the machinery that was already there still holds:
 *      an errand's runs execute with `surface: 'schedule'`, which the security
 *      layer reads as "unattended". Anything with an external blast radius is
 *      classified critical and blocked, and `requiresConfirmation` tools raise
 *      `ConfirmationRequiredError`, which the executor turns into a skip.
 *      Four layers, because they fail differently.
 *
 * ── WHAT HAPPENS WHEN AN ERRAND CONCLUDES SOMETHING SHOULD BE SENT ────────
 *
 * It says so in its deliverable, and stops. It does not send it, and it does
 * not stage it for approval behind the person's back either — a proposal
 * nobody asked for is still a queue somebody has to clear. The person reads
 * the finding and decides; if they want it sent, the existing surfaces do
 * that, and both of them bind execution to what was actually approved:
 *
 *   /approvals  a tool call waiting on a yes            (mcp_pending_actions, 0033)
 *   /actions    a message waiting on one, hash-bound    (actions, 0077)
 *
 * `actions` is the model to copy if an errand ever needs an outbound side:
 * `content_hash` over the canonicalised payload, checked again in
 * `assertExecutable` at the moment of execution, so what runs is byte-identical
 * to what a person read and approved. Anything less is an approval in name.
 *
 * ── WHERE THE TAUGHT BROWSER WILL PLUG IN, AND WHY IT IS NOT HERE YET ─────
 *
 * `browser.run_flow` (migration 0087, services/browser) replays an errand a
 * person performed once — log into the portal, fill the form, come back with
 * the certificate. It is the single biggest thing missing from this list, and
 * it is deliberately absent for now:
 *
 *   * it belongs to another workstream that is still building it, and this
 *     module must not depend on its shape;
 *   * a taught flow is not automatically read-only. "Sácame el certificado" is
 *     fine; the same mechanism can just as easily submit a declaration or
 *     accept terms. Admitting the whole family here would put the line back in
 *     the hands of whoever recorded the flow.
 *
 * When it lands, the correct move is NOT to add `'browser.run_flow'` to
 * `ERRAND_TOOLS`. It is to admit individual flows that are marked read-only at
 * the flow level, granted to this workspace, and named one by one — the same
 * exact-ids-only rule this file already applies to tools, one level down.
 */

/** Thrown when something tries to give an errand a tool that can act outward. */
export class OutboundToolRefused extends Error {
  /** Screen text, Colombian Spanish — this can reach a person. */
  readonly spanish: string;

  constructor(readonly toolIds: string[]) {
    super(`Errands may not use outbound tools: ${toolIds.join(', ')}`);
    this.name = 'OutboundToolRefused';
    this.spanish =
      'Un encargo busca, compara y propone: no compra, no reserva, no firma y no manda nada por ' +
      'su cuenta. Lo que salga hacia afuera pasa por Aprobaciones o por Acciones, donde una ' +
      'persona lo ve antes de que ocurra.';
  }
}

/**
 * Every tool an errand's sub-agents may call. Exact ids only — see point 2 in
 * the header. Each entry reads, and only reads.
 *
 * Sorted by family for review. If you are adding one, the question to answer
 * in the commit message is not "is this useful" but "can this change anything
 * outside Cortex, or spend money, or tell a third party we exist".
 */
export const ERRAND_TOOLS: readonly string[] = [
  // The open internet. The engine of a research errand.
  'web.search',
  'web.scrape',

  // What the company already knows.
  'kb.search',
  'kb.context',
  'kb.list_spaces',

  // Who the company works with. Read paths only: `clients.register` and
  // `clients.link` write, so they are not here.
  'clients.search',
  'clients.overview',

  // Paperwork already extracted and confirmed by a person.
  'documents.records',
  'documents.totals',
  'commitments.due_soon',

  // Mail, reading only. Every send/draft/archive id in both families is
  // deliberately absent: `gmail.draft` looks harmless and is not — a draft in
  // somebody's mailbox is a thing they did not put there.
  'gmail.search',
  'gmail.list_threads',
  'gmail.read_thread',
  'outlook.search',
  'outlook.list_threads',
  'outlook.read_thread',

  // Files and meetings the workspace already has.
  'gdrive.search_files',
  'gdrive.read_doc',
  'gsheets.read_range',
  'meetings.list_transcripts',
  'meetings.get_transcript',
  'people.search',

  // Calendars, read-only. `gcal.create_event` and `mscal.create_event` put
  // something on somebody else's day, which is an outbound act.
  'gcal.list_events',
  'gcal.upcoming_meetings',
  'mscal.list_events',

  // CRM and trackers, read-only. Every create/update/log id is absent.
  'hubspot.search_companies',
  'hubspot.search_contacts',
  'hubspot.search_deals',
  'hubspot.get_company',
  'hubspot.get_contact',
  'hubspot.get_deal',
  'hubspot.get_pipeline_summary',
  'hubspot.get_contact_timeline',
  'hubspot.list_recent_activities',
  'linear.list_teams',
  'linear.list_projects',
  'linear.list_issues',
  'linear.get_issue',
  'linear.get_project',
  'linear.list_comments',
  'linear.cycle_stats',
  'linear.workload_stats',
  'github.list_repositories',
  'github.get_repository',
  'github.get_repo_contents',
  'github.get_issue',
  'github.list_issue_comments',
  'github.list_pull_requests',
  'github.pr_metrics',
  'github.repo_activity',

  // Reports the workspace has already generated. `reports.generate` is absent
  // for cost rather than for safety — it is a fresh pass over the whole
  // commitments table, and an errand's ceiling should not be spent that way
  // without somebody asking for it. `reports.share` mints a public link, which
  // is an outbound act by any reading.
  //
  // `reports.compose`, `reports.run` y `reports.recipes` tampoco están, y por
  // las dos razones a la vez: correr una receta son hasta seis pasadas sobre la
  // base en vez de una, y componer una escribe una fila que después aparece en
  // el estante de /reports como si alguien la hubiera pedido. Un recado que
  // deja informes detrás no es un recado de sólo lectura.
  'reports.list',
  'reports.open',

  // Fleet, read-only. `vehicles.check_runt` and `vehicles.check_simit` are
  // reads too, but they are BILLED PER CONSULT against an external scraper, so
  // an unattended loop over a fleet is a real invoice. Left out on cost
  // grounds; if an errand ever needs them, they need their own sub-ceiling.
  'vehicles.list',
  'vehicles.get',
];

const ALLOWED = new Set(ERRAND_TOOLS);

/** Is this tool id one an errand may be handed? */
export function isErrandTool(toolId: string): boolean {
  return ALLOWED.has(toolId);
}

/**
 * The gate. Refuses the whole set if any member of it can act outward.
 *
 * All-or-nothing rather than silently filtering: a caller that asked for a
 * sending tool has misunderstood what an errand is, and quietly dropping it
 * would let that misunderstanding ship and surface later as "why didn't it
 * send the email".
 */
export function assertProposalOnly(toolIds: readonly string[]): void {
  const refused = [...new Set(toolIds)].filter((id) => !ALLOWED.has(id));
  if (refused.length > 0) throw new OutboundToolRefused(refused);
}

/**
 * The allow-list as the orchestrator wants it. A copy, so a caller cannot
 * mutate the constant and widen the line for the rest of the process.
 */
export function errandToolAllowlist(): string[] {
  return [...ERRAND_TOOLS];
}

/**
 * Verbs that mean "this tool changes something outside Cortex".
 *
 * Used by the test that guards this file, not at run time — the allow-list is
 * the run-time mechanism. Kept here so the rule and the list live in the same
 * place, and so a diff that widens one is read next to the other.
 *
 * Matched as a WHOLE VERB or a leading verb segment (`send` matches
 * `send_message` but not `sender`), because the loose form would flag
 * `documents.records` for containing `record` — and a guard that cries wolf on
 * a read tool is a guard somebody eventually deletes.
 */
export const OUTBOUND_VERBS: readonly string[] = [
  'send',
  'post',
  'create',
  'update',
  'draft',
  'submit',
  'append',
  'register',
  'archive',
  'share',
  'run',
  'propose',
  'log',
  'confirm',
  'reject',
  'import',
  'schedule',
  'forget',
  'remember',
  'link',
  'mark',
  'record',
  'finish',
  'pick',
  'extract',
];

/** Does this tool id read as something that acts outward? See `OUTBOUND_VERBS`. */
export function readsAsOutbound(toolId: string): boolean {
  const verb = toolId.split('.')[1] ?? '';
  return OUTBOUND_VERBS.some((bad) => verb === bad || verb.startsWith(`${bad}_`));
}

/** The sentence the screen shows wherever an errand's limits are stated. */
export const ERRAND_BOUNDARY_NOTICE =
  'Un encargo busca, compara y te propone. Nunca compra, ni reserva, ni firma, ni le manda nada ' +
  'a un tercero por su cuenta: eso pasa siempre por Aprobaciones o por Acciones, donde tú lo ves ' +
  'antes de que ocurra.';
