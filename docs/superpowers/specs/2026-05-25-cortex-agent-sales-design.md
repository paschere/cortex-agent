# Cortex Agent — Design Spec (Sales v1)

**Date:** 2026-05-25
**Status:** Draft for review
**Owner:** Platform team

---

## 1. Summary

`cortex-agent` is an internal AI agent platform for a LATAM staffing company. It exposes one or more specialized agents (Sales first; HR / Recruiter to follow) accessible from multiple surfaces — Claude Desktop via an MCP connector, a native desktop app, and (later) a company-branded web app — all backed by a shared core: a tool layer, a 3-tier RAG knowledge base, agent definitions, and integrations to HubSpot, Google Workspace, and the existing Rate Estimator.

The MVP ships the **Sales agent** for 5 pilot users over ~6–8 weeks. Day-one job-to-be-done: prospect → pull HubSpot context → confirm roles → call the Rate Estimator → draft a proposal email in Gmail.

## 2. Goals and non-goals

### Goals

- One internal agent platform with a single shared tool layer that powers multiple agents and multiple surfaces.
- A working Sales agent that demonstrably saves time on proposals (target: ~30 min → ~5 min).
- A 3-tier KB (global, team/per-agent, per-user) with optional **per-conversation ephemeral KB**, configurable via an admin UI.
- Surfaces day one: Claude Desktop (MCP) and a Tauri desktop app.
- Architecture that scales cleanly to future agents (HR, Recruiters) without re-platforming.

### Non-goals (v2+)

