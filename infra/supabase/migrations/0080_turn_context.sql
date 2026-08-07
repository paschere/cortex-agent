-- What the model was actually handed, on a turn that really happened.
--
-- ---------------------------------------------------------------------------
-- THE GAP
-- ---------------------------------------------------------------------------
-- When an answer comes out wrong, the only explanation available today is a
-- guess. `messages` keeps what was said and which tools were called;
-- `audit_events` keeps that a tool ran and a hash of its input. Neither keeps
-- what the model READ before it answered: which fragments of Brain Knowledge
-- were pasted above the question, what they scored, which ones missed the cut
-- by two thousandths, which tools it was offered and why those, which standing
-- instructions were in force, and how the context was spent.
--
-- The Brain Knowledge memory bench (0073) answers the neighbouring question —
-- "what would retrieval return for this question, right now". This one answers
-- "what did it return at 14:32 on Tuesday, in that conversation", and the two
-- are not interchangeable. Between then and now the relevance thresholds were
-- recalibrated (twice in one week — see kb/relevance.ts), the default embedding
-- model changed (0074), documents were re-indexed and tool descriptions were
-- re-embedded. A bench re-run tells you about today's system. It agrees with
-- the truth on every turn except the ones somebody opened it for.
--
-- So this is a RECORD, written at the moment of the turn, from the values that
-- were really used. Nothing in it is a foreign key to something that can move:
-- a fragment carries its own score, its own verdict, the cuts that judged it
-- and the embedding model whose scale those cuts are on.
--
-- ---------------------------------------------------------------------------
-- WHY ITS OWN TABLE AND NOT audit_events
-- ---------------------------------------------------------------------------
-- audit_events answers "what did the agent DO" — one row per tool call, with a
-- hash of the input precisely so arguments are not minable from it, a risk
-- level, a decision, and a retention nobody wants to shorten because it is the
-- oversight log. This answers "what did the agent SEE" — one row per turn, with
-- verbatim material inside it, and a retention that MUST be short for that
-- reason. Same word, opposite requirements: the audit log's value grows with
-- age and its rows are deliberately unrevealing; a context capture's value
-- collapses within a fortnight and its rows quote the corpus.
--
-- Folding this into audit_events would mean either lengthening how long quoted
-- fragments are kept to match the audit retention, or shortening the audit log
-- to match this. Both are wrong. A second table costs a join nobody makes.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT STORED
-- ---------------------------------------------------------------------------
--   The assembled prompt string. It is the sum of the parts, every part is
--     recorded, and a copy of it per turn would be the largest thing here by an
--     order of magnitude.
--   The agent's base prompt. Identical on every turn of every conversation in a
--     workspace, and already stored live in `agents.system_prompt`. A digest is
--     kept instead, which answers the only question that matters when reading
--     an old turn: is the prompt on screen today the one that was sent. When it
--     is not, the surface says so rather than showing the wrong one.
--   Conversation history and the user's message. Already in `messages`, in
--     full. Only their WEIGHT is recorded here, which is what the turn is
--     being asked about.
--   Tool results. Already in `messages.tool_results`.
--   The model's output. Already in `messages.content`.
--
-- What is left is only what nothing else keeps.

