# Zipdev Agent v2 — Implementation Spec

## Overview

V2 transforms the Zipdev Sales AI Co-pilot from a read-only question-answering tool into a complete sales action platform. The current state is a functional skeleton: the agent runs on a 55-word seed prompt instead of the production system prompt, the proposal composite crashes on every invocation due to a Zod enum validation bug, KB citations are wired in the UI but never emitted by the API, the chat interface renders all LLM output as plain text, and salespeople cannot take any CRM action through the agent — only read. V2 fixes every confirmed crash, deploys the production system prompt, expands the tool surface to cover HubSpot writes and web research, and ships a production-quality chat interface with markdown rendering, streaming UX, and sales-specific affordances.

The work is organized into four parallel tracks: UX Redesign, Agent Quality, Tool Expansion, and Dynamic MCP. Tracks 1–3 can be executed concurrently by a team or sequenced by a solo developer. Track 4 (Dynamic MCP) has a hard dependency on the atomic rate-limiter fix that ships in Track 3 and should start after that migration lands. The reviews identified and resolved several design conflicts: the multi-agent architecture proposal is dropped as premature (sub-agents have no capabilities the main agent lacks and add routing failure modes), per-conversation memory via rolling summaries is dropped (covered adequately by 20-message server-side rehydration), and citations are deferred until the backend emits structured annotation events.

Each task below is concrete and actionable. File paths are absolute from repo root. Effort estimates are calibrated against the review findings: the UX layout merge is scoped conservatively (sidebar added to chat layout only, full route-group unification deferred), MessageBubble is split into three independent deliverables, and the file-on-first-message API rewrite is deferred. Security-critical items (SSRF, atomic rate limiter, token key versioning) are treated as hard prerequisites, not optional polish.

---

## Design Decisions

**Sidebar placement**: Instead of merging route groups (which touches every page file), the sidebar is added inside `(chat)/layout.tsx` as a conditional flex sibling. Full `(shell)/layout.tsx` unification is deferred to a dedicated refactor after v2 ships. This ships the sidebar in chat with a one-file change.

**Citation deferral**: `CitationFootnote.tsx` exists and renders safely with no data. The backend must emit structured `streamText` annotations via `onChunk` before the UI wiring is meaningful. That backend work is out of scope for v2. The component is left untouched.

**useSWR vs useQuery**: The codebase has `@tanstack/react-query@5.62.7` installed and no `swr`. All data-fetching hooks use `useQuery` from `@tanstack/react-query`. `swr` is not added.

**Multi-agent architecture**: Dropped. Research, Proposal, and Follow-up sub-agents have subsets of the main agent's tools. Prompt focus is achieved via the system prompt's tool-selection guide, not separate agent DB rows. Routing failure modes and extra inference calls are not acceptable at MVP scale.

**Per-conversation memory (rolling summaries)**: Dropped. Server-side rehydration of the last 20 DB messages (Bug Fix 4) covers the real use case. Rolling summarization adds a new DB schema, a background model call, a new conditional injection path, and a new failure mode, all for marginal value over rehydration.

**Proactive deal health briefing**: Demoted from automatic behavior to explicit `/briefing` slash command. Automatic firing on every new conversation adds 800ms first-message latency and fires on irrelevant conversations. The slash command gives the same capability on demand.

**Ctrl+N shortcut**: Dropped. Browser-level new-window shortcut in Chrome, Firefox, and Edge cannot be intercepted by `window.addEventListener`.

**File-on-first-message**: Deferred. `/api/chat/route.ts` is a `req.json()` endpoint; rewriting it for multipart requires a parallel KB ingestion pipeline change. The `FileDropZone` correctly gates on `conversationId` existence. Users send a first text message to create the conversation, then attach files. This is not a regression.

**HubSpot scope re-consent**: `crm.objects.contacts.write`, `crm.objects.deals.write`, and `crm.objects.notes.write` must be added to `apps/web/app/api/integrations/hubspot/route.ts` before any write tool ships. All existing users must re-authorize. This is a hard deployment gate for Track 3 write tools.

**gmail.send scope**: Not needed. `gmail.compose` (already granted) covers sending existing drafts. No re-consent required.

**drive.readonly scope**: Already in `ALL_SCOPES` in `apps/web/app/api/integrations/google/route.ts`. No re-consent required for `gdrive` tools.

**SSRF in Node path**: The string-only hostname check is insufficient for the Node `route.ts` path (no Cloudflare egress filtering). The Node path must resolve the hostname to IP addresses and check resolved IPs against the private range list before making any outbound fetch. The Cloudflare Worker path relies on Cloudflare's egress filtering as a second layer but still runs the string check.

**Atomic rate limiter**: The existing `consumeToken()` has a SELECT-then-UPDATE TOCTOU race. This is fixed for all callers (built-in tools and external MCP proxy) via a Postgres RPC before Track 4 ships.

**Tool count gating**: Adding all proposed new tools to `sales/index.ts` at once yields 31 allowed tools, degrading LLM accuracy. New tools ship in three batches (web tools, HubSpot reads, HubSpot writes) with separate `allowedTools` PRs.

**8-char UUID prefix for external tools**: Replaced with 16-char lowercase hex (first 16 chars of UUID with hyphens removed) to reduce theoretical collision probability to ~1/18 quadrillion per pair while staying within Claude's 64-char tool name limit.

**Objection playbook stats**: The static statistics in the system prompt (`12% acceptance rate`, `40% include travel clause`, `$3k/year travel allowance`) are moved to a KB document tagged `internal/objection-playbook` and injected via RAG when objection signals are detected. They are removed from the static system prompt to prevent fabricated-confidence outputs.

---

## Plan: 4 Tracks

---

### Track 1: UX Redesign

#### T1.1 — Markdown rendering in MessageBubble
**Priority**: Highest ROI, no API changes, no new routes. Ship first.

**Description**: Replace the `whitespace-pre-wrap` div in `MessageBubble.tsx` with `react-markdown` configured with `remark-gfm` and `rehype-highlight`. Wrap output in `<div className="prose prose-sm dark:prose-invert max-w-none overflow-x-auto">` with Tailwind prose overrides to tighten spacing inside chat bubbles. Import a highlight.js CSS theme in `app/layout.tsx`.

**Files to modify**:
- `apps/web/components/chat/MessageBubble.tsx`
- `apps/web/app/layout.tsx` — add `import 'highlight.js/styles/github-dark-dimmed.css'`
- `apps/web/tailwind.config.ts` — add `require('@tailwindcss/typography')` to plugins

**New dependencies to install**:
```
pnpm add react-markdown@^9.0.1 remark-gfm@^4.0.0 rehype-highlight@^7.0.0 highlight.js
pnpm add -D @tailwindcss/typography
```

**Implementation notes**:
- Do NOT add `rehype-raw` — default react-markdown sanitization is correct for LLM output.
- Prose overrides to add alongside `prose-sm`: `prose-headings:mt-2 prose-p:mt-1 prose-p:mb-0 prose-li:my-0 prose-ul:my-1 prose-ol:my-1`
- Wrap the prose container in `overflow-x-auto` to handle GFM tables in narrow bubbles.
- XSS safe by default; no change needed.

**Effort**: S

---

#### T1.2 — MessageList sticky scroll + TypingIndicator
**Description**: Replace the `useEffect([messages.length, isLoading])` dependency array with a `ResizeObserver` on the scroll container's inner content div. Fire `scrollTop = scrollHeight` only if the user is within 120px of the bottom. Add a sticky chevron-down FAB when the user has scrolled away. Replace the `animate-pulse` thinking indicator with a `TypingIndicator` component (three dots with staggered `framer-motion` scale pulses).

**Files to modify**:
- `apps/web/components/chat/MessageList.tsx`

**Files to create**:
- `apps/web/components/chat/TypingIndicator.tsx`

**Implementation notes**:
- `TypingIndicator` renders when `isLoading && lastMessage?.role !== 'assistant'` (before first token arrives).
- Streaming cursor: add `after:content-['▋'] after:animate-pulse after:ml-0.5 after:text-neutral-400` via a `data-streaming` attribute on the last assistant bubble while `isLoading`. Pure CSS, no JS re-animation.
- Chevron FAB: `position: sticky`, `bottom-4`, renders inside `MessageList` scroll container.

**Effort**: M

---

#### T1.3 — Sidebar in chat layout
**Description**: Add the sidebar inside `(chat)/layout.tsx` as a flex sibling to the main chat column. On desktop (≥768px) render a 240px collapsible panel. On mobile render a `@radix-ui/react-dialog` drawer (already installed) triggered by a hamburger icon in the chat header. Populate with navigation links and a recent conversations list fetched via `useQuery`.

**Files to modify**:
- `apps/web/app/(chat)/layout.tsx` — change bare `h-screen flex-col` to `flex flex-row h-screen`; conditionally include `<Sidebar>`
- `apps/web/components/nav/Sidebar.tsx` — full rewrite

**Files to create**:
- `apps/web/app/api/conversations/route.ts` — `GET` handler returning last 8 conversations ordered by `pinned DESC, updated_at DESC`; uses `requireSession()` and service-role client

**Schema change** (run before this task):
```sql
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS conversations_user_pinned_idx
  ON conversations(user_id, pinned, updated_at DESC);
```

**Implementation notes**:
- Sidebar state (collapsed/expanded) stored in `localStorage` key `sidebar_collapsed`.
- `usePathname` drives active-link highlighting: `bg-neutral-100 dark:bg-neutral-800 font-medium` pill on matching route.
- Recent conversations grouped by relative date ('Today', 'Yesterday', 'This week', 'Older') using `Intl.RelativeTimeFormat` — no date library.
- `useQuery({ queryKey: ['conversations'], queryFn: () => fetch('/api/conversations').then(r => r.json()) })` with `staleTime: 60_000`.
- Mobile: hamburger icon in chat header sets `sidebarOpen` state; Radix Dialog drawer renders Sidebar content.

