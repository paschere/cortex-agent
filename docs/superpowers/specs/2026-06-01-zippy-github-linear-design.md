# Design: GitHub + Linear integrations and the Zippy Developer agent

**Date:** 2026-06-01
**Status:** Approved (design), pending implementation plan

## Summary

Add two native OAuth integrations (GitHub, Linear) following the existing
Google/HubSpot pattern, a set of read/write/stats tools for each, a KB-write
capability so generated documentation can be persisted, and a new agent
**Zippy Developer** that uses these tools.

Zippy's capabilities (from the request):

- Read GitHub comments (issues/PRs).
- Generate Markdown documentation of the repos it can access and save it to the
  Knowledge Base.
- Explain roadmaps from Linear (projects/cycles).
- Show statistics: Linear velocity/cycles, Linear workload-per-person, GitHub
  repo activity, GitHub PR metrics.

## Decisions (confirmed)

- **Connection model:** Native integrations (OAuth + dedicated tools), same
  shape as Google/HubSpot. Not the external-MCP-server route.
- **Write scope:** Read + basic write (create issue / create comment) gated with
  `requiresConfirmation`.
- **Doc-gen target:** Generated Markdown is persisted to the internal Knowledge
  Base (not committed back to the repo).
- **Statistics:** All four categories — Linear velocity/cycles, Linear workload,
  GitHub repo activity, GitHub PR metrics.
- **Scope of this spec:** Single spec covering all four phases.
- **KB ingestion:** Inline via a shared `ingestMarkdown()` helper (not the async
  Inngest pipeline) — see rationale in §3.

## Architecture context (verified against the codebase)

- Integration providers are a union in `packages/core/src/types.ts`
  (`IntegrationProvider`) plus an enum `integration_provider` in the DB
  (`infra/supabase/migrations/0004_integrations.sql`).
- OAuth tokens are encrypted (AES-256-GCM) and stored per `(user_id, provider)`
  in `public.integrations`.
- `createIntegrationsClient` (`packages/agent-tools/src/integrations.ts`)
  returns the stored access token directly when `expires_at` is null; refresh
  only fires when a token is expired. **GitHub OAuth Apps and Linear issue
  long-lived tokens with no refresh token**, so the callbacks store the token
  with `refresh_token_enc = null` and `expires_at = null`, and no refresher is
  registered.
- Tools self-register via `registerTool` into the registry
  (`packages/agent-tools/src/registry.ts`); shape is `ToolDef` in
  `packages/agent-tools/src/types.ts` (`id`, `description`, `inputSchema`,
  `outputSchema`, `requiredScopes`, `rateLimit`, `requiresConfirmation`,
  `handler`).
- `ToolContext` exposes `db` (Supabase service client, incl. `db.storage`),
  `integrations`, `logger`, `signal`. It does **not** expose an Inngest client,
  and tools also run on the Cloudflare MCP worker — so any KB write must be
  runtime-agnostic (fetch + db only).
- Agents are defined in `packages/agents/src/<id>/index.ts`, registered in
  `packages/agents/src/index.ts`, and seeded into `public.agents`. They are
  loaded at runtime by `loadAgent` from the DB.
- KB ingestion today: `kb_documents` row → `kb/document.ingest` Inngest event →
  `chunkText` + `embed` + insert `kb_chunks`. `parseDocument` already handles
  `text/markdown`. `chunkText` and `embed` live in `packages/agent-tools/src/kb/`
  and are pure fetch/JS (run in both runtimes).
- Chat runtime: `apps/web/app/api/chat/route.ts` (`runtime = 'nodejs'`,
  `maxDuration = 300`) builds `aiTools` from `filterTools(agent.allowedTools)`;
  `requiresConfirmation` surfaces via a `__requires_confirmation` sentinel.

---

## 1. Integrations (OAuth)

### 1.1 Core + DB

- `packages/core/src/types.ts`: extend `IntegrationProvider` to
  `'google' | 'hubspot' | 'github' | 'linear'`.
- New migration `infra/supabase/migrations/00XX_github_linear_providers.sql`:
  ```sql
  alter type integration_provider add value if not exists 'github';
  alter type integration_provider add value if not exists 'linear';
  ```
  `ADD VALUE` cannot run in the same transaction that also uses the new value;
  keep this migration to enum changes only (no inserts that reference the new
  values in the same file).
- `packages/agent-tools/src/types.ts`: widen `IntegrationsClient` provider params
  to include `'github' | 'linear'`.
- `packages/agent-tools/src/integrations.ts`: change `REFRESHERS` to
  `Partial<Record<IntegrationProvider, RefreshFn>>` (github/linear absent — never
  refreshed). `getAccessToken` already returns the stored token when
  `expires_at` is null, so no refresher path is hit.

### 1.2 OAuth routes