- Proactive alerts / event watchers
- HubSpot write tools
- Voice I/O, Slack/Teams surfaces, mobile app
- Standalone branded web app (chat lives in `apps/web` already; standalone is a later branding/auth choice)
- HR / Recruiter agents (architecture supports them; not shipped in v1)
- Multi-language UI (agent replies in user's language naturally)

## 3. Users and success criteria

- **Primary users:** 5 salespeople
- **Auth domain:** restricted to the company's own Google Workspace domain via Supabase Auth

### MVP success metrics (instrumented from day one)

- Weekly active users / 5 pilot users
- Proposals drafted via `sales.draft_proposal` per week
- Time from "open chat" → "draft visible in Gmail" (target < 5 min; baseline ~30 min)
- Tool error rate per tool
- Gemini cost per user per week

## 4. Architecture overview

**Pattern:** _Shared Tools Library + Two Brains._

- **Tools** (HubSpot, Rate Estimator, Gmail, Google Calendar, Google Sheets, KB search/index) live in **one shared package**, used by both the backend agent and the MCP server.
- **Claude surface:** Claude itself is the brain via the MCP connector. The MCP server exposes the shared tools.
- **Desktop / future web surface:** the backend runs an agent loop with **Gemini 2.5 Flash** (Pro for heavier reasoning), calling the same tools.
- **Admin UI + chat backend** ship as one Next.js app on Vercel.
- **MCP server** is a separate, edge-deployed package (Cloudflare Workers).
- **Desktop** is a thin Tauri shell that loads the chat UI from the Next.js app.

```
┌─────────────────┐       ┌──────────────────────┐
│ Claude Desktop  │──MCP──│  cortex-mcp-server   │
│ / Claude.ai     │       │  (Cloudflare Worker) │
└─────────────────┘       └──────────┬───────────┘
                                     │
                          ┌──────────▼───────────┐
                          │  @cortex/agent-tools │   ← shared package
                          │  hubspot · rate ·    │
                          │  gmail · gcal ·      │
                          │  gsheets · kb        │
                          └──────────▲───────────┘
                                     │
┌─────────────────┐       ┌──────────┴───────────┐       ┌──────────────┐
│ Desktop (Tauri) │──API──│  Next.js on Vercel   │──────▶│  Supabase    │
│ chat UI         │       │  • Admin UI          │       │  • Auth(SSO) │
└─────────────────┘       │  • Chat API          │       │  • Postgres  │
                          │  • Agent loop(Gemini)│       │  • pgvector  │
                          │  • Tool impls        │       │  • Storage   │
                          └──────────────────────┘       └──────────────┘
```

## 5. Repository layout

Monorepo: **pnpm workspaces + Turborepo**.

```
cortex-agent/
├── apps/
│   ├── web/                    # Next.js on Vercel: admin UI + chat UI + API + agent loop
│   │   ├── (app)/              # Admin: agents, KB, integrations, users, MCP tokens, audit, usage
│   │   ├── (chat)/             # Chat UI (also loaded by the desktop app)
│   │   └── api/
│   │       ├── chat/           # Streaming chat endpoint (Gemini agent loop)
│   │       ├── kb/             # KB upload, search, manage
│   │       ├── integrations/   # OAuth callbacks (HubSpot, Google)
│   │       └── admin/          # Admin CRUD
│   ├── mcp/                    # Cloudflare Worker, exposes shared tools to Claude
│   └── desktop/                # Tauri shell wrapping the chat UI
├── packages/
│   ├── tools/                  # @cortex/agent-tools — shared tool layer
│   ├── agents/                 # @cortex/agents — agent definitions
│   ├── core/                   # @cortex/core — types, auth helpers, db client
│   └── ui/                     # @cortex/ui — shared React components
├── infra/
│   └── supabase/               # SQL migrations
└── turbo.json
```

**Rate Estimator integration:** add one internal endpoint (`POST /api/internal/estimate`, service-token authed) to the existing `rate-estimator` repo. The estimator's UI is untouched.

## 6. Data model

Postgres (Supabase) with `pgvector`. Row-Level Security enforced in Postgres, not application code.

```sql
users               (id, email, name, role, google_sub, created_at)
teams               (id, name)               -- "Sales", "HR", "Recruiters"
team_members        (team_id, user_id, role) -- member | admin

agents              (id, slug, name, team_id, system_prompt, default_model,
                     allowed_tool_ids[], created_at)

kb_collections      (id, scope, scope_id, name, agent_id NULL,
                     gdrive_folder_id NULL, created_at)
                    -- scope: 'global' | 'team' | 'user' | 'conversation'
                    -- scope_id: NULL for global, else team_id | user_id | conversation_id
                    -- agent_id: optional binding to a specific agent

kb_documents        (id, collection_id, source, title, mime, sha256,
                     uploaded_by, status, created_at)
                    -- source: 'upload' | 'gdrive' | 'url'

kb_chunks           (id, document_id, chunk_index, content,
                     embedding vector(768), tokens, metadata jsonb)
                    -- 768 dims = Gemini text-embedding-004

gdrive_sync_state   (collection_id, page_token, last_synced_at)

integrations        (id, user_id, provider, access_token_enc,
                     refresh_token_enc, scopes[], expires_at)
                    -- provider: 'google' | 'hubspot' (BOTH per-user)

conversations       (id, user_id, agent_id, surface, title, created_at)
                    -- surface: 'web' | 'desktop' | 'mcp'
messages            (id, conversation_id, role, content,
                     tool_calls jsonb, tool_results jsonb, created_at)

audit_events        (id, user_id, agent_id, tool_id, input_hash, status,
                     latency_ms, metadata jsonb, created_at)
                    -- metadata includes token usage / cost
```

### RLS rules (summary)

- `kb_collections` visible if `scope='global'` OR `scope='team' AND user IN team_members(scope_id)` OR `scope='user' AND scope_id=auth.uid()` OR `scope='conversation' AND scope_id IN user's conversations`.
- `conversations` / `messages` visible only to their owner.
- `integrations.access_token_enc` never returned to client; tools read via service role.

## 7. RAG retrieval

At query time:

1. Resolve visible collections for `{user, agent, conversationId?}`.
2. Filter to collections with `agent_id = current` OR `agent_id IS NULL`.
3. Hybrid search: pgvector cosine + Postgres full-text on `content`.
4. Re-rank top 20 → take top 5 chunks.
5. Inject into prompt as `<context>` with citations (doc title + chunk_index).

### Ingestion pipeline

```
Upload (PDF | DOCX | TXT | MD | URL)
  → parse (pdf-parse, mammoth — reused from rate-estimator)
  → semantic chunk (~500 tokens, ~80 overlap)
  → embed with Gemini text-embedding-004
  → insert into kb_chunks
  → mark kb_documents.status = 'ready'
```

### Google Drive sync

- Per-collection `gdrive_folder_id` (set via Google Picker in admin UI).
- Background job (Vercel Cron, every 10 min; later: Drive push notifications) lists changed files since `page_token`, ingests new/updated, deletes chunks for removed files, persists new `page_token`.
- Scope required: `drive.readonly`.
- Caps: 500 docs per collection, 10 MB per file (warning surfaced in UI).

## 8. Tool layer (`@cortex/agent-tools`)

Single interface for every tool, consumed by both the backend agent and the MCP server.

```ts
export interface Tool<Input, Output> {
  id: string;
  description: string;
  inputSchema: z.ZodSchema<Input>;
  outputSchema: z.ZodSchema<Output>;
  scopes?: string[];
  rateLimit?: { perMinute: number };
  handler: (input: Input, ctx: ToolContext) => Promise<Output>;
}

export interface ToolContext {
  userId: string;
  agentId: string;
  conversationId?: string;
  db: SupabaseClient;
  integrations: IntegrationsClient; // resolves per-user OAuth tokens
  logger: Logger;
}
```

### MVP tool inventory

**HubSpot (read-only, per-user OAuth):**

- `hubspot.search_companies({ query, limit })`
- `hubspot.get_company({ id })`
- `hubspot.search_deals({ filters })`
- `hubspot.get_deal({ id })`
- `hubspot.list_recent_activities({ companyId, days })`

**Rate Estimator:**

- `rate.estimate({ role, seniority, techStack, country?, hours? })`
- `rate.estimate_from_document({ fileRef })`

**Google Workspace (per-user OAuth):**

- `gmail.search({ query, max })`
- `gmail.read_thread({ threadId })`
- `gmail.draft({ to, subject, body, inReplyTo? })`
- `gcal.list_events({ timeMin, timeMax })`
- `gcal.create_event({ title, attendees, start, end, description })` **← confirmation required**
- `gsheets.read_range({ spreadsheetId, range })`
- `gsheets.append_row({ spreadsheetId, range, values })` **← confirmation required**

**KB:**

- `kb.search({ query, scopes?, limit })`
- `kb.list_collections()`

**Composite:**

- `sales.draft_proposal({ companyId, roles[], notes? })` — orchestrates HubSpot + rate + KB lookups and produces a structured proposal (JSON + Markdown). Primitives remain available for narrower asks.

### Safety rails

- **Confirmation required** only for the "dangerous" writes: `gcal.create_event` and `gsheets.append_row`. `gmail.draft` is already a draft and runs without confirmation. Reads run freely.
- **Per-user scope:** every tool resolves OAuth tokens from `integrations` for the calling user.
- **Audit log:** every tool call writes an `audit_events` row (input hash, status, latency, token usage).
- **Rate limits:** per-tool, per-user (e.g., `gmail.search` 30/min).

## 9. Agent definitions (`@cortex/agents`)

Each agent is a plain config:

```ts
export const salesAgent: AgentDefinition = {
  id: "sales",
  name: "Cortex Sales",
  team: "sales",
  defaultModel: "gemini-3.1-flash-lite",
  systemPrompt: `You are Cortex's Sales co-pilot...`,
  allowedTools: [
    "hubspot.*",
    "rate.*",
    "gmail.*",
    "gcal.*",
    "gsheets.read_range",
    "kb.*",
    "sales.draft_proposal",
  ],
  kbScopes: ["global", "team:sales", "user"],
  greeting: "¡Hola! Soy tu Sales co-pilot. ¿En qué cliente trabajamos hoy?",
};
```

Future HR / Recruiter agents drop in by adding a new file under `packages/agents/<slug>/`.

## 10. Backend agent loop

Vercel AI SDK with Gemini, streaming, multi-turn tool use:

```
POST /api/chat
  body: { agentId, conversationId, message, attachments? }
  → resolve user from session
  → load agent definition + KB scopes
  → load conversation history
  → prepend RAG context (kb.search top 5 on the current message)
  → streamText({
       model: google('gemini-3.1-flash-lite'),
       system: agent.systemPrompt,
       messages,
       tools: filterTools(agent.allowedTools, ctx),
       maxSteps: 8,
       onStepFinish: writeAuditEvent
     })
  → stream tokens + tool_calls back to client (SSE)