-- ---------------------------------------------------------------------------
-- 1. One captured turn
-- ---------------------------------------------------------------------------
create table if not exists public.turn_contexts (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  -- The assistant message this context produced. Nullable because the row is
  -- written from the stream's onFinish, where a failed message insert must not
  -- take the capture down with it: a turn whose context is known and whose
  -- reply was lost is still worth reading.
  message_id uuid references public.messages(id) on delete set null,
  user_id uuid not null references public.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,

  model text not null,
  -- The provider's own count, reported when the turn finished. The one figure
  -- on the page that is not an estimate; everything in `parts` is measured in
  -- characters and converts to tokens approximately, and says so on screen.
  prompt_tokens int,
  completion_tokens int,

  -- [{key, chars, tokens}] — where the context went, in the order it went in.
  parts jsonb not null default '[]'::jsonb,
  -- {chars, digest} — the agent prompt by fingerprint. See the header.
  instructions jsonb not null default '{}'::jsonb,
  -- [{id, text}] — standing instructions, prepended whole (0051).
  memories jsonb not null default '[]'::jsonb,
  -- {ran, skipped, query, coverage, summary, cuts, limit, fragments[]} — the
  -- retrieval as it really came back, INCLUDING the fragments that fell below
  -- the floor and were never shown to the model. Those are the point: they are
  -- dropped inside kb.search and exist nowhere else once the call returns.
  retrieval jsonb not null default '{}'::jsonb,
  -- {reason, candidates, offered[], families[{family, score, offered, reason}]}
  -- The semantic tool ranking that already runs every turn and was previously
  -- only logged. The scores cannot be recomputed later: the query vector is not
  -- kept and tool vectors are re-embedded whenever a description is edited.
  tools jsonb not null default '{}'::jsonb,

  -- True when a conversation-scoped adjustment was in force. Recorded on the
  -- turn rather than only on the settings row, so a turn that behaved oddly
  -- says why on its own face instead of requiring the reader to notice a
  -- setting that may since have been changed back.
  overridden boolean not null default false,

  created_at timestamptz not null default now(),

  -- Retention, stated on the row rather than inferred from a constant in code.
  -- A row therefore ages out under the policy it was WRITTEN with, and the
  -- sweep is a dumb comparison against now() instead of a policy re-derivation
  -- that would retroactively re-date history whenever the policy changed.
  --
  --   detail_until  after this, the quoted material is stripped (see § 3)
  --   purge_at      after this, the row is deleted
  --
  -- Set by the writer from packages/agent-tools/src/turn-context/policy.ts,
  -- which is where the reasoning for the two windows lives.
  detail_until timestamptz not null,
  purge_at timestamptz not null,
  redacted_at timestamptz
);

comment on table public.turn_contexts is
  'What one turn actually handed the model: the Brain Knowledge fragments prepended and their real scores, the ones that missed the cut, the tools offered and the ranking that chose them, the standing instructions, and the weight of each part. Captured at the moment of the turn and never recomputed — thresholds, documents, tool descriptions and the embedding model all move, so a re-derivation would describe today''s system rather than the turn being read.';

comment on column public.turn_contexts.retrieval is
  'The retrieval as it came back, before the relevance floor was applied. Fragments below the floor are kept deliberately: kb.search drops them before the model sees them, they exist nowhere else afterwards, and a passage that scored 0,44 against a floor of 0,46 is usually the answer to "why did it say that".';

comment on column public.turn_contexts.detail_until is
  'After this instant the quoted material (fragment excerpts, memory text, the retrieval summary) is nulled by the purge sweep and redacted_at is stamped. The numbers survive to purge_at.';

-- Every read is "this conversation, in order".
create index if not exists turn_contexts_conversation_idx
  on public.turn_contexts (conversation_id, created_at);

-- One row per assistant message, which is how the transcript joins to it.
create index if not exists turn_contexts_message_idx
  on public.turn_contexts (message_id) where message_id is not null;

create index if not exists turn_contexts_org_idx
  on public.turn_contexts (organization_id, created_at desc);

-- The two sweep predicates. Partial on redacted_at so the redaction pass walks
-- only rows that still hold text, which is a small and shrinking set.
create index if not exists turn_contexts_detail_until_idx
  on public.turn_contexts (detail_until) where redacted_at is null;

create index if not exists turn_contexts_purge_at_idx
  on public.turn_contexts (purge_at);