- GitHub:
  - `apps/web/app/api/integrations/github/route.ts` — redirect to
    `https://github.com/login/oauth/authorize` with scope `repo read:org`.
  - `apps/web/app/api/integrations/github/callback/route.ts` — exchange code at
    `https://github.com/login/oauth/access_token` (Accept: application/json),
    encrypt token, upsert with `refresh_token_enc = null`, `expires_at = null`,
    `scopes` from the response (space/comma-separated).
- Linear:
  - `apps/web/app/api/integrations/linear/route.ts` — redirect to
    `https://linear.app/oauth/authorize` with `scope=read,write`,
    `response_type=code`.
  - `apps/web/app/api/integrations/linear/callback/route.ts` — exchange code at
    `https://api.linear.app/oauth/token`, encrypt, upsert long-lived token.
- Env vars: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `LINEAR_CLIENT_ID`,
  `LINEAR_CLIENT_SECRET`. Document in `apps/web/.env.example` / `apps/mcp/.dev.vars`.

### 1.3 Security note

GitHub `repo` scope grants broad read/write to the user's private repos. It is
required to read private-repo comments/contents (for documentation) and to
create issues/comments. Surfaced and accepted as a deliberate decision for an
internal dev agent.

---

## 2. Tools

Namespace = `provider.action`. One file per tool, barrel `index.ts`, re-exported
from `packages/agent-tools/src/index.ts`.

### 2.1 GitHub (`packages/agent-tools/src/github/`)

- `client.ts`: `githubFetch<T>(ctx, path, { method, body })` — REST against
  `https://api.github.com`, `Authorization: Bearer <token>`,
  `Accept: application/vnd.github+json`, maps 401/4xx to `IntegrationError`,
  passes `ctx.signal`. Token via `ctx.integrations.getAccessToken('github')`.
- Read tools (`requiredScopes: [{ provider: 'github', scopes: ['repo'] }]`):
  - `github.list_repositories` — repos accessible to the user (optionally by org).
  - `github.get_repository` — metadata: description, default branch, languages, topics.
  - `github.get_issue` — issue/PR title, body, state, labels.
  - `github.list_issue_comments` — comments on an issue/PR ("leer comentarios").
  - `github.list_pull_requests` — PRs by state.
  - `github.get_repo_contents` — README + a file/tree path (for documentation).
- Stats tools (read):
  - `github.repo_activity` — counts of open/merged PRs, recent commits, open/closed
    issues, contributors, language breakdown over a window.
  - `github.pr_metrics` — time-to-merge, unreviewed PRs, review throughput.
- Write tools (`requiresConfirmation: true`, scope `repo`):
  - `github.create_issue`
  - `github.create_issue_comment`

### 2.2 Linear (`packages/agent-tools/src/linear/`)

- `client.ts`: `linearFetch<T>(ctx, query, variables)` — POST GraphQL to
  `https://api.linear.app/graphql`, `Authorization: Bearer <token>`. Includes a
  pagination helper (cursor-based `pageInfo`) for stats tools. Token via
  `ctx.integrations.getAccessToken('linear')`.
- Read tools (`requiredScopes: [{ provider: 'linear', scopes: ['read'] }]`):
  - `linear.list_teams`
  - `linear.list_projects` / `linear.get_project` — roadmaps, milestones, progress.
  - `linear.list_issues` — filters: team, cycle, assignee, state.
  - `linear.get_issue`
  - `linear.list_comments`
- Stats tools (read):
  - `linear.cycle_stats` — issues by state, completed per cycle, current cycle
    scope/progress (velocity).
  - `linear.workload_stats` — issues/WIP per assignee (load per person).
- Write tools (`requiresConfirmation: true`, scope `write`):
  - `linear.create_issue`
  - `linear.create_comment`

### 2.3 Rate limits

Each tool sets a `rateLimit.perMinute` consistent with existing tools (reads
~30–60, writes ~20). Stats tools that paginate use a lower limit (~6–10) and cap
total pages fetched, logging when results are truncated.

---

## 3. KB write capability

- New tool `kb.create_document`:
  - Input: `{ title, markdown, scope: 'global'|'team'|'user'|'conversation',
teamId? }`.
  - Resolves the target collection for the scope (creating a user/conversation
    collection if none exists; team/global require appropriate authority, mirrored
    from `apps/web/app/api/kb/documents/route.ts`).
  - Calls `ingestMarkdown` and returns `{ documentId, chunks }`.
  - `rateLimit.perMinute` low (~6). Not confirmation-gated (writes only to the
    internal KB), but writing to `global`/`team` scope checks the caller's role.