```

Behaviors:

- Tool execution server-side; client never sees credentials.
- Confirmation: destructive tools emit `requires_confirmation`; client surfaces Allow/Cancel; `/api/chat/confirm` resumes.
- Step cap: 8 tool-call rounds per turn.
- Per-turn auto-persistence into `messages` and `audit_events`.

## 11. MCP surface (`apps/mcp`)

Cloudflare Worker exposing the shared tools to Claude.

- **Auth:** per-user bearer token issued from the admin UI (one-shot reveal, revocable, last-used timestamp).
- **Resources:** `kb://collections/{id}`, `conversations://...`
- **Prompts:** pre-canned starters ("Use Sales mode", "Draft proposal for…").
- **Install flow:** user generates token in admin UI → copies JSON snippet into Claude Desktop's MCP config → tools appear in Claude.
- **Brain:** Claude itself orchestrates; the MCP server does not run a Gemini loop.

## 12. Desktop app (`apps/desktop`)

- **Stack:** Tauri (smaller binary, native shell).
- **Chat UI:** loaded from `apps/web/(chat)` — one chat UI codebase.
- **Native niceties:** system tray, global hotkey (`Ctrl+Shift+Z`), native notifications (groundwork for v2 alerts).
- **Auth:** launches OS browser for Google SSO → deep-links back to the app with a session token.
- **Updates:** Tauri updater + signed builds; release via GitHub Releases.

