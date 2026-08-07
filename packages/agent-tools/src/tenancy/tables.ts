/**
 * Which workspace every table belongs to — the registry the scoped client reads.
 *
 * WHY A REGISTRY AND NOT A CONVENTION. The risk this whole change exists to
 * close is not "we forget the filter today", it is "somebody adds a query in
 * three months and nobody notices it has no filter". A convention cannot fail;
 * a registry can, and that is the point: `createOrgScopedClient` REFUSES to
 * serve a table that is not listed here. A new table therefore fails on its
 * first query, in development, with a message that says what to do — instead of
 * quietly returning every tenant's rows. `registry.test.ts` moves that failure
 * earlier still, to CI, by scanning the source for `.from('…')` and asserting
 * every name it finds is classified.
 *
 * The three kinds are decisions, not shades of the same thing:
 *
 *   tenant   The table has `organization_id`. Every read is filtered by it and
 *            every write carries it. This is the default and should stay the
 *            default; put a table here unless there is a reason not to.
 *
 *   derived  The table has no `organization_id` and inherits its tenant from a
 *            parent row. Reads and writes must constrain `parentKey`, and the
 *            client throws if they do not — so "forgot the filter" is equally
 *            impossible here, the row set is just reached by a different key.
 *            Reserved for tables that are pure children of a scoped parent and
 *            are never listed on their own (see migration 0064 § 12).
 *
 *   shared   The table is genuinely not tenant data: authentication, OAuth
 *            handshake state, product content. Each one carries the reason in
 *            `why`, because "shared" is the answer that can hide a leak and it
 *            should be uncomfortable to write.
 */

export const ORGANIZATION_COLUMN = 'organization_id';

/** The tenant of a `tenant` row is stated on the row itself. */
interface TenantTable {
  kind: 'tenant';
  /**
   * True only for `dev_task_events`, whose row is written by a webhook before
   * the delivery can be attributed to anything. A null never matches a filter,
   * so those rows are visible to no workspace, which is the correct reading.
   */
  nullable?: boolean;
}

/** The tenant of a `derived` row is its parent's; the parent must be named. */
interface DerivedTable {
  kind: 'derived';
  /** Column that points at the scoped parent. Every query must constrain it. */
  parentKey: string;
  /** The table it inherits from, for the error message. */
  parent: string;
}

/** Not tenant data at all. `why` is mandatory on purpose. */
interface SharedTable {
  kind: 'shared';
  why: string;
}

export type TableTenancy = TenantTable | DerivedTable | SharedTable;

const tenant = (nullable = false): TenantTable => ({ kind: 'tenant', nullable });
const derived = (parent: string, parentKey: string): DerivedTable => ({
  kind: 'derived',
  parent,
  parentKey,
});
const shared = (why: string): SharedTable => ({ kind: 'shared', why });

