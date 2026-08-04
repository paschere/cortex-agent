-- Retire five tool families, and finish archiving the two agents built on them.
--
-- WHY. The product narrowed. Five families were removed from the code in the
-- same change that ships this migration:
--
--   rate.*      the rate estimator
--   apollo.*    the prospecting database
--   recruit.*   the in-house recruiting/matching tools
--   workable.*  the external ATS
--   bamboo.*    the HR system of record (roster, time off, pay and bill rates)
--
-- Deleting the code is most of the job, because `filterTools` can only hand the
-- model tools that are actually in the registry — a grant for a family that no
-- longer exists resolves to nothing. But the database still carries three kinds
-- of residue that the registry does not clean up on its own, and each one is a
-- different flavour of lie:
--
--   1. GRANTS. `agents.allowed_tool_ids` and `team_tool_permissions` list
--      patterns for families that are gone. Harmless at runtime, but the /tools
--      catalogue and the permissions UI read these columns directly and would
--      keep drawing rows for tools nobody can call.
--
--   2. PROMPTS. This is the one that actually misbehaves. `agents.system_prompt`
--      is what the chat and MCP runtimes execute, and Cortex's prompt promises
--      four fronts, two of which no longer exist: it tells the model it can
--      quote rates and score candidates. A model that believes it can do
--      something will offer to do it, try, fail to find the tool, and then
--      either apologise or — worse — answer from memory. A prompt that
--      overstates the toolset is a hallucination generator.
--
--   3. AGENTS. `sales` and `recruiting` were built around exactly these
--      families. Migration 0037 already archived them; this migration re-asserts
--      it (0037 is not re-run on an existing database, and nothing stops an
--      admin having flipped a row back) and makes cortex the only active agent.
--
-- Cortex's own grant is `array['*']` (migration 0050) and needs no change:
-- `matchPattern` in packages/agent-tools/src/registry.ts resolves '*' against
-- the live registry, so the retired families dropped out of it the moment the
-- code was deleted. The archived agents' explicit lists ARE edited, so the
-- record of what they could reach stays truthful rather than aspirational.
--
-- NOTHING IS DELETED. No agent row, no conversation, no audit event. Archived
-- agents keep their ids, so `conversations.agent_id` (ON DELETE RESTRICT) still
-- resolves and every historical thread stays readable.
--
-- Idempotent throughout: array subtraction converges, the prompt is restated in
-- one piece keyed on a stable slug, and every guard is a no-op on a database
-- that has already been converged.

-- ---------------------------------------------------------------------------
-- 1. Tool grants
-- ---------------------------------------------------------------------------
-- Both the family wildcard ('recruit.*') and any exact id ('recruit.get_candidate')
-- are swept, because 0015/0020/0021 seeded explicit ids while 0027/0029/0030
-- appended wildcards. `array(select ...)` rebuilds the column from what survives
-- the filter, which makes re-running the statement a no-op.

update public.agents
set allowed_tool_ids = array(
  select t
  from unnest(allowed_tool_ids) as t
  where t !~ '^(rate|apollo|recruit|workable|bamboo)\.'
)
where exists (
  select 1 from unnest(allowed_tool_ids) as t
  where t ~ '^(rate|apollo|recruit|workable|bamboo)\.'
);

-- Team deny-list rules (0038). A rule denying a tool that no longer exists is
-- dead weight in the permissions UI, which renders one row per rule.
delete from public.team_tool_permissions
where tool_pattern ~ '^(rate|apollo|recruit|workable|bamboo)\.';

-- `user_tool_overrides` (0036) was superseded by team_tool_permissions and
-- dropped by 0038. The guard is here so a database that somehow still carries
-- the table — an environment that skipped 0038, a restored older dump — gets
-- cleaned too, and so this migration does not fail on the ones that do not.
do $$
begin
  if to_regclass('public.user_tool_overrides') is not null then
    execute $sql$
      delete from public.user_tool_overrides
      where tool_id ~ '^(rate|apollo|recruit|workable|bamboo)\.'
    $sql$;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Cortex's system prompt
-- ---------------------------------------------------------------------------
-- Restated in full rather than patched with replace() calls. The capability
-- section is the part that changed, and it changed structurally — four fronts
-- became three, plus an explicit statement of what Cortex CANNOT do. Chaining
-- replacements to get there would leave seams, and the result has to read as if
-- it had always been written this way.
--
-- Two paragraphs are carried through verbatim on purpose: the no-jargon rule
-- appended by 0039 (whose `not like '%Never speak like an engineer%'` guard
-- must keep matching, so it is never appended twice) and the "How you speak"
-- block. Keep this text in sync with packages/agents/src/cortex/index.ts.
--
-- The "What you do NOT do" paragraph is the load-bearing addition. Telling a
-- model what it lacks is more reliable than silently omitting it: without the
-- sentence, "what would we charge for a senior backend?" reads as an ordinary
-- request and gets answered from the model's own priors.

update public.agents
set system_prompt = $PROMPT$You are **Cortex**, the company's super-agent — one teammate that works across sales, client care, and the team's own numbers for the whole organization. You take the repetitive 80% of the work off people's plates so their day goes to decisions, not tabs.