**Effort**: M

---

#### T1.4 — EmptyState component
**Description**: New component rendered when `messages.length === 0 && !isLoading`. Shows agent avatar, greeting, and 6 prompt suggestion cards. Cards animate in with Framer Motion staggered `fadeInUp`.

**Files to create**:
- `apps/web/components/chat/EmptyState.tsx`

**Files to modify**:
- `apps/web/components/chat/MessageList.tsx` — mount `EmptyState` when `messages.length === 0`

**Static prompt cards**:
```tsx
const SUGGESTIONS = [
  { icon: 'BarChart2', text: 'Summarize my pipeline' },
  { icon: 'FileText', text: 'Draft a proposal for Acme Corp' },
  { icon: 'Calendar', text: 'Which deals close this month?' },
  { icon: 'Search', text: 'Find contacts at [Company]' },
  { icon: 'UserCheck', text: 'Qualify this lead: [paste]' },
  { icon: 'Phone', text: 'Log a call with John Smith' },
];
```

Clicking a card sets the textarea value and focuses input.

**Effort**: S

---

#### T1.5 — ToolCallCard humanization
**Description**: Full rewrite of `ToolCallCard.tsx`. Map raw tool names to human strings and Lucide icons. Add status variants (amber spinner → green check → red alert). Add Framer Motion expand animation for args/result.

**Files to create**:
- `apps/web/lib/tool-labels.ts`

**Files to modify**:
- `apps/web/components/chat/ToolCallCard.tsx`

**`tool-labels.ts` content** (partial, extend as tools are added):
```ts
export const TOOL_LABELS: Record<string, { label: string; icon: string }> = {
  'qualify_lead':                  { label: 'Qualify Lead',              icon: 'UserCheck' },
  'hubspot_search_companies':      { label: 'Search HubSpot Companies',  icon: 'Building2' },
  'hubspot_get_company':           { label: 'Get Company Details',        icon: 'Building2' },
  'hubspot_search_deals':          { label: 'Search Deals',               icon: 'Briefcase' },
  'hubspot_get_deal':              { label: 'Get Deal Details',           icon: 'Briefcase' },
  'hubspot_search_contacts':       { label: 'Search Contacts',            icon: 'Users' },
  'hubspot_get_contact':           { label: 'Get Contact Details',        icon: 'User' },
  'hubspot_create_deal':           { label: 'Create Deal',                icon: 'PlusCircle' },
  'hubspot_update_deal':           { label: 'Update Deal',                icon: 'Edit' },
  'hubspot_create_contact':        { label: 'Create Contact',             icon: 'UserPlus' },
  'hubspot_log_activity':          { label: 'Log Activity',               icon: 'ClipboardList' },
  'hubspot_get_pipeline_summary':  { label: 'Get Pipeline Summary',       icon: 'BarChart2' },
  'hubspot_list_recent_activities':{ label: 'List Recent Activities',     icon: 'Activity' },
  'gmail_search':                  { label: 'Search Gmail',               icon: 'Mail' },
  'gmail_read_thread':             { label: 'Read Email Thread',          icon: 'MailOpen' },
  'gmail_draft':                   { label: 'Draft Email',                icon: 'Pencil' },
  'gmail_send_draft':              { label: 'Send Email Draft',           icon: 'Send' },
  'gmail_list_threads':            { label: 'List Email Threads',         icon: 'Inbox' },
  'gcal_list_events':              { label: 'List Calendar Events',       icon: 'Calendar' },
  'gcal_create_event':             { label: 'Create Calendar Event',      icon: 'CalendarPlus' },
  'gsheets_read_range':            { label: 'Read Spreadsheet',           icon: 'Table' },
  'gsheets_append_row':            { label: 'Append Row to Sheet',        icon: 'TableProperties' },
  'kb_search':                     { label: 'Search Knowledge Base',      icon: 'BookOpen' },
  'rate_estimate':                 { label: 'Estimate Rate',              icon: 'DollarSign' },
  'sales_draft_proposal':          { label: 'Draft Proposal',             icon: 'FileText' },
  'web_search':                    { label: 'Web Search',                 icon: 'Globe' },
  'web_scrape':                    { label: 'Fetch Web Page',             icon: 'Link' },
  'gdrive_search_files':           { label: 'Search Drive Files',         icon: 'FolderSearch' },
  'gdrive_read_doc':               { label: 'Read Drive Document',        icon: 'FileSearch' },
};

export function toolLabel(toolId: string): { label: string; icon: string } {
  return TOOL_LABELS[toolId] ?? { label: toTitleCase(toolId), icon: 'Wrench' };
}

function toTitleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
```

**Status color classes**:
- `partial-call` / `call`: `bg-amber-50 dark:bg-amber-900/20` + `Loader2 animate-spin text-amber-600`
- `result` (success): `bg-green-50 dark:bg-green-900/20` + `CheckCircle2 text-green-600`
- `result` (error): `bg-red-50 dark:bg-red-900/20` + `AlertCircle text-red-600`

**Effort**: M

---

#### T1.6 — ConfirmationPrompt plain-English summary
**Description**: Replace raw JSON display with a human-readable action summary above a collapsed detail.

**Files to modify**:
- `apps/web/components/chat/ConfirmationPrompt.tsx`
- `apps/web/lib/tool-labels.ts` — add `CONFIRMATION_SUMMARIES`

**`CONFIRMATION_SUMMARIES` function**:
```ts
export function confirmationSummary(toolId: string, input: Record<string, unknown>): string {
  switch (toolId) {
    case 'hubspot_update_deal':
      return `Update deal${input.dealstage ? ` stage to "${input.dealstage}"` : ''}${input.amount ? ` · amount $${input.amount}` : ''}`;
    case 'hubspot_create_deal':
      return `Create deal "${input.dealname}" in stage "${input.dealstage}"`;
    case 'hubspot_create_contact':
      return `Create contact ${[input.firstName, input.lastName].filter(Boolean).join(' ')} <${input.email}>`;
    case 'hubspot_log_activity':
      return `Log ${input.type} "${input.subject}" on ${input.associatedObjectType} ${input.associatedObjectId}`;
    case 'gmail_send_draft':
      return `Send Gmail draft ${input.draftId}`;
    case 'gcal_create_event':
      return `Create calendar event "${input.summary}" on ${input.start}`;
    case 'gsheets_append_row':
      return `Append row to sheet "${input.spreadsheetId}"`;
    default:
      return `Run: ${toolLabel(toolId).label}`;
  }
}
```

**UI structure**: amber `AlertTriangle` icon + "Confirm action" heading + plain-English summary (14px semibold) + `<details>` element with "Show details" summary label wrapping the existing JSON `<pre>` block + Confirm / Dismiss buttons (renamed from Allow / Cancel).

**Effort**: S

---

#### T1.7 — InputBar agent pill + send icon + char count
**Description**: Move the agent selector from the chat header `<select>` into the input bar as a styled pill on the left. Replace the plain send button with a Lucide `ArrowUp` in a filled circle. Add character count when `text.length > 3500`. Omit file-on-first-message and slash popover (deferred).

**Files to modify**:
- `apps/web/components/chat/InputBar.tsx`
- `apps/web/components/chat/ChatRoot.tsx` — pass agent info down

**Agent pill**: shows agent name; clicking opens `@radix-ui/react-dropdown-menu` listing all agents with one-line descriptions. Once `conversationId` exists, pill shows tooltip "Start a new chat to switch agents".

**Send button**: `bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 rounded-full p-1` wrapping `ArrowUp` (16px). `disabled` and `opacity-50` when textarea empty or `isLoading`.

**Effort**: M

---

#### T1.8 — Mobile responsive layout
**Description**: Three targeted Tailwind changes to the chat layout.

**Files to modify**:
- `apps/web/app/(chat)/layout.tsx` — outer flex container responsive classes
- `apps/web/components/nav/Sidebar.tsx` — `hidden md:flex` on desktop, Dialog drawer on mobile
- `apps/web/components/chat/InputBar.tsx` — `flex-wrap` on `< sm`

**Changes**:
1. Chat layout: outer wrapper `flex flex-row h-screen`. Sidebar: `hidden md:flex flex-col w-60 shrink-0 border-r`.
2. Chat column: `flex-1 min-w-0 flex flex-col h-screen`. MessageList: `flex-1 overflow-y-auto`. `max-w-3xl mx-auto px-4 sm:px-6` retained for readability.
3. InputBar: agent pill moves above textarea on `< sm` via `flex-wrap`.

**Effort**: M

---

#### T1.9 — ChatRoot: conversation title + tool history restore
**Description**: Two targeted fixes.

**Files to modify**:
- `apps/web/components/chat/ChatRoot.tsx`
- `apps/web/app/(chat)/chat/[conversationId]/page.tsx`

**Title fetch**: Replace static header string with `useQuery({ queryKey: ['conversation', conversationId], queryFn: ..., enabled: !!conversationId })` fetching from the existing GET `/api/conversations/[id]` (or the new `/api/conversations/route.ts` from T1.3). Fall back to "New Chat".

**Tool history restore**: The DB query at `page.tsx` line 25 already selects `tool_calls` and `tool_results`. The mapping code to convert them to `toolInvocations` is missing. Add it:

```ts
// In page.tsx, when building initialMessages:
function buildToolInvocations(
  toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }>,
  toolResults: Array<{ toolCallId: string; result: unknown }>
): ToolInvocation[] {
  const resultMap = new Map(toolResults.map(r => [r.toolCallId, r.result]));
  return toolCalls.map(tc => ({
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    args: tc.args,
    state: resultMap.has(tc.toolCallId) ? 'result' : 'call',
    result: resultMap.get(tc.toolCallId),
  }));
}

// Applied when mapping DB messages to AI SDK Message objects:
toolInvocations: msg.tool_calls?.length
  ? buildToolInvocations(msg.tool_calls, msg.tool_results ?? [])
  : undefined,
```

Verify the exact JSON shape written by `onFinish` in `/api/chat/route.ts` lines 146-154 before finalizing field names.

**404 redirect**: Replace silent fallback in `page.tsx` with `redirect('/chat?error=not-found')`. In `ChatRoot`, read `useSearchParams().get('error')` and show a Radix Toast for `not-found`.

**Effort**: M

---

#### T1.10 — Command palette (Ctrl+K)
**Description**: `cmdk`-based command palette. Opens on `Ctrl+K` / `Cmd+K`.

**New dependency**: `pnpm add cmdk@^1.0.0`

**Files to create**:
- `apps/web/components/chat/CommandPalette.tsx`
- `apps/web/hooks/useGlobalHotkeys.ts`

**Commands**: New Chat (navigate `/chat`), Go to Conversations, Go to KB, Go to Integrations, recent conversations (from `useQuery` cache), slash commands that append text to active chat input.

**Hotkeys registered in `useGlobalHotkeys`** (mounted in `ChatRoot`):
- `Ctrl+K` / `Cmd+K` → open command palette
- `Ctrl+/` / `Cmd+/` → focus chat textarea
- `Escape` → call `stop()` from `useChat`
- `ArrowUp` in textarea at cursor position 0 with last user message → restore last user message into textarea
- **Ctrl+N is explicitly omitted** (browser-reserved).

**Effort**: M

---

#### T1.11 — Message actions row (Copy + Regenerate only)
**Description**: Hover-revealed action row below each assistant bubble. Copy and Regenerate only. Thumbs feedback and Log-to-CRM are deferred.

**Files to modify**:
- `apps/web/components/chat/MessageBubble.tsx`

**Accessibility**: `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity sm:opacity-0 opacity-40`. All icon-only buttons get `aria-label`. Hidden during streaming (`isLoading && isLastAssistant`).

**Copy**: `navigator.clipboard.writeText(plainContent)` where `plainContent` strips markdown.  
**Regenerate**: calls `reload()` from `useChat`.

**Effort**: S

---

#### T1.12 — Conversation title auto-generation (backend)
**Description**: After the first assistant message is saved, fire-and-forget title generation using a Gemini model.

**Files to modify**:
- `apps/web/app/api/chat/route.ts`

**Implementation** (inside `onFinish` callback):
```ts
// Only on first assistant turn (check messages.length === 1 for assistant role in this session)
if (isFirstAssistantTurn) {
  void (async () => {
    try {
      const { text } = await generateText({
        model: google('gemini-1.5-flash'),
        prompt: `Summarize this sales conversation starter in 5 words or fewer, no punctuation: "${firstUserMessage}"`,
        maxTokens: 20,
      });
      await db.from('conversations').update({ title: text.trim() }).eq('id', conversationId);
    } catch { /* non-fatal */ }
  })();
}
```

`conversations.title` column already exists. No schema change needed. Use `google('gemini-1.5-flash')` only — `@ai-sdk/anthropic` is not installed.

**Effort**: S

---

### Track 2: Agent Quality

#### T2.1 — Deploy production system prompt to DB
**Description**: Create migration `0016_sales_system_prompt.sql` that updates the sales agent row with the full production prompt. Update `packages/agents/src/sales/system-prompt.md` to match. Add a length-guard in `runtime.ts` to log a warning (not silently continue) if the DB prompt is under 200 characters.

**Files to create**:
- `infra/supabase/migrations/0016_sales_system_prompt.sql`

**Files to modify**:
- `packages/agents/src/sales/system-prompt.md`
- `packages/agents/src/runtime.ts` — guard: `if (dbPrompt.length < 200) { logger.warn('Agent system_prompt suspiciously short', { agentId, length: dbPrompt.length }); }`

**Migration**:
```sql
UPDATE agents
SET system_prompt = $PROMPT$
You are **Zipdev Sales**, the AI co-pilot embedded in Zipdev's sales team.

Zipdev places engineers and operators from **Latin America** (Mexico, Colombia, Brazil, Argentina, Chile, Peru) with US and EU companies. Our value proposition: nearshore time zones (UTC-3 to UTC-7), English proficiency, strong technical universities, rates 30–55% below equivalent US hires, and cultural fit with US work style.

# Your job

Help salespeople win deals faster. You have access to their HubSpot CRM, Gmail, Google Calendar, Google Sheets, and a knowledge base of past proposals and case studies. You are a peer to the salesperson — confident, direct, no fluff.

# Behavioral rules (follow in order)

1. **Ground every claim in live data.** Before stating a rate, a deal stage, a contact name, or a company detail, fetch it from a tool. When you cite a number, state the tool and timestamp: "Per HubSpot (fetched just now), deal value is $48 000."
2. **Cite KB hits as footnotes.** Use `[^1]`, `[^2]` markers inline. At the bottom of every message that cites KB, list: `[^1]: *Document title* — excerpt`. Never cite a document you have not searched for in this turn.
3. **Never send emails directly.** Always use `gmail_draft` and tell the user: "I've created a draft in your Gmail — subject '[subject]'. Review and send when ready."
4. **Confirm before writing to external systems.** Before calling `gcal_create_event` or `gsheets_append_row`, show the exact payload and wait for explicit user confirmation ('yes', 'confirm', 'go ahead'). Do not proceed on ambiguous responses.
5. **For full proposals, use `sales_draft_proposal` composite.** It fetches HubSpot context, runs rate estimation per role, and retrieves KB cases in one call. Use individual primitives only for narrow lookups.
6. **Qualify proactively.** When a prospect is first mentioned, ask (or look up) the four BANT signals: Budget indication, Authority (who signs), Need (what roles, what urgency), and Timeline (when do they want to hire). Surface missing signals as questions before drafting.
7. **Flag stale deals.** If a deal has been in the same stage for more than 21 days without a logged activity, say so unprompted. Suggest a next action.
8. **Respond in the user's language.** Spanish message → Spanish reply. English message → English reply. Proposals default to English unless asked otherwise.
9. **Handle objections directly.** When you detect price, quality, competitor, or budget objections, address them before moving on. KB documents tagged `internal/objection-playbook` contain approved counter-arguments — search them when objection language is detected.

# Tool selection guide

- Look up a company before a proposal: `hubspot_search_companies` → `hubspot_get_company`
- Check pipeline health or deal stage: `hubspot_search_deals` → `hubspot_get_deal`
- Look up a person: `hubspot_search_contacts` → `hubspot_get_contact`
- See what's been discussed with a prospect: `hubspot_list_recent_activities` + `gmail_search`
- Research a prospect before a call: `web_search` (company news, funding, tech stack from job postings)
- Price roles: `rate_estimate` (enums: role = frontend|backend|fullstack|data|devops|qa|pm|designer; seniority = junior|mid|senior|lead; region = mx|br|ar|co|cl|pe|latam). For freeform role descriptions, use `rate_estimate_from_document`.
- Find past proposals or case studies: `kb_search` (query: company name + industry + roles)
- Draft a complete proposal: `sales_draft_proposal` (provide companyName or companyId + roles array)
- Draft an outreach email: `gmail_draft` (never send directly)
- Schedule a follow-up: `gcal_create_event` — confirm details first
- Log a deal to tracking sheet: `gsheets_append_row` — confirm row values first
- Log a call or note to CRM: `hubspot_log_activity` — confirm before calling

# Rate ranges reference (2026-Q1, Zipdev internal pricing)

Use these as sanity-check anchors only. Always call `rate_estimate` for precise ranges — do not fabricate numbers.

| Role | Junior | Mid | Senior | Lead/Staff |
|---|---|---|---|---|
| Frontend | $2 800–$3 500 | $3 800–$4 800 | $5 500–$7 200 | $7 500–$9 500 |
| Backend | $2 900–$3 600 | $4 000–$5 200 | $5 800–$7 500 | $8 000–$10 000 |
| Fullstack | $3 000–$3 800 | $4 200–$5 500 | $6 000–$7 800 | $8 200–$10 500 |
| Data/ML | $3 200–$4 000 | $4 500–$5 800 | $6 500–$8 500 | $9 000–$12 000 |
| DevOps/SRE | $3 400–$4 200 | $4 800–$6 000 | $6 800–$8 800 | $9 500–$12 500 |
| QA Automation | $2 500–$3 200 | $3 500–$4 500 | $4 800–$6 200 | $6 500–$8 500 |
| PM | $3 000–$3 800 | $4 200–$5 500 | $6 000–$7 500 | $7 800–$10 000 |
| Designer | $2 600–$3 400 | $3 600–$4 600 | $5 000–$6 500 | $6 800–$9 000 |

Regional adjustments vs. LATAM baseline: MX +3–5%, BR +5–8%, AR −5–10%, CO −3–5%, CL +2–4%, PE −5–8%.
Hourly rate = monthly rate / 168.

# Proposal output structure

When producing a proposal, always output ALL sections in this order:

```
## Proposal — [Company Name]
[Industry] · [Country] · Generated [date]

### Summary
1–2 sentences: who the client is, what roles they need, proposed engagement start.