## 13. Authentication and OAuth

### SSO (login)

- Supabase Auth with Google provider, restricted to the company's own domain (Workspace `hd` claim).
- First login creates a `users` row and assigns to a default team (admin-editable).
- Roles: `member`, `team_admin`, `org_admin`.

### Per-user integration OAuth (separate from SSO)

- Granted from the admin UI's `/integrations` page; incremental scope grants per tool family.
- Google scopes (granted as needed):
  - `gmail.readonly`, `gmail.compose` (draft only)
  - `drive.readonly`
  - `calendar.events`
  - `spreadsheets`
- **HubSpot: per-user OAuth.** Each salesperson connects their own HubSpot user. (Read-only for MVP.)
- Tokens encrypted with Supabase Vault; tools decrypt via service-role on demand.

## 14. Admin UI (`apps/web/(app)`)

```
/                    Dashboard: my agents, recent conversations
/agents              List + per-agent config (org_admin to edit)
/agents/[slug]       System prompt, model, allowed tools, KB scopes

/kb
  /kb/global         org_admin only
  /kb/team/[teamId]  team_admin edits, members view
  /kb/me             personal KB
    Per collection:
      - Upload files (drag/drop: PDF, DOCX, TXT, MD)
      - Connect Drive folder (Google Picker → folder ID, "Sync now" + auto every 10 min)
      - Document list with status (ingesting | ready | failed), reindex, delete
      - Test search box (preview RAG output for a query)

/integrations        Connect Google Workspace + HubSpot (per-user)
/mcp                 Generate / revoke personal MCP token + copy Claude Desktop config snippet
/conversations       Read-only audit trail across surfaces (web | desktop | mcp), resume into chat

/admin               (org_admin only)
  /admin/users       List, roles, deactivate
  /admin/teams       CRUD teams + members
  /admin/audit       Filterable audit_events (tool, user, status, latency)
  /admin/usage       Token usage and Gemini cost per agent / per user
```

## 15. Chat UI (`apps/web/(chat)`)

```
/chat                  New conversation (agent picker; Sales default in v1)
/chat/[conversationId] Resume
```

Components:

- Streaming message list with markdown + code blocks.
- Inline tool-call cards ("Searching HubSpot…") expandable to show input/output.
- Confirmation prompts for `gcal.create_event` / `gsheets.append_row` inline (Allow / Cancel).
- KB source citations (footnote-style with hover preview).
- File drop in the input bar → ingested as a **conversation-scoped KB collection** (`scope='conversation'`, cascades on delete).
- "Refine" button on draft outputs.

**Stack:** shadcn/ui + Tailwind, Framer Motion, TanStack Query, SSE/EventSource.

## 16. Day-one Sales flow (concrete walkthrough)

Salesperson in Claude Desktop: _"Acme Corp is asking for 2 Senior React devs and 1 SRE. Draft me a proposal."_

```
1. Claude (with cortex-mcp connected) calls sales.draft_proposal.
2. Composite tool:
   a. hubspot.search_companies("Acme Corp") → company id
   b. hubspot.get_company(id) → industry, size, owner, past deals
   c. hubspot.list_recent_activities(companyId, days=30) → last 5 notes/calls
   d. rate.estimate per role:
        - 2× Senior React, LATAM   → $45–60/hr, monthly $7.2k–9.6k
        - 1× SRE, LATAM            → $50–65/hr, monthly $8k–10.4k
   e. kb.search("React proposal Acme similar", scopes=[team:sales]) → 2 past proposals
   f. Composes structured draft: company, contact, roles[], pricing, timeline, terms, similar_cases (+ Markdown rendering)
3. Claude shows the draft inline; user edits in chat.
4. User: "great, email this to María at Acme":
   → gmail.draft({ to: 'maria@acme.com', subject, body })  (no confirmation: draft only)
   → Appears in user's Gmail Drafts.
5. audit_events captures every step (tool, latency, status, token usage).
```