-- ---------------------------------------------------------------------------
-- 2. What somebody adjusted, and for how far
-- ---------------------------------------------------------------------------
-- SCOPE IS THE CONVERSATION, ON PURPOSE. These knobs are touched by someone who
-- has just had a bad answer and is looking at this page to find out why — that
-- is, mid-diagnosis. An adjustment made in that state must not be able to
-- change what anybody else's assistant does. A workspace-wide "prepend fewer
-- fragments", set on a Tuesday afternoon while chasing one wrong reply, is
-- exactly the change that is never undone, never remembered, and resurfaces six
-- weeks later as "the brain stopped working" with nothing on screen connecting
-- the two.
--
-- Conversation scope makes the experiment contained and legible: it changes the
-- thing being looked at, every turn it affected says so (turn_contexts.
-- overridden), and a new conversation is a complete reset that needs no undo.
-- A change that turns out to be right for everybody belongs in the agent's own
-- configuration, decided deliberately rather than left behind by a debugging
-- session.
--
-- The primary key IS the conversation: there is one adjustment per
-- conversation, not a history of them, because a stack of superseded
-- diagnostics settings is not something anybody would read.
create table if not exists public.turn_context_settings (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  organization_id text not null references public.ba_organization(id) on delete cascade,

  -- How many Brain Knowledge fragments to prepend. NULL means the default.
  -- 0 is a real and useful value — "answer without the brain this time" — and
  -- is why this is nullable rather than defaulted to the current number.
  fragment_limit int check (fragment_limit is null or (fragment_limit >= 0 and fragment_limit <= 8)),

  -- Narrow retrieval to these spaces. NULL means everything the asker can see.
  -- This can only ever NARROW: it reaches retrieval through ToolContext.
  -- kbSpaceIds, which Postgres intersects with the visible set, so an id in
  -- here for a space the person cannot see contributes nothing. Empty arrays
  -- are stored as NULL so "no restriction" has exactly one representation —
  -- an empty kbSpaceIds means "no space at all" and the two must never blur.
  space_ids uuid[],

  -- Tool families not to offer in this conversation. Removes only; it can
  -- never grant a family the agent's own permissions did not already allow.
  muted_families text[] not null default '{}',

  updated_by uuid not null references public.users(id) on delete cascade,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.turn_context_settings is
  'Per-conversation adjustments to what Cortex is handed: how many Brain Knowledge fragments to prepend, which spaces to draw them from, and which tool families to withhold. Scoped to one conversation deliberately — see the migration header. Both the space list and the family list can only narrow what was already permitted.';

create index if not exists turn_context_settings_org_idx
  on public.turn_context_settings (organization_id);

-- ---------------------------------------------------------------------------
-- 3. The sweep
-- ---------------------------------------------------------------------------
-- Two passes, and the first one is the important one.
--
-- REDACTION IS A REAL WRITE, NOT A READ FILTER. After detail_until the quoted
-- material is removed from the row — the fragment excerpts, the memory text and
-- the retrieval summary are replaced, in place, with nulls. Hiding them at read
-- time would leave a diagnostics table quietly holding passages out of people's
-- personal spaces for months; "we stopped keeping it" is only true if the bytes
-- are gone. Everything that is not a quotation survives: scores, verdicts,
-- document titles, which fragments were prepended, the tool ranking, the
-- weights. Those keep answering the slower questions ("retrieval has been
-- eating 70% of this agent's context all month") at a twentieth of the size.
--
-- Marked `maintenance` in RPC_TENANCY: it touches no tenant-visible data, takes
-- no workspace argument and returns only counts. It is called by an Inngest
-- cron, which has no session to scope it to.
create or replace function public.turn_context_purge()
returns table (redacted bigint, deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_redacted bigint;
  v_deleted bigint;
begin
  with stripped as (
    update public.turn_contexts
    set
      -- jsonb_set rather than a rewrite, so a row written by a newer version
      -- with fields this function has never heard of keeps them.
      retrieval = jsonb_set(
        jsonb_set(
          coalesce(retrieval, '{}'::jsonb),
          '{summary}', '""'::jsonb, true
        ),
        '{fragments}',
        coalesce(
          (
            select jsonb_agg(jsonb_set(fragment, '{excerpt}', 'null'::jsonb, true))
            from jsonb_array_elements(coalesce(retrieval->'fragments', '[]'::jsonb)) as fragment
          ),
          '[]'::jsonb
        ),
        true
      ),
      memories = coalesce(
        (
          select jsonb_agg(jsonb_set(memory, '{text}', 'null'::jsonb, true))
          from jsonb_array_elements(coalesce(memories, '[]'::jsonb)) as memory
        ),
        '[]'::jsonb
      ),
      redacted_at = now()
    where redacted_at is null
      and detail_until < now()
    returning 1
  )
  select count(*) into v_redacted from stripped;

  with removed as (
    delete from public.turn_contexts
    where purge_at < now()
    returning 1
  )
  select count(*) into v_deleted from removed;

  return query select v_redacted, v_deleted;
end;
$$;

comment on function public.turn_context_purge() is
  'Two-pass retention sweep for turn_contexts. First strips quoted material (fragment excerpts, memory text, the retrieval summary) from rows past detail_until, in place, leaving every number intact. Then deletes rows past purge_at. Install-wide maintenance: no tenant argument, no tenant-visible data returned.';

revoke all on function public.turn_context_purge() from public;