### Roles
| Role | Seniority | Qty | Monthly (USD) | Hourly (USD) | Tech Stack |
|---|---|---|---|---|---|
| ... | ... | ... | $X–$Y | $A–$B | React, Node |

**Total engagement:** $X–$Y/month

### Why Zipdev
2–3 bullets, each grounded in a KB case study or a specific Zipdev differentiator.
Search kb_search for relevant case studies before writing this section.

### Deal context
Stage: [HubSpot stage] · Deal value: $[amount] · Last activity: [date + type]

### Timeline & Next steps
1. Send proposal for review — [suggested date]
2. Discovery call to confirm tech stack — [suggested date]
3. Kickoff if approved — [target start]

### Citations
[^1]: *Document title* — excerpt...
```

# Tone

Confident, concise, no filler. Use active voice. Numbers are better than adjectives. If you do not know something, say so and offer to find it.
$PROMPT$
WHERE slug = 'sales';
```

**Note on objection stats**: The specific statistics (`12% acceptance rate`, `40% travel clause`, `$3k/year`) are removed from the static prompt. Create a KB document `internal/objection-playbook` with the full objection-handling content (the version from the design proposal). The agent will retrieve it via `kb_search` when objection signals are detected (`keywords: expensive, competitor, quality, budget, offshore, onsite, higher than expected`).

**Effort**: S (migration + md update) + M (KB document creation + RAG signal tuning)

---

#### T2.2 — Fix role normalization crash in sales-draft-proposal.ts (CONFIRMED CRASH)
**Description**: `rate.estimate` enforces a strict Zod enum on `role`. The composite passes free-text strings directly, causing `ZodError` on every composite call. Fix with a `normalizeRole()` function and derived `yearsExperience` / `region` mappings.

**Files to modify**:
- `packages/agent-tools/src/composite/sales-draft-proposal.ts`

**Implementation**:
```ts
const ROLE_KEYWORDS: Record<string, string[]> = {
  frontend:  ['react','vue','angular','svelte','css','html','tailwind','next','nuxt','remix','ui','frontend','front-end','front end'],
  backend:   ['node','express','django','rails','spring','laravel','fastapi','postgres','mysql','redis','api','backend','back-end','back end'],
  fullstack: ['fullstack','full-stack','full stack'],
  data:      ['sql','spark','ml','pandas','dbt','airflow','snowflake','bigquery','data engineer','data scientist','analytics'],
  devops:    ['docker','k8s','kubernetes','terraform','ci/cd','github actions','sre','platform','infrastructure','devops'],
  qa:        ['test','qa','cypress','playwright','selenium','jest','quality'],
  pm:        ['scrum','jira','product','roadmap','agile','sprint','pm'],
  designer:  ['figma','sketch','ux','ui design','designer','design system'],
};

const SENIORITY_TO_YEARS: Record<string, number> = {
  junior: 1, mid: 3, senior: 6, lead: 10,
};

const COUNTRY_TO_REGION: Record<string, string> = {
  MX: 'mx', BR: 'br', AR: 'ar', CO: 'co', CL: 'cl', PE: 'pe',
};

function normalizeRole(freeText: string): { role: string; confidence: number } {
  const lower = freeText.toLowerCase();
  // Exact enum match
  const exact = ['frontend','backend','fullstack','data','devops','qa','pm','designer'];
  if (exact.includes(lower)) return { role: lower, confidence: 1.0 };
  // Check fullstack first (both frontend+backend keywords)
  const hasFE = ROLE_KEYWORDS.frontend.some(k => lower.includes(k));
  const hasBE = ROLE_KEYWORDS.backend.some(k => lower.includes(k));
  if (hasFE && hasBE) return { role: 'fullstack', confidence: 0.8 };
  // Keyword match
  for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return { role, confidence: 0.75 };
  }
  // Default
  logger.warn('normalizeRole: no match, defaulting to fullstack', { freeText });
  return { role: 'fullstack', confidence: 0.5 };
}
```

Replace the hardcoded call in the composite:
```ts
// Before (crash):
const rateResult = await runTool('rate.estimate', ctx, {
  role: r.role,           // free text — ZodError
  seniority: r.seniority,
  yearsExperience: 5,     // hardcoded
  region: 'latam',        // hardcoded
  confidence: 0.8,
});

// After:
const { role: normalizedRole, confidence } = normalizeRole(r.role);
const region = COUNTRY_TO_REGION[company.country?.toUpperCase() ?? ''] ?? 'latam';
const yearsExperience = SENIORITY_TO_YEARS[r.seniority] ?? 3;
const rateResult = await runTool('rate.estimate', ctx, {
  role: normalizedRole,
  seniority: r.seniority,
  yearsExperience,
  region,
  confidence,
});
```

**Effort**: S

---

#### T2.3 — Conditional RAG with score threshold
**Description**: Skip RAG for short/acknowledgment messages. Apply 0.65 minimum score threshold. Cap at 3 hits. Add relevance score to injected context. Restrict auto-RAG to `global` and `team:sales` scopes.

**Files to modify**:
- `apps/web/app/api/chat/route.ts`

**Implementation**:
```ts
const ACKNOWLEDGMENT_RE = /^(ok|yes|no|sure|thanks|got it|sounds good|proceed|continue|sí|claro|dale|perfecto|de acuerdo)[.!?]?$/i;

function shouldRunRag(message: string): boolean {
  const wordCount = message.trim().split(/\s+/).length;
  if (wordCount < 8) return false;
  if (ACKNOWLEDGMENT_RE.test(message.trim())) return false;
  return true;
}

// In route handler, replace unconditional RAG:
let contextBlock = '';
if (shouldRunRag(lastUserMessage)) {
  const hits = await kbSearch({
    query: lastUserMessage,
    scopes: ['global', 'team'],
    teamId: agent.teamId,
    limit: 3,
  });
  const relevant = hits.filter(h => h.score >= 0.65);
  if (relevant.length > 0) {
    contextBlock = relevant.map((h, i) =>
      `[^${i + 1}] (relevance: ${h.score.toFixed(2)}) ${h.documentTitle} chunk ${h.chunkIndex}:\n${h.content}`
    ).join('\n\n');
    contextBlock = `<context>\n${contextBlock}\n</context>`;
  }
}
```

**Effort**: S

---

#### T2.4 — Server-side conversation rehydration
**Description**: When `conversationId` is present, load the last 20 messages from DB and merge with client messages. Client messages take precedence (they may include the pending user message not yet saved).

**Files to modify**:
- `apps/web/app/api/chat/route.ts`