Same flow runs in the desktop app, where Gemini 2.5 Flash drives the loop server-side.

## 17. Deployments

| Component                               | Host                    | Notes                                    |
| --------------------------------------- | ----------------------- | ---------------------------------------- |
| `apps/web`                              | Vercel                  | Prod + Preview per PR                    |
| `apps/mcp`                              | Cloudflare Workers      | Edge-deployed                            |
| `apps/desktop`                          | GitHub Releases         | Tauri updater + signed builds            |
| Postgres / pgvector / Auth / Storage    | Supabase                | One project, RLS on                      |
| Rate Estimator endpoint                 | Existing Vercel project | One new endpoint                         |
| Background jobs (KB ingest, Drive sync) | Vercel Cron + Inngest   | Inngest chosen for retries/observability |

**Environments:** `dev` (local + Supabase branch), `staging` (Vercel preview + staging Supabase project), `prod`.

**Secrets:** Vercel/Cloudflare env vars + Supabase Vault. No `.env` in repo.

## 18. CI / CD

- GitHub Actions on PR: lint, typecheck, unit tests, build all apps.
- Turborepo remote cache (Vercel) for fast CI.
- Vercel previews for `apps/web`; Wrangler previews for `apps/mcp`.
- Desktop builds run on `main` push (macOS + Windows matrix; Linux as needed).
- DB migrations via `supabase db push` to staging on `main`; manual promotion to prod.

## 19. Observability

- **Logs:** Vercel + Cloudflare native; Supabase logs for DB.
- **Tracing:** OpenTelemetry → Axiom (or Vercel Observability); a span per tool call.
- **Errors:** Sentry on web, mcp, desktop.
- **Audit:** `/admin/audit` from `audit_events`.
- **Cost:** `/admin/usage` aggregates Gemini token spend per user/agent.

## 20. Testing strategy

- **Unit (Vitest)** in `packages/tools/*`, external HTTP mocked with `msw`.
- **Schema contract tests:** Zod schemas validated against fixture responses captured from real APIs.
- **Agent loop tests:** Vercel AI SDK simulated streams + recorded model outputs; assert tool sequences for canonical Sales flows.
- **E2E (Playwright):** admin flows (connect integration → upload KB doc → run chat → draft proposal) against staging.
- **MCP smoke test:** Node script connects to deployed MCP, lists tools, runs `kb.search` + `sales.draft_proposal` against a known company.
- **No external mocking in E2E:** sandbox HubSpot account + test Workspace user.

## 21. Risks and mitigations

| Risk                                        | Mitigation                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gemini hallucinates rates or HubSpot data   | KB citations required; `sales.draft_proposal` outputs only data returned by tools, never inferred numbers                                                              |
| OAuth token leakage                         | Encrypted at rest in Supabase Vault, service-role-only access, RLS prevents client reads                                                                               |
| MCP token misuse                            | Per-user, revocable, scoped to that user's data; rate-limited                                                                                                          |
| Drive sync running away on huge folders     | Per-collection caps: 500 docs, 10 MB per file; warn in UI                                                                                                              |
| LLM cost overrun                            | Per-user daily token cap; `/admin/usage` dashboard; alert at 80%                                                                                                       |
| Vendor lock-in (Supabase / Vercel / Gemini) | Tools depend on interfaces (`SupabaseClient`, `ai`'s `LanguageModelV1`, pgvector — all swappable). Vector store can move to Pinecone without changing tool interfaces. |

## 22. Open questions for implementation phase

- Inngest vs. pg-boss for background jobs — pick during implementation based on retry/observability needs vs. avoiding new vendors.
- Whether to wrap `apps/web/(chat)` inside Tauri via webview or rebuild as a native-feeling React app — start with webview; revisit if UX issues appear.
- Exact RAG re-ranker (BM25 weight, MMR) — tune with real KB content during pilot.

## 23. Out-of-scope reminders (v2+)

- Proactive alerts (calendar / HubSpot watchers, push notifications)
- HubSpot write tools (log call, update deal stage)
- Voice I/O
- Slack / Teams surfaces
- Mobile app
- HR + Recruiter agents
- Standalone customer-branded web app