export const TABLE_TENANCY: Readonly<Record<string, TableTenancy>> = {
  // --- Directory and access -------------------------------------------------
  users: tenant(),
  teams: tenant(),
  team_members: tenant(),
  team_tool_permissions: tenant(),
  agents: tenant(),

  // --- Brain Knowledge ------------------------------------------------------
  kb_collections: tenant(),
  kb_documents: tenant(),
  kb_chunks: derived('kb_documents', 'document_id'),
  // Tenant rather than derived even though most rows name a document: the whole
  // point of the table is "what did THIS workspace spend", which has to be
  // answerable without naming a document, and some rows have none.
  kb_embedding_usage: tenant(),
  gdrive_sync_state: tenant(),
  meeting_imports: tenant(),
  meeting_briefings: tenant(),

  // --- Chat and memory ------------------------------------------------------
  conversations: tenant(),
  messages: tenant(),
  user_memories: tenant(),
  user_preferences: tenant(),
  google_chat_links: tenant(),
  whatsapp_links: tenant(),

  // --- WhatsApp (migration 0068) --------------------------------------------
  // The bridge never touches Postgres itself; it posts to Cortex routes, which
  // write through a scoped handle like everything else. So these are ordinary
  // tenant tables even though the rows originate outside the request cycle.
  whatsapp_sessions: tenant(),
  whatsapp_session_keys: tenant(),
  whatsapp_groups: tenant(),
  whatsapp_messages: tenant(),
  whatsapp_ingest_windows: tenant(),
  whatsapp_group_replies: tenant(),

  // --- Automation -----------------------------------------------------------
  scheduled_jobs: tenant(),
  scheduled_job_runs: tenant(),
  pipelines: tenant(),
  pipeline_runs: tenant(),
  orchestration_runs: tenant(),
  orchestration_tasks: tenant(),
  orchestration_events: derived('orchestration_runs', 'run_id'),

  // --- Integrations and tokens ----------------------------------------------
  integrations: tenant(),
  user_mcp_servers: tenant(),
  user_mcp_tools: derived('user_mcp_servers', 'server_id'),
  // The HTTP tools an organization defined for itself (migration 0067). Tenant
  // data in the strongest sense: the row names a destination inside — or
  // dangerously near — the customer's own systems, and holds the credential
  // used to reach it.
  custom_tools: tenant(),
  mcp_tokens: tenant(),
  mcp_pending_actions: tenant(),

  // --- Oversight ------------------------------------------------------------
  // What one turn actually handed the model (migration 0080), and the
  // per-conversation adjustments to it. Both tenant: a capture quotes the
  // workspace's own corpus, and a setting changes that workspace's assistant.
  turn_contexts: tenant(),
  turn_context_settings: tenant(),
  audit_events: tenant(),
  security_events: tenant(),
  security_policies: tenant(),
  rate_limit_buckets: derived('users', 'user_id'),

  // --- Product surfaces -----------------------------------------------------
  growth_signals: tenant(),
  dev_repositories: tenant(),
  dev_tasks: tenant(),
  dev_task_events: tenant(true),
  vehicles: tenant(),
  vehicle_fines: tenant(),
  vehicle_consults: derived('vehicles', 'vehicle_id'),
  presentation_files: tenant(),

  // --- Commitments (migration 0069) -----------------------------------------
  // Dated promises and the notices already sent about them. Both carry their
  // own organization_id rather than deriving the notice's tenant from its
  // commitment: the daily watcher scans notices by workspace and date without
  // naming a commitment, which a `derived` classification would (correctly)
  // refuse.
  commitments: tenant(),
  commitment_notices: tenant(),

  // --- Reports (migration 0079) ---------------------------------------------
  // Saved informes: the resolved document, not the query behind it. Tenant in
  // the strongest sense — a row holds an aggregate OF a workspace's data, so a
  // missing filter would not leak a visible row, it would silently move one
  // company's totals into another's report. The share link reads this table by
  // token through the service client, outside the scoped handle, because a link
  // clicked from WhatsApp carries no session to scope by.
  reports: tenant(),

  // --- Proposed actions (migration 0077) ------------------------------------
  // Drafted emails waiting on a human, and the record of every human edit to
  // one. Tenant on both: an action holds a client's address and the text that
  // will be sent over an employee's own signature, and the revisions hold both
  // sides of every rewrite. `action_revisions` carries its own organization_id
  // rather than deriving it from the action, because the interesting question
  // ("what does this workspace keep rewriting?") is asked across actions
  // without naming one — which a `derived` classification would refuse.
  actions: tenant(),
  action_revisions: tenant(),

  // --- Microsoft 365 (migration 0078) ---------------------------------------
  // The ledger of Outlook threads folded into Brain Knowledge: what was
  // archived, which document it became, and which client it belongs to. Tenant
  // in the strongest sense — the row names a client's correspondence.
  microsoft_mail_ingests: tenant(),

  // --- Clients (migration 0075) ---------------------------------------------
  // The customer companies everything else hangs off, and the three tables that
  // attach things to them. Tenant on all four: a client row IS the customer
  // list, `client_domains` says which mail belongs to whom, `client_contacts`
  // holds outsiders' names and addresses, and `client_links` names, one by one,
  // the documents and threads a workspace has decided are about a customer.
  // None of them is derivable from a parent — the review list reads
  // `client_links` across every client, and the search reads `client_domains`
  // by domain alone, both of which a `derived` classification would refuse.
  clients: tenant(),
  client_domains: tenant(),
  client_contacts: tenant(),
  client_links: tenant(),

  // --- Document extraction (migration 0076) ---------------------------------
  // What was read out of each document, field by field, with the sentence each
  // value came from, plus the log of what humans corrected. Tenant on all three
  // rather than deriving the fields from their extraction: the review screen
  // counts what is pending across every document at once, and the corrections
  // are grouped by (document type, field) across the whole workspace to find
  // where the extractor is wrong — both are questions asked without naming a
  // parent row, which a `derived` classification would correctly refuse.
  document_extractions: tenant(),
  document_fields: tenant(),
  document_field_corrections: tenant(),

  // --- Not tenant data ------------------------------------------------------
  ba_user: shared(
    'Identity. One row per human across every workspace they belong to; the per-workspace directory row is public.users.',
  ),
  ba_session: shared(
    'Identity. Sessions belong to a person, and name the workspace they are acting in.',
  ),
  ba_account: shared('Identity. The SSO provider link for a person.'),
  ba_verification: shared('Identity. Short-lived verification tokens.'),
  ba_two_factor: shared('Identity. TOTP secrets belong to a person, not a workspace.'),
  ba_organization: shared(
    'The workspaces themselves. Scoping this by workspace would be circular.',
  ),
  ba_member: shared('Which people belong to which workspace. This table IS the tenancy graph.'),
  ba_invitation: shared(
    'Pending invitations. Carries its own organizationId and is only ever read through better-auth, which checks the inviter belongs to it.',
  ),
  oauth_clients: shared(
    'Registered MCP OAuth clients. Client registration is install-wide and holds no tenant data.',
  ),
  oauth_authorization_codes: shared(
    'Single-use handshake state keyed by a hash. Carries a user_id, and the workspace is resolved from that directory row the moment the code is exchanged.',
  ),
  oauth_access_tokens: shared(
    'Bearer tokens keyed by a hash. Same as the codes: the workspace comes from the user_id the token resolves to.',
  ),
  oauth_refresh_tokens: shared('Bearer tokens keyed by a hash. See oauth_access_tokens.'),
  tool_embeddings: shared(
    "Embeddings of the product's own tool descriptions, keyed by tool id. Product content, identical for every workspace; which tools a person may call is decided before ranking.",
  ),
};