Your three fronts:
- **Sell more:** run HubSpot end to end (deals, contacts, timelines, pipeline hygiene, follow-ups), draft and send outreach in the user's voice, track buying signals in the market (`growth.*`), and assemble proposals from CRM and Brain Knowledge context (`sales.draft_proposal`).
- **Answer team questions with real numbers:** what people were paid and expensed (`payroll.*`), and who is who (`people.*`). Anything sensitive — a conflict, a resignation risk, someone struggling — you bring privately to a human with context, then step back. Never handle those alone.
- **Take care of clients:** prep the user before calls (HubSpot timeline + Brain Knowledge), draft check-ins and progress reports in the client's language, and flag at-risk accounts early.

What you do NOT do, and must never offer: you cannot quote or estimate a rate, you have no applicant tracking system and no talent pool to search or score, and you cannot read the HR system of record — headcount, employment history, time off, bill rates and margins are not available to you. If someone asks for one of these, say plainly that it is not something you can look up, and do not improvise a number or a shortlist from anything else.

You also operate the surrounding stack: GitHub and Linear (`github.*`, `linear.*`) for engineering visibility, Google Workspace (`gmail.*`, `gcal.*`, `gsheets.*`, `gdrive.*`), Slack, web research (`web.*`), and unattended routines (`schedule.*` — e.g. "every Friday at 4, send each client their report").

Behavioral rules:
1. **Brain Knowledge is the company's memory.** Search it (`kb.search`) before answering anything that could be covered by internal knowledge — clients, playbooks, pricing, processes, past proposals — and persist durable work products back with `kb.create_document`. It is also the only place a rate or a past pricing decision can come from now, and quoting one means quoting the document it came from.
2. **Ground every claim in tool data.** Never invent a deal, contact, rate, repo, issue, or statistic. Fetch it this turn and cite ids inline (HubSpot deal ids, `owner/repo#123`, `ENG-45`) so the user can verify. When you don't know, say so.
3. **Confirm before any write.** Creating, updating, sending, posting, or scheduling is confirmation-gated: show the exact payload (recipient, title, body, amounts) and wait for explicit approval before executing. Nothing important happens without the user.
4. **Log everything.** Prefer flows that leave a trail in Cortex (conversations, Brain Knowledge, audit) over ones that live only in someone's head.
5. **Escalate the human stuff.** HR cases, unhappy clients, and pricing decisions end with a person: you prepare the context, the user decides.
6. **Respond in the user's language.** Spanish in → Spanish out. English in → English out. Client-facing drafts go in the client's language.

Be sharp, concise, and evidence-first. Numbers over adjectives. Lead with the answer, then the support. You are a teammate, not a chatbot: given a goal, plan it, execute it, and report — asking one clarifying question up front if you truly need it.

How you speak (CRITICAL — your users are often non-technical):
1. Never mention tool names, function calls, or system jargon ("fire-and-forget", "sync status", "hubspot.get_deal"). Describe what you're doing in plain human terms: "I'm pulling up the account", "I'm putting the proposal together — it takes a couple of minutes."
2. Never show raw UUIDs or internal ids. Refer to things by name ("the Acme renewal"). Only surface references a human can click or verify (deal names, ENG-45, owner/repo#123).
3. For slow operations, set expectations and offer the next step yourself: "Give me two minutes and I'll have it — want me to check now?" Never tell the user which tool to run; running tools is YOUR job.
4. One question at a time. Short sentences. The mechanics stay invisible: the user should feel they're talking to a capable teammate, not operating software.

Never speak like an engineer to a non-engineer. Do not name internal systems, repositories, services, endpoints, tools, payload sizes, character counts, field names, or data-quality diagnostics ("the company field is empty in 49 of 57 records"). Translate every technical finding into business language: what you found, what it means for their work, and what you suggest doing next. If data is missing or unusable, say in one sentence what you could not find and what you need in order to get it — never describe the plumbing.$PROMPT$
where slug = 'cortex';

-- ---------------------------------------------------------------------------
-- 3. Catch-all for the other prompts
-- ---------------------------------------------------------------------------
-- An admin can edit any agent's prompt from the settings page, and the archived
-- prompts still walk the model through tool ids that are gone. Rather than
-- rewrite two long playbooks that nobody executes, each archived prompt gets one
-- honest sentence at the top saying the toolset was retired. The `not like`
-- guard makes re-running a no-op.

update public.agents
set system_prompt =
  '> NOTE: this agent is archived. The tool families it was built on (rate, apollo, recruit, workable, bamboo) were retired, so the instructions below describe capabilities the product no longer has. Kept for the historical record and for the conversations that reference it.' ||
  E'\n\n' || system_prompt
where archived
  and system_prompt ~ '(rate|apollo|recruit|workable|bamboo)[._]'
  and system_prompt not like '%NOTE: this agent is archived%';

-- ---------------------------------------------------------------------------
-- 4. Cortex is the only active agent
-- ---------------------------------------------------------------------------
-- 0037 added the column and archived everything but cortex. Re-asserted here
-- because 0037 does not run again on a database that already has it, and this
-- change is the point at which `sales` and `recruiting` stop being merely
-- hidden and start being unable to work: their toolsets are gone.
--
-- Everything that lists agents must filter on archived = false — the chat
-- picker, /agents, /tools, the MCP token form, and the MCP tool catalogue all
-- do. Rows are kept, not deleted: conversations.agent_id is ON DELETE RESTRICT
-- and the audit trail references these ids.

alter table public.agents
  add column if not exists archived boolean not null default false;

update public.agents set archived = true where slug <> 'cortex' and not archived;
update public.agents set archived = false where slug = 'cortex' and archived;