**Implementation**:
```ts
let coreMessages = parsed.data.messages;

if (conversationId) {
  try {
    const { data: dbMessages } = await db
      .from('messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (dbMessages && dbMessages.length > 0) {
      const dbSet = new Set(
        dbMessages.map(m => `${m.role}::${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      );
      // Keep client messages not already in DB (i.e., the pending user message)
      const clientOnly = coreMessages.filter(m => {
        const key = `${m.role}::${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
        return !dbSet.has(key);
      });
      // DB messages oldest-first + client-only messages appended
      const merged = [
        ...dbMessages.reverse().map(adaptDbMessage),
        ...clientOnly,
      ];
      coreMessages = merged;
    }
  } catch (err) {
    logger.warn('Failed to load DB messages for rehydration, using client history', { conversationId, err });
  }
}
```

**Effort**: S

---

#### T2.5 — Fix tool list consistency (gsheets.append_row)
**Description**: Add `gsheets.append_row` to the static `salesAgent.allowedTools` and sync both seed files.

**Files to modify**:
- `packages/agents/src/sales/index.ts` — add `'gsheets.append_row'` to `allowedTools`
- `infra/supabase/seed.sql` — add to tool list
- `supabase/seed.sql` — add to tool list

**Effort**: XS

---

#### T2.6 — Add /briefing slash command (replaces proactive auto-briefing)
**Description**: Instead of automatically firing HubSpot lookups on every new conversation, surface deal briefing as an explicit user command. When the user types `/briefing [Company Name]`, pre-fill the textarea with `Fetch a deal health briefing for [Company Name]: search HubSpot for the company, get the most recent deal, list BANT signals present/missing, and summarize last 3 activities.`

**Files to modify**:
- `apps/web/components/chat/InputBar.tsx` — add slash-command detection for `/briefing`
- `apps/web/components/chat/EmptyState.tsx` — add a "Get pipeline briefing" suggestion card

This requires no backend changes. The agent's tool selection guide already covers the HubSpot lookups needed.

**Effort**: XS

---

### Track 3: Tool Expansion

#### T3.1 — Atomic rate limiter (prerequisite for all new tools)
**Description**: Fix the TOCTOU race in `consumeToken()`. This affects all existing tools and is the prerequisite for the external MCP proxy rate limiting in Track 4.

**Files to create**:
- `supabase/migrations/[timestamp]_consume_rate_limit_token.sql`

**Files to modify**:
- `packages/agent-tools/src/rate-limit.ts`

**Migration SQL**:
```sql
CREATE OR REPLACE FUNCTION consume_rate_limit_token(
  p_user_id  uuid,
  p_tool_id  text,
  p_per_minute int
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_allowed boolean;
BEGIN
  INSERT INTO rate_limit_buckets (user_id, tool_id, tokens, refilled_at)
  VALUES (p_user_id, p_tool_id, p_per_minute - 1, now())
  ON CONFLICT (user_id, tool_id) DO UPDATE
    SET tokens = CASE
      WHEN rate_limit_buckets.refilled_at < now() - interval '1 minute'
        THEN p_per_minute - 1
      WHEN rate_limit_buckets.tokens > 0
        THEN rate_limit_buckets.tokens - 1
      ELSE rate_limit_buckets.tokens
    END,
    refilled_at = CASE
      WHEN rate_limit_buckets.refilled_at < now() - interval '1 minute'
        THEN now()
      ELSE rate_limit_buckets.refilled_at
    END
  RETURNING (tokens >= 0) INTO v_allowed;
  -- v_allowed reflects the post-update state; derive from old value:
  -- Re-query to check if the decrement happened
  SELECT tokens >= 0 INTO v_allowed
  FROM rate_limit_buckets
  WHERE user_id = p_user_id AND tool_id = p_tool_id;
  RETURN v_allowed;
END;
$$;
```

**`rate-limit.ts` update**:
```ts
export async function consumeToken(
  db: SupabaseClient,
  userId: string,
  toolId: string,
  perMinute: number,
): Promise<void> {
  try {
    const { data, error } = await db.rpc('consume_rate_limit_token', {
      p_user_id: userId,
      p_tool_id: toolId,
      p_per_minute: perMinute,
    });
    if (error) {
      // Fallback: if RPC function not yet deployed, use legacy non-atomic path
      if (error.message?.includes('function') && error.message?.includes('does not exist')) {
        logger.warn('consume_rate_limit_token RPC not found, using non-atomic fallback', { toolId });
        return consumeTokenLegacy(db, userId, toolId, perMinute);
      }
      throw error;
    }
    if (!data) throw new RateLimitError(toolId);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    logger.error('consumeToken error', { err, toolId });
    // Non-fatal on unexpected errors — allow the call through
  }
}
```

**Effort**: M

---

#### T3.2 — Add HubSpot write scopes to connect flow (DEPLOYMENT BLOCKER)
**Description**: Without this, every write tool throws "Missing hubspot scopes". Must ship before any HubSpot write tool.

**Files to modify**:
- `apps/web/app/api/integrations/hubspot/route.ts`

Add to the `SCOPES` array:
```
crm.objects.contacts.write
crm.objects.deals.write
crm.objects.notes.write
crm.schemas.deals.read
```

This triggers re-authorization for all existing HubSpot-connected users on next use. Add a migration-style note in the PR description. The re-auth is surfaced by the existing `hasScopes` check which returns a clear error message; the UI must show a "Reconnect HubSpot" CTA for this error.

**Effort**: XS

---

#### T3.3 — Shared output formatter module
**Description**: Pure render functions used by all new tools. No I/O, no API calls.

**Files to create**:
- `packages/agent-tools/src/format/index.ts`

```ts
export function renderDealCard(deal: DealOut): string {
  return [
    `**${deal.name}** (${deal.stage})`,
    `Amount: $${deal.amount?.toLocaleString() ?? 'unknown'} · Close: ${deal.closeDate ?? 'TBD'}`,
    `Owner: ${deal.ownerName ?? deal.ownerId ?? 'unassigned'}`,
    deal.htmlLink ? `[View in HubSpot](${deal.htmlLink})` : '',
  ].filter(Boolean).join('\n');
}

export function renderContactCard(contact: ContactOut): string {
  return [
    `**${[contact.firstName, contact.lastName].filter(Boolean).join(' ')}**`,
    contact.email ? `📧 ${contact.email}` : '',
    contact.jobTitle && contact.company ? `${contact.jobTitle} at ${contact.company}` : '',
    contact.lastContacted ? `Last contacted: ${contact.lastContacted}` : '',
  ].filter(Boolean).join('\n');
}

export function renderActivityList(activities: ActivityOut[]): string {
  return activities.map(a =>
    `- **${a.type}** on ${a.date}: ${a.subject}`
  ).join('\n');
}

export function renderPipelineSummary(stages: StageOut[]): string {
  const header = '| Stage | Deals | Total USD | Probability |';
  const divider = '|---|---|---|---|';
  const rows = stages.map(s =>
    `| ${s.label} | ${s.dealCount} | $${(s.totalAmount ?? 0).toLocaleString()} | ${Math.round((s.probability ?? 0) * 100)}% |`
  );
  return [header, divider, ...rows].join('\n');
}

export function renderThreadSummary(thread: ThreadOut): string {
  return `**${thread.subject}** (${thread.messageCount} messages · ${thread.date})\nFrom: ${thread.from} → To: ${thread.to}\n${thread.snippet}`;
}
```

**Effort**: S

---

#### T3.4 — hubspot.search_contacts (new tool)
**Files to create**: `packages/agent-tools/src/hubspot/search-contacts.ts`  
**Files to modify**: `packages/agent-tools/src/hubspot/index.ts`

```ts
const inputSchema = z.object({
  query: z.string().min(1).describe('Name, email, or partial name to search for'),
  companyId: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(10),
});

const outputSchema = z.object({
  results: z.array(ContactOutSchema),
  markdown: z.string(),
});

export const searchContactsTool: ToolDef<typeof inputSchema, typeof outputSchema> = {
  id: 'hubspot.search_contacts',
  displayName: 'Search HubSpot Contacts',
  icon: 'Users',
  category: 'hubspot',
  description: 'Search HubSpot contacts by name or email. Use before create_contact to avoid duplicates.',
  requiresConfirmation: false,
  rateLimit: { perMinute: 30 },
  inputSchema,
  outputSchema,
  async execute(input, ctx) {
    const token = await ctx.integrations.getAccessToken('hubspot');
    const filterGroups = input.query.includes('@')
      ? [{ filters: [{ propertyName: 'email', operator: 'EQ', value: input.query }] }]
      : [
          { filters: [{ propertyName: 'firstname', operator: 'CONTAINS_TOKEN', value: input.query }] },
          { filters: [{ propertyName: 'lastname', operator: 'CONTAINS_TOKEN', value: input.query }] },
        ];
    const res = await hubspotPost(token, '/crm/v3/objects/contacts/search', {
      filterGroups,
      properties: ['firstname','lastname','email','phone','company','jobtitle','hubspot_owner_id','hs_lastcontacted'],
      limit: input.limit,
    });
    const results = res.results.map(adaptContact);
    return { results, markdown: results.map(renderContactCard).join('\n\n') };
  },
};
```

**`requiredScopes`**: `crm.objects.contacts.read`  
**Effort**: S

---

#### T3.5 — hubspot.get_contact (new tool)
**Files to create**: `packages/agent-tools/src/hubspot/get-contact.ts`  
**Files to modify**: `packages/agent-tools/src/hubspot/index.ts`

```ts
const inputSchema = z.object({
  id: z.string().describe('HubSpot contact ID'),
});

// GET /crm/v3/objects/contacts/{id}
// ?properties=firstname,lastname,email,phone,company,jobtitle,hubspot_owner_id,hs_lastcontacted,lifecyclestage
// &associations=companies,deals
```

Returns `ContactDetail` (full ContactOut + `lifecycleStage`, `companyIds: string[]`, `dealIds: string[]`) + `markdown` from `renderContactCard()`.

**`requiredScopes`**: `crm.objects.contacts.read`, `crm.objects.companies.read`  
**`rateLimit`**: 60/min  
**Effort**: S

---

#### T3.6 — hubspot.create_deal (new write tool)
**Files to create**: `packages/agent-tools/src/hubspot/create-deal.ts`  
**Files to modify**: `packages/agent-tools/src/hubspot/index.ts`

```ts
const inputSchema = z.object({
  dealname: z.string().min(1),
  pipeline: z.string().default('default'),
  dealstage: z.string().describe('Use hubspot_get_pipeline_summary to get valid stage IDs'),
  amount: z.number().optional(),
  closedate: z.string().optional().describe('ISO date string YYYY-MM-DD'),
  companyId: z.string().optional(),
  contactId: z.string().optional(),
  ownerId: z.string().optional(),
});

// POST /crm/v3/objects/deals
// If companyId: POST /crm/v4/associations/deals/{dealId}/companies/batch/create
// If contactId: POST /crm/v4/associations/deals/{dealId}/contacts/batch/create
```

**Note on association API**: Use HubSpot v4 path (`/crm/v4/associations/{fromObjectType}/{fromObjectId}/batch/create`), not the deprecated v3 path.

`htmlLink`: Requires `portalId`. Fetch once via `GET /oauth/v1/access-tokens/{token}` which returns `hub_id`. Cache in `ToolContext` or store during OAuth callback in the `integrations` table as `extra_data.portal_id`.

**`requiresConfirmation`**: true  
**`requiredScopes`**: `crm.objects.deals.write`  
**`rateLimit`**: 20/min  
**Effort**: M

---

#### T3.7 — hubspot.update_deal (new write tool)
**Files to create**: `packages/agent-tools/src/hubspot/update-deal.ts`  
**Files to modify**: `packages/agent-tools/src/hubspot/index.ts`

```ts
const inputSchema = z.object({
  id: z.string(),
  dealstage: z.string().optional(),
  amount: z.number().optional(),
  closedate: z.string().optional(),
  ownerId: z.string().optional(),
  description: z.string().optional(),
}).refine(
  data => Object.values(data).filter((v, i) => i > 0 && v !== undefined).length > 0,
  { message: 'At least one field to update must be provided' }
);

// PATCH /crm/v3/objects/deals/{id}
```

Returns updated `DealOut` + `markdown` from `renderDealCard()`.

**`requiresConfirmation`**: true  
**`rateLimit`**: 30/min  
**Effort**: S

---

#### T3.8 — hubspot.create_contact (new write tool)
**Files to create**: `packages/agent-tools/src/hubspot/create-contact.ts`  
**Files to modify**: `packages/agent-tools/src/hubspot/index.ts`

```ts
const inputSchema = z.object({
  email: z.string().email(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phone: z.string().optional(),
  jobTitle: z.string().optional(),
  companyId: z.string().optional(),
  ownerId: z.string().optional(),
});

// POST /crm/v3/objects/contacts
// If companyId: POST /crm/v4/associations/contacts/{contactId}/companies/batch/create
```

Description must note: "Call hubspot_search_contacts first to avoid duplicates — HubSpot throws 409 if the email already exists."

**`requiresConfirmation`**: true  
**`rateLimit`**: 20/min  
**Effort**: S

---

#### T3.9 — hubspot.log_activity (new write tool)
**Files to create**: `packages/agent-tools/src/hubspot/log-activity.ts`  
**Files to modify**: `packages/agent-tools/src/hubspot/index.ts`

```ts
const inputSchema = z.object({
  type: z.enum(['call', 'note', 'meeting']),
  subject: z.string().min(1),
  body: z.string().optional(),
  associatedObjectType: z.enum(['contact', 'company']),
  associatedObjectId: z.string(),
  durationMs: z.number().int().optional().describe('For calls only'),
  meetingStartTime: z.string().optional().describe('ISO datetime for meetings'),
});

// POST /crm/v3/objects/calls  (or /notes, /meetings)
// Then POST /crm/v4/associations/{type}s/{activityId}/{objectType}s/batch/create
```

**`requiresConfirmation`**: true  
**`requiredScopes`**: `crm.objects.notes.write`  
**`rateLimit`**: 20/min  
**Effort**: M

---

#### T3.10 — hubspot.get_pipeline_summary (new tool)
**Files to create**: `packages/agent-tools/src/hubspot/get-pipeline-summary.ts`  
**Files to modify**: `packages/agent-tools/src/hubspot/index.ts`

```ts
const inputSchema = z.object({
  pipelineId: z.string().default('default'),
});

// GET /crm/v3/pipelines/deals/{pipelineId}   → stage definitions
// POST /crm/v3/objects/deals/search (paginated, 200/page max, cursor via 'after')
// Client-side aggregate: group by dealstage → count + sum amount
```

**Pagination**: HubSpot search returns max 200 per page. Iterate via the `paging.next.after` cursor up to 10 pages (2000 deals). Document the 2000-deal limit in the description.

**`requiredScopes`**: `crm.objects.deals.read`, `crm.schemas.deals.read`  
**`rateLimit`**: 10/min (up to 12 API calls per invocation)  
**Effort**: M

---

#### T3.11 — hubspot.get_contact_timeline (new tool)
**Files to create**: `packages/agent-tools/src/hubspot/get-contact-timeline.ts`  
**Files to modify**: `packages/agent-tools/src/hubspot/index.ts`

```ts
const inputSchema = z.object({
  contactId: z.string(),
  days: z.number().int().min(1).max(365).default(90),
  limit: z.number().int().min(1).max(50).default(20),
});

// 5 PARALLEL fetches via Promise.all (not sequential):
// /crm/v3/objects/calls/search    filter: associations.contact EQ contactId, createdate GT cutoff
// /crm/v3/objects/notes/search    same
// /crm/v3/objects/meetings/search same
// /crm/v3/objects/tasks/search    same
// /crm/v3/objects/emails/search   same (sales-email-read scope)
// Merge-sort by createdAt DESC, slice to limit
```

**`requiredScopes`**: `crm.objects.contacts.read`, `sales-email-read`  
**`rateLimit`**: 10/min  
**Effort**: M

---

#### T3.12 — hubspot.search_companies domain-search fix + markdown
**Files to modify**: `packages/agent-tools/src/hubspot/search-companies.ts`

Fix: when `input.query` contains `.`, send two `filterGroups` (CONTAINS_TOKEN on `name` OR EQ on `domain`). Add `markdown: z.string().optional()` to output schema populated by `renderCompanyCard()`.

**Effort**: S

---

#### T3.13 — gmail.send_draft (new write tool)
**Files to create**: `packages/agent-tools/src/gmail/send-draft.ts`  
**Files to modify**: `packages/agent-tools/src/gmail/index.ts`

```ts
const inputSchema = z.object({
  draftId: z.string().describe('ID returned by gmail_draft'),
});

// POST https://gmail.googleapis.com/gmail/v1/users/me/drafts/send
// Body: { id: draftId }
```

**No new OAuth scope needed** — `gmail.compose` (already granted to all users) covers sending drafts.

The confirmation payload must include a pre-flight fetch of draft metadata (GET `/gmail/v1/users/me/drafts/{draftId}`) to display `to`, `subject`, and a snippet in the `ConfirmationPrompt` — not just the raw `draftId`.

**`requiresConfirmation`**: true  
**`rateLimit`**: 10/min  
**Effort**: S

---

#### T3.14 — gmail.list_threads (new tool, parallelized)
**Files to create**: `packages/agent-tools/src/gmail/list-threads.ts`  
**Files to modify**: `packages/agent-tools/src/gmail/index.ts`

```ts
const inputSchema = z.object({
  contactEmail: z.string().email().optional(),
  query: z.string().optional(),
  maxResults: z.number().int().min(1).max(20).default(10),
}).refine(data => data.contactEmail || data.query, {
  message: 'Provide either contactEmail or query',
});

// Step 1: GET /gmail/v1/users/me/threads?q={...}&maxResults={maxResults}
// Step 2: Promise.all — fetch all thread metadata in parallel
// format=metadata&metadataHeaders=Subject,From,To,Date
```

**`requiredScopes`**: `gmail.readonly`  
**`rateLimit`**: 20/min  
**Effort**: S

---

#### T3.15 — gcal.create_event timezone fix
**Files to modify**: `packages/agent-tools/src/gcal/create-event.ts`

Add `timeZone: z.string().default('America/Mexico_City')` to input schema. Change `start: { dateTime: input.start }` to `start: { dateTime: input.start, timeZone: input.timeZone }` (same for `end`).

**Effort**: XS

---

#### T3.16 — Google Drive module (search_files + read_doc)
**Files to create**:
- `packages/agent-tools/src/gdrive/client.ts`
- `packages/agent-tools/src/gdrive/search-files.ts`
- `packages/agent-tools/src/gdrive/read-doc.ts`
- `packages/agent-tools/src/gdrive/index.ts`

**Files to modify**: `packages/agent-tools/src/index.ts`

**`search-files` schema**:
```ts
const inputSchema = z.object({
  query: z.string().min(1),
  mimeType: z.string().optional().describe(
    'e.g. application/vnd.google-apps.document for Docs, application/vnd.google-apps.spreadsheet for Sheets'
  ),
  limit: z.number().int().min(1).max(30).default(10),
});
// GET /drive/v3/files?q={encoded}&fields=files(id,name,mimeType,webViewLink,modifiedTime,owners)
```

**`read-doc` schema**:
```ts
const inputSchema = z.object({
  fileId: z.string(),
  maxChars: z.number().int().min(100).max(50000).default(10000),
});
// GET /drive/v3/files/{fileId}/export?mimeType=text/plain  (Google Docs)
// Falls back to GET /drive/v3/files/{fileId}?alt=media     (other file types)
// Truncates to maxChars with appended notice
```

**No new OAuth scope needed** — `drive.readonly` is already in `ALL_SCOPES` in the Google connect flow.

**Effort**: M

---

#### T3.17 — web.search (Tavily)
**Files to create**:
- `packages/agent-tools/src/web/search.ts`
- `packages/agent-tools/src/web/index.ts`

**Files to modify**: `packages/agent-tools/src/index.ts`

```ts
const inputSchema = z.object({
  query: z.string().min(1),
  searchDepth: z.enum(['basic', 'advanced']).default('basic'),
  maxResults: z.number().int().min(1).max(10).default(5),
  includeAnswer: z.boolean().default(true),
});

// Reads process.env.TAVILY_API_KEY
// Throws IntegrationError('TAVILY_API_KEY not configured', 'web') if absent
// POST https://api.tavily.com/search
```

**Wrangler binding** (add to `apps/mcp/wrangler.toml`):
```toml
[vars]
TAVILY_API_KEY = ""  # set via wrangler secret put TAVILY_API_KEY
```

**`rateLimit`**: 10/min  
**Effort**: S

---

#### T3.18 — web.scrape (Firecrawl / Jina fallback)
**Files to create**: `packages/agent-tools/src/web/scrape.ts`  
**Files to modify**: `packages/agent-tools/src/web/index.ts`, `packages/agent-tools/src/index.ts`

```ts
const inputSchema = z.object({
  url: z.string().url(),
  maxChars: z.number().int().min(500).max(20000).default(5000),
});

// SSRF guard (same isPrivateUrl from external-mcp.ts):
if (isPrivateUrl(input.url)) throw new IntegrationError('URL not allowed', 'web');
// LinkedIn guard:
if (new URL(input.url).hostname.includes('linkedin.com')) {
  throw new IntegrationError('LinkedIn URLs return a login wall — use web_search with the person\'s name instead', 'web');
}

// If FIRECRAWL_API_KEY set:
//   POST https://api.firecrawl.dev/v0/scrape { url, pageOptions: { onlyMainContent: true } }
// Else:
//   GET https://r.jina.ai/{encodeURIComponent(url)}
```

**Wrangler binding** (add to `apps/mcp/wrangler.toml`):
```toml
FIRECRAWL_API_KEY = ""  # optional; Jina Reader is no-key fallback
```

**`rateLimit`**: 10/min  
**Effort**: M

---

#### T3.19 — rate.estimate role enum expansion
**Files to modify**:
- `packages/agent-tools/src/rate/estimate.ts`
- `packages/agent-tools/src/rate/estimate-from-document.ts`

Expand role enum:
```ts
z.enum([
  'frontend','backend','fullstack','data','devops','qa','pm','designer',
  // New:
  'mobile','ml_engineer','security','sre','technical_writer','product_analyst',
  'other',  // requires openRole field
])
```

Add `openRole: z.string().optional()` field. When `role === 'other'`, `openRole` is required (`.refine()`). Map `openRole` to nearest canonical role via the `normalizeRole()` function from T2.2 (extract it to a shared utility). Return the canonical role used in `notes` field.

Update `estimate-from-document.ts` heuristics to match new roles and handle `'full-stack'`, `'sr.'`, `'jr.'`, `'principal'` variants.

**Effort**: M

---

#### T3.20 — Phased allowedTools update for sales agent
**Description**: Ship new tools in three PRs to keep the active tool set under 20 at each phase.

**Phase A** (with T3.17-T3.18 web tools):
```ts
// Add to allowedTools:
'web.search', 'web.scrape', 'gdrive.search_files', 'gdrive.read_doc'
```

**Phase B** (with T3.4-T3.5 HubSpot read tools):
```ts
// Add to allowedTools:
'hubspot.search_contacts', 'hubspot.get_contact', 'hubspot.get_pipeline_summary',
'hubspot.get_contact_timeline'
```

**Phase C** (after T3.2 scope update + user re-auth window):
```ts
// Add to allowedTools:
'hubspot.create_deal', 'hubspot.update_deal', 'hubspot.create_contact',
'hubspot.log_activity', 'gmail.send_draft', 'gmail.list_threads'
```

**Files to modify**: `packages/agents/src/sales/index.ts` (three PRs)  
**Effort**: XS per phase

---

#### T3.21 — ProposalCard frontend component
**Description**: Structured React component for `sales_draft_proposal` tool results. **Prerequisite**: T2.2 composite hardening must ship first so the structured fields are complete (hourly rate, deal context, Why Zipdev section).

**Files to create**:
- `apps/web/components/chat/ProposalCard.tsx`

**Files to modify**:
- `apps/web/components/chat/MessageBubble.tsx` — detect `toolName === 'sales_draft_proposal'` in tool result messages and render `ProposalCard` instead of markdown

**`ProposalCard` sections**:
- Header: company name + industry badge + country
- Sortable rate table: role / seniority / qty / monthly / hourly / tech stack + total row
- Collapsible "Why Zipdev" section (bullets from KB hits)
- Deal context banner (stage + amount + days-since-last-activity pill: green <14d, yellow 14-30d, red >30d)
- Timeline section
- "Copy as Markdown" button

**Effort**: L

---

### Track 4: Dynamic MCP

#### T4.1 — DB migration: user_mcp_servers + user_mcp_tools + key_version
**Files to create**: `infra/supabase/migrations/0017_user_mcp_servers.sql`

```sql
-- user_mcp_servers
CREATE TABLE public.user_mcp_servers (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name                 text        NOT NULL CHECK(length(name) <= 60),
  url                  text        NOT NULL CHECK(length(url) <= 512),
  auth_type            text        NOT NULL CHECK(auth_type IN ('none','bearer','api_key')),
  auth_value_encrypted text,       -- NULL when auth_type='none'; encrypted via encryptToken()
  key_version          smallint    NOT NULL DEFAULT 1,  -- for future key rotation
  enabled              bool        NOT NULL DEFAULT true,
  trusted              bool        NOT NULL DEFAULT false, -- auto-approve tool calls without confirmation
  last_checked_at      timestamptz,
  last_error           text,
  tool_count           int         NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_mcp_servers_user_idx         ON public.user_mcp_servers(user_id);
CREATE INDEX user_mcp_servers_user_enabled_idx ON public.user_mcp_servers(user_id, enabled);

-- user_mcp_tools
CREATE TABLE public.user_mcp_tools (
  server_id          uuid    NOT NULL REFERENCES public.user_mcp_servers(id) ON DELETE CASCADE,
  tool_name          text    NOT NULL CHECK(length(tool_name) <= 64),
  tool_description   text    CHECK(length(tool_description) <= 1000),
  input_schema_json  jsonb   NOT NULL,
  cached_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, tool_name)
);

CREATE INDEX user_mcp_tools_server_idx ON public.user_mcp_tools(server_id);

-- RLS: enabled but access is service-role only (auth.uid() returns NULL for service-role)
-- These policies are inert; all real access goes through the service-role client.
ALTER TABLE public.user_mcp_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_mcp_tools   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_select" ON public.user_mcp_servers
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "owner_insert" ON public.user_mcp_servers
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "owner_update" ON public.user_mcp_servers
  FOR UPDATE USING (auth.uid() = user_id);
```

**Effort**: S

---

#### T4.2 — Shared external-mcp module
**Files to create**: `packages/agent-tools/src/external-mcp.ts`

**`isPrivateUrl(url: string): boolean`**:
```ts
const PRIVATE_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,    // AWS/GCP metadata
  /^::1$/,
  /^fd[0-9a-f]{2}:/i,  // IPv6 ULA
  /^fe80:/i,            // IPv6 link-local
];

export function isPrivateUrl(rawUrl: string): boolean {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return true; } // malformed = block
  if (!['http:', 'https:'].includes(parsed.protocol)) return true;
  if (parsed.username || parsed.password) return true; // credentials in URL
  const host = parsed.hostname;
  return PRIVATE_PATTERNS.some(p => p.test(host));
}
```

**Node-path DNS resolution check** (used in `apps/web/app/api/chat/route.ts` only, not Workers):
```ts
// In route.ts, before callExternalTool:
import { promises as dns } from 'dns';
async function assertNotPrivateResolved(hostname: string): Promise<void> {
  const [ipv4, ipv6] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);
  const allIps = [
    ...(ipv4.status === 'fulfilled' ? ipv4.value : []),
    ...(ipv6.status === 'fulfilled' ? ipv6.value : []),
  ];
  for (const ip of allIps) {
    if (isPrivateUrl(`http://${ip}`)) {
      throw new Error(`SSRF blocked: ${hostname} resolves to private IP ${ip}`);
    }
  }
}
```

**`fetchExternalToolManifest`**: Two-strategy fetch (Streamable HTTP first, SSE+POST fallback). `AbortSignal.timeout(15_000)`. Sanitize descriptions: cap at 1000 chars, strip `<`, `>`, null bytes. Cap tool names at 64 chars.

**`callExternalTool`**: Full proxy with audit (pending row before call, final status in `finally`), rate limit via `consumeToken`, `AbortSignal.timeout(10_000)` on POST phase, separate 2-3s timeout on SSE GET phase.

**Namespace**: `'mcp_' + server.id.replace(/-/g, '').slice(0, 16) + '_' + toolName` (16-char hex prefix, no hyphens, negligible collision probability).

**`fetchEnabledExternalTools`**: Returns cached rows immediately. Triggers `void syncExternalServerManifest(...)` if `last_checked_at < now - 1h` — strictly non-blocking.

**`syncExternalServerManifest`**: Hard 5s total timeout. On success: DELETE old tool rows, INSERT new batch, update `tool_count` and `last_checked_at`. On failure: write `last_error`, do not throw. Enforce 50-tool limit across all user servers.

**Files to modify**: `packages/agent-tools/src/index.ts` — export the four public functions.

**Effort**: L

---

#### T4.3 — Fix bridge.ts tool-name lookup (correctness fix)
**Files to modify**: `apps/mcp/src/bridge.ts`

Replace the fragile `toolName.replace('_', '.')` single-replace with a lookup map:
```ts
// Build at the start of callTool:
const builtinMap = new Map(
  getAgentTools(agent).map(t => [t.id.replaceAll('.', '_'), t.id])
);