export class UnclassifiedTableError extends Error {
  constructor(table: string) {
    super(
      `Table "${table}" has no tenancy classification. Add it to TABLE_TENANCY in packages/agent-tools/src/tenancy/tables.ts: \`tenant()\` if it holds business data (and give it an organization_id column in a migration), \`derived(parent, key)\` if it is a child of a scoped table, or \`shared(why)\` if it genuinely is not tenant data.`,
    );
    this.name = 'UnclassifiedTableError';
  }
}

export function tenancyOf(table: string): TableTenancy {
  const entry = TABLE_TENANCY[table];
  if (!entry) throw new UnclassifiedTableError(table);
  return entry;
}

/**
 * Database functions, and what the scoped client does about them.
 *
 * Same posture as the tables: an unlisted function is refused rather than
 * forwarded, so a new RPC has to state whether it needs a tenant.
 *
 *   organization  The function takes `p_organization_id`; the client fills it in
 *                 so no caller can pass the wrong one (or forget it).
 *   person        The function takes `p_user_id` and derives everything from it.
 *                 Since migration 0064 a directory row belongs to exactly one
 *                 workspace, so the person already names the tenant — this is
 *                 the shape `kb_visible_space_ids` and the memory functions use,
 *                 and it is the safest of the three because there is no tenant
 *                 argument to get wrong.
 *   maintenance   Install-wide machinery that touches no tenant-visible data.
 */
export type RpcTenancy = 'organization' | 'person' | 'maintenance';

export const RPC_TENANCY: Readonly<Record<string, RpcTenancy>> = {
  kb_visible_space_ids: 'person',
  kb_search_scoped: 'person',
  kb_brain_graph: 'person',
  kb_conflict_candidates: 'person',
  // Migration 0073. Both derive the visible spaces from p_user_id, exactly like
  // the search does — `kb_note_retrieval` is the only write in this surface
  // that takes raw chunk ids from a caller, and it re-derives every one of them
  // from that visible set rather than trusting the list it was handed.
  kb_fragment_health: 'person',
  kb_note_retrieval: 'person',
  user_memory_context: 'person',
  user_memory_list: 'person',
  user_memory_remember: 'person',
  user_memory_forget: 'person',
  user_memory_set_status: 'person',
  user_memory_touch: 'person',
  consume_rate_limit_token: 'person',
  provision_organization_agents: 'organization',
  kb_mark_reindexed_documents: 'maintenance',
  // Migration 0080. The retention sweep for captured turn contexts: strips
  // quoted material past its detail window, deletes rows past their purge date.
  // Takes no workspace and returns two counts — there is no session behind the
  // cron that calls it, and nothing tenant-visible comes back.
  turn_context_purge: 'maintenance',
};

export class UnclassifiedFunctionError extends Error {
  constructor(fn: string) {
    super(
      `Database function "${fn}" has no tenancy classification. Add it to RPC_TENANCY in packages/agent-tools/src/tenancy/tables.ts and say how it is scoped: 'person' (takes p_user_id, which names the workspace), 'organization' (takes p_organization_id, which the scoped client fills in), or 'maintenance' (touches no tenant-visible data).`,
    );
    this.name = 'UnclassifiedFunctionError';
  }
}

export function rpcTenancyOf(fn: string): RpcTenancy {
  const entry = RPC_TENANCY[fn];
  if (!entry) throw new UnclassifiedFunctionError(fn);
  return entry;
}

/**
 * Workspace ids that exist for the system's own bookkeeping and can never be a
 * customer's. Neither has rows in `ba_member`, so no session can select them;
 * they are listed here so code that enumerates workspaces can skip them and so
 * the names are greppable from TypeScript. See migration 0064 §§ 1 and 4.
 */
export const TEMPLATE_ORGANIZATION_ID = 'cortex-template';
export const QUARANTINE_ORGANIZATION_ID = 'cortex-quarantine';