- New shared helper `packages/agent-tools/src/kb/ingest.ts`:
  `ingestMarkdown(db, { collectionId, title, content, uploadedBy })`:
  1. `sha256` of content.
  2. Insert `kb_documents` row (`source: 'upload'`, `mime: 'text/markdown'`,
     `status: 'pending'`).
  3. `chunkText(content)` → `embed(chunks)` → insert `kb_chunks`.
  4. Update document `status: 'ready'` (or `failed` + `error_message` on throw).
  - Runtime-agnostic: only `fetch` (embedder) + `db`. No Inngest, no storage
    download. The existing async pipeline is untouched and still serves uploads.

### Rationale for inline ingestion

The async pipeline exists to keep large user **uploads** off the request thread
and is wired through Next-only Inngest. Agent-generated docs are (a) already in
memory, (b) bounded to one repo's worth of Markdown, and (c) produced by tools
that must also run on the Cloudflare MCP worker, where the Next Inngest client is
unavailable and `ToolContext` has no emit capability. Inline chunk/embed/insert
is a few embedding batches, well within `maxDuration = 300`, and keeps the tool
runtime-agnostic with no new coupling.

### Doc generation is agent-driven, not a composite tool

Zippy reads the repo via `github.*` tools, **writes the Markdown itself** (LLM
synthesis), then calls `kb.create_document` to persist. No
`sales.draft_proposal`-style template composite — simpler and more flexible.

---

## 4. Agent: Zippy Developer

- `packages/agents/src/zippy/index.ts`:
  ```ts
  export const zippyDeveloperAgent: AgentDefinition = {
    id: "zippy",
    name: "Zippy Developer",
    team: "engineering",
    defaultModel: "gemini-3.1-flash-lite",
    systemPrompt, // from system-prompt.md
    allowedTools: [
      // github.* (read, stats, write)
      // linear.* (read, stats, write)
      "kb.search",
      "kb.create_document",
      "web.search",
    ],
    kbScopes: ["global", "team:engineering", "user", "conversation"],
    greeting: "¡Hola! Soy Zippy, tu co-pilot de desarrollo. ¿Qué miramos hoy?",
  };
  ```
- `packages/agents/src/zippy/system-prompt.md`: role, how to document repos (read
  → synthesize Markdown → `kb.create_document`), how to explain roadmaps and
  report stats, and the confirmation discipline for writes.
- Register in `packages/agents/src/index.ts` (`REGISTRY.set(...)` + export).
- Seed migration: ensure an `Engineering` team exists, then insert the `zippy`
  agent row (slug, name, team_id, system_prompt, default_model,
  allowed_tool_ids), `on conflict (slug) do nothing`.

---

## 5. Web UI

- `apps/web/app/(app)/integrations/page.tsx`: GitHub and Linear cards with
  connect / connected status (read `byProvider`).
- `apps/web/lib/tool-labels.ts`: labels + icons for all new tools
  (`github_*`, `linear_*`, `kb_create_document`).
- `apps/web/app/(app)/agents/[slug]/page.tsx`: add "GitHub" and "Linear" tool
  groups to the picker. The agents list shows Zippy automatically from the DB.

---

## 6. Build order (phased, one spec)

1. **Phase A — Core read path:** providers (core type + enum migration),
   `IntegrationsClient` widening, OAuth routes (both), `githubFetch`/`linearFetch`
   clients, all read tools, Zippy agent definition + seed, integrations UI cards,
   tool labels. Outcome: connect both, Zippy reads issues/comments/PRs/projects
   end-to-end.
2. **Phase B — Documentation:** `ingestMarkdown` helper + `kb.create_document`
   tool; Zippy system prompt doc-gen workflow.
3. **Phase C — Writes:** `github.create_issue`, `github.create_issue_comment`,
   `linear.create_issue`, `linear.create_comment` (confirmation-gated).
4. **Phase D — Statistics:** `github.repo_activity`, `github.pr_metrics`,
   `linear.cycle_stats`, `linear.workload_stats` (pagination + truncation logging).

## 7. Testing

- Unit: input/output schema validation per tool; `githubFetch`/`linearFetch`
  error mapping; `ingestMarkdown` chunk/embed/insert with a mocked embedder;
  collection resolution + authority checks for `kb.create_document`.
- Integration: OAuth callback upsert (long-lived token, null refresh/expiry);
  `getAccessToken` returns stored token without hitting a refresher.
- E2E (manual, per phase): connect GitHub/Linear; Zippy reads a repo's comments;
  Zippy documents a repo and the doc is searchable via `kb.search`; Zippy creates
  an issue after confirmation; Zippy reports cycle stats.

## 8. Out of scope (YAGNI / follow-ons)

- Committing generated docs back to GitHub.
- GitHub App (vs OAuth App) installation model and fine-grained tokens.
- Token refresh for GitHub/Linear (tokens are long-lived).
- Re-generating/refreshing a previously generated KB doc (dedupe by sha256 could
  be added later).
- Linear webhooks / real-time sync.