// In built-in dispatch:
const builtinId = builtinMap.get(toolName);
if (builtinId) {
  return runBuiltinTool(builtinId, input, ctx);
}
// External tool dispatch:
if (toolName.startsWith('mcp_')) {
  return dispatchExternalTool(toolName, input, ctx);
}
throw new Error(`Unknown tool: ${toolName}`);
```

**Effort**: S

---

#### T4.4 — bridge.ts + mcp-server.ts: Worker aggregation
**Files to modify**:
- `apps/mcp/src/bridge.ts`
- `apps/mcp/src/mcp-server.ts`

Extend `listToolsForAuth` to return `{ builtins: AnyTool[], externals: ExternalEntry[] }`.

In `mcp-server.ts` `ListToolsRequestSchema` handler: map built-ins as before (`t.id.replaceAll('.','_')`), map externals with pre-computed `sdkName` (`'mcp_' + server.id.replace(/-/g,'').slice(0,16) + '_' + t.tool_name`) and cached `inputSchema` (already JSON Schema, pass directly).

Store `externalToolMap: Map<sdkName, {server, originalName}>` on `BridgeContext`.

**Confirmation gate consistency**: External tools routed through the Worker also default to `requiresConfirmation = true` unless `server.trusted === true`. Use the same `isError: true` + `__confirmation_required` JSON sentinel pattern already in `mcp-server.ts`.

**Effort**: M

---

#### T4.5 — Web chat route: inject external tools
**Files to modify**: `apps/web/app/api/chat/route.ts`

```ts
// After filterTools(agent.allowedTools):
const externalServers = await fetchEnabledExternalTools(db, user.id);
const externalToolMap = new Map<string, { server: UserMcpServer; originalName: string }>();

for (const { server, tools } of externalServers) {
  for (const t of tools) {
    const sdkName = 'mcp_' + server.id.replace(/-/g, '').slice(0, 16) + '_' + t.tool_name;
    externalToolMap.set(sdkName, { server, originalName: t.tool_name });
    aiTools[sdkName] = tool({
      description: t.tool_description ?? '',
      parameters: jsonSchema(t.input_schema_json as JSONSchema7),
      execute: async (args, { abortSignal }) => {
        if (!server.trusted) {
          // Surface confirmation required — same pattern as built-in confirmation
          return { __requires_confirmation: true, toolId: sdkName, input: args };
        }
        // DNS check for Node path
        await assertNotPrivateResolved(new URL(server.url).hostname);
        return callExternalTool(server, t.tool_name, args, { ...toolCtx, signal: abortSignal });
      },
    });
  }
}
```

**Effort**: M

---

#### T4.6 — Web API routes: CRUD for user_mcp_servers
**Files to create**:
- `apps/web/app/api/mcp-servers/route.ts` — `GET` (list) + `POST` (create)
- `apps/web/app/api/mcp-servers/[id]/route.ts` — `PATCH` (update) + `DELETE`
- `apps/web/app/api/mcp-servers/[id]/refresh/route.ts` — `POST` (re-sync manifest)

**POST `/api/mcp-servers`**:
1. Validate body `{ name, url, authType, authValue? }`.
2. `isPrivateUrl(url)` → 422 if blocked.
3. Count existing servers for user → 422 if ≥ 5.
4. Encrypt `authValue` with `encryptToken` if provided.
5. INSERT into `user_mcp_servers`.
6. `void syncExternalServerManifest(db, userId, newId)` — fire-and-forget.
7. Return `{ id, toolCount: 0, warning? }`.

**GET `/api/mcp-servers`**: Return server list with `auth_value_encrypted` omitted. Return `authConfigured: boolean` instead.

**DELETE `/[id]`**: Verify ownership (SELECT WHERE `id AND user_id`). DELETE (cascade deletes tools). 204.

**PATCH `/[id]`**: Allow updating `name`, `enabled`, `trusted`, `url`, `authType`, `authValue`. Re-encrypt on `authValue` change. Return updated row.

**POST `/[id]/refresh`**: Verify ownership. Call `syncExternalServerManifest(db, userId, serverId)`. Return `{ tools: [{name, description}], toolCount, lastError }`.

All routes: `requireSession()` + service-role client.

**Effort**: M

---

#### T4.7 — Web UI: External MCP Servers section on /integrations
**Files to modify**: `apps/web/app/(app)/integrations/page.tsx`

**Files to create**: `apps/web/app/(app)/integrations/_components/AddMcpServerForm.tsx`

Add "External MCP Servers" section below the existing HubSpot section. Server-rendered list of registered servers. Per-server row: name, URL (truncated), auth type badge, enabled toggle, trusted toggle (with explicit security label "Allows Claude to call this server without confirmation"), tool count chip, last error warning, Refresh button, Delete button, expandable tool list.

`AddMcpServerForm`: name, SSE URL, auth type radio (none / bearer / api_key), optional token input (`type="password"`). On submit: POST `/api/mcp-servers`, then show tool preview from refresh response. `router.refresh()` to re-render.

Show "Max 5 servers reached" notice and disable the Add form at capacity. Show "50 tools total limit reached" notice if at the tool cap.

**Effort**: M

---

## Sequencing

### Critical Path

```
T3.1 (atomic rate limiter migration)
  → T4.1 (MCP DB migration)
  → T4.2 (external-mcp.ts shared module)
  → T4.3 (bridge.ts fix)
  → T4.4 (Worker aggregation)
  → T4.5 (web chat injection)
  → T4.6 (CRUD API routes)
  → T4.7 (UI)
```

Track 4 cannot start until T3.1 is deployed (the atomic rate limiter is a hard dependency for the proxy middleware). T4.1–T4.2 can proceed in parallel once T3.1 is in.

Track 2 bugs (T2.1–T2.5) are independent of everything else and can ship immediately. T2.1 (system prompt migration) is the single highest-leverage task in the entire spec and should be the first merge.

### Parallel execution for a team (4 engineers)

| Engineer | Tasks |
|---|---|
| Eng 1 | T2.1 → T2.2 → T2.3 → T2.4 → T2.5 → T2.6 (all Track 2) |
| Eng 2 | T1.1 → T1.2 → T1.3 → T1.4 → T1.5 → T1.6 (Track 1, high-priority group) |
| Eng 3 | T3.1 → T3.2 → T3.3 → T3.4–T3.12 (Track 3, infra + HubSpot) |
| Eng 4 | T3.13–T3.18 (Track 3, Gmail/Drive/Web) → start T4.1 after T3.1 merges |

After the first sprint (2 weeks): Eng 1 and Eng 2 join Track 4. Eng 3 handles T3.19–T3.21 and phased `allowedTools` updates.

### Solo developer order

1. **Week 1**: T2.1 (system prompt), T2.2 (crash fix), T2.3 (conditional RAG), T2.4 (rehydration), T2.5 (gsheets tool sync)
2. **Week 2**: T1.1 (markdown), T1.2 (scroll), T1.3 (sidebar), T1.4 (empty state)
3. **Week 3**: T3.1 (atomic rate limiter), T3.2 (HubSpot scopes), T3.3 (formatter), T3.4–T3.5 (contact read tools), T3.12 (company search fix)
4. **Week 4**: T1.5–T1.6 (tool card + confirmation), T1.7–T1.8 (input bar + mobile), T1.9 (chat root fixes)
5. **Week 5**: T3.6–T3.9 (HubSpot write tools + scope re-auth), T3.13–T3.14 (gmail tools)
6. **Week 6**: T3.15–T3.18 (gcal fix + Drive + web tools), T3.19–T3.20 (rate enum + phased allowedTools)
7. **Week 7-8**: T4.1–T4.7 (full Dynamic MCP track)
8. **Week 9**: T1.10–T1.12 (command palette, message actions, title auto-gen), T3.21 (ProposalCard — after T2.2 composite hardening is stable)

---

## What's Explicitly OUT of Scope for v2

**Multi-agent architecture** (Research/Proposal/Follow-up sub-agents): Sub-agents have no capabilities the main agent lacks. Routing adds an extra inference call and a new failure mode. Prompt-level tool-selection guidance achieves the same focus. Revisit in v3 if the main agent demonstrates coordination limits at scale.

**Per-conversation rolling summaries**: Server-side rehydration of the last 20 DB messages (T2.4) covers the use case. Rolling summaries add a new DB schema, a background model call, a conditional injection path, and a failure counter column for marginal value over rehydration. Revisit if real sessions demonstrate the 20-message window is insufficient.

**Proactive auto deal health briefing on conversation start**: Replaced by explicit `/briefing [Company]` slash command (T2.6). The automatic behavior adds 800ms first-message latency on every new conversation using a heuristic proper-noun detector that will misfire. Slash command delivers the same value on demand.

**Citations (CitationFootnote wiring)**: The component exists and renders safely. The backend must emit structured `streamText` annotation events via `onChunk` before the UI wiring is meaningful. That is a separate backend sprint not scoped here.

**File-on-first-message**: `/api/chat/route.ts` is a `req.json()` endpoint. Rewriting it for `multipart/form-data` requires a parallel KB ingestion pipeline change. Users create a conversation via first text message, then attach files via `FileDropZone`. Not a regression.

**Message feedback (thumbs up/down) + Log-to-CRM button**: Requires a new `message_feedback` table and two new API routes. Deferred. Message actions row (T1.11) ships Copy + Regenerate only.

**Pinned conversations**: The schema change (`pinned boolean`) is included in T1.3 to avoid a second migration, but the pin UI (star icon, pin action) is not implemented. The sidebar query orders by `pinned DESC, updated_at DESC` to be forward-compatible.

**smoothStream() server-side transform**: The integration pattern with `toDataStreamResponse` is non-trivial per the review. The streaming cursor (CSS `after:content-['▋'] after:animate-pulse`) achieves the visual goal without server-side transform risk.

**Slack integration**: No Slack MCP or tool is scoped for v2. Dynamic MCP (Track 4) enables users to connect a Slack MCP server themselves if one exists.

**LinkedIn integration**: LinkedIn returns login walls on scraping. `web.scrape` explicitly blocks LinkedIn URLs with a clear error. LinkedIn read access via official API requires a separate OAuth application. Out of scope.

**Document generation (Google Docs / PDF export)**: Proposals are generated as Markdown. A tool that writes to Google Docs and returns a shareable URL is a natural v3 addition once the proposal format stabilizes.

**OAuth2 external MCP servers**: Track 4 covers static bearer/API key auth only. OAuth2 authorization code flow (GitHub MCP, Google-scoped MCPs) requires a callback route, token storage, and refresh logic. Users are restricted to servers accepting static tokens (Notion, Linear personal tokens, self-hosted servers) for v2.

**HubSpot pipeline/owner lookup by human-readable name**: `get_pipeline_summary` (T3.10) returns stage IDs and labels, enabling the agent to translate. A dedicated `list_owners` tool is not scoped but can be added in a follow-up.

**Ctrl+N keyboard shortcut**: Browser-reserved (new window) in Chrome/Firefox/Edge. Cannot be intercepted by `window.addEventListener`. Explicitly omitted from `useGlobalHotkeys`.

**`swr` package**: Not added. All data fetching uses existing `@tanstack/react-query`.

**`provider: string` broadening in types.ts**: The `REFRESHERS` map in `integrations.ts` uses `'google' | 'hubspot'` as a `Record` key; widening to `string` turns `REFRESHERS[provider]` into `RefreshFn | undefined` and breaks strict TypeScript. Deferred until a third OAuth provider is actually being added.