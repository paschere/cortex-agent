-- How long a turn took, and where the time went.
--
-- ---------------------------------------------------------------------------
-- THE GAP
-- ---------------------------------------------------------------------------
-- Nobody had ever measured how long Cortex takes to answer. Not approximately,
-- not badly — not at all. The one row that looked like it might know is the
-- turn-level audit event the chat route writes at the end of every turn, and it
-- was written with `latency_ms: 0`, a literal zero, on every turn since the
-- route was created. So the product's central question — does an answer arrive
-- before the person gives up and asks the colleague next to them — had no data
-- behind it, only opinions.
--
-- What was already there, and is deliberately not rebuilt here:
--
--   audit_events   One row per TOOL CALL, with a real latency_ms. The per-tool
--                  breakdown is already answerable, so this table only counts
--                  and sums them. It does not know what a turn is: a turn that
--                  called four tools is four unrelated rows plus a fifth that
--                  said zero.
--
--   turn_contexts  One row per TURN (0080), with what the model was handed and
--                  the provider's token counts. It knows the shape of a turn
--                  and nothing about its clock.
--
-- Neither knew the number that decides how the product feels: when the first
-- character reached the screen.
--
-- ---------------------------------------------------------------------------
-- WHY IT IS NOT A COLUMN ON turn_contexts
-- ---------------------------------------------------------------------------
-- It nearly is, and the join is one column away, so the reason has to be
-- better than tidiness.
--
--   DIFFERENT READERS, DIFFERENT UNITS. A turn context is opened one row at a
--   time, by somebody looking at one bad answer. A latency row is never read
--   alone — it is only meaningful as a distribution over hundreds of turns.
--   Selecting p95 over a table whose rows each carry quoted corpus fragments
--   and two jsonb blobs of scores means dragging kilobytes per row through a
--   scan that wants six integers.
--
--   DIFFERENT LIVES. turn_contexts is redacted at fourteen days because it
--   quotes people's documents. Nothing here quotes anything — it is integers —
--   so it has no detail window at all, only an expiry. Attaching timings to a
--   row that gets rewritten by a redaction sweep means the sweep has to know
--   not to touch them, forever.
--
--   DIFFERENT SURFACES, EVENTUALLY. turn_contexts is written by the web chat
--   route alone. Latency is a question about Google Chat and WhatsApp too, and
--   those surfaces have no context capture to hang a column on.
--
-- ---------------------------------------------------------------------------
-- STAGES CARRY WHEN THEY STARTED, NOT ONLY HOW LONG THEY TOOK
-- ---------------------------------------------------------------------------
-- `stages` is [{stage, at, ms}] where `at` is the offset from the start of the
-- turn. That extra field is the whole honesty of the table.
--
-- Retrieval and the semantic tool ranking now run at the same time. Their
-- durations therefore do NOT add up to the wall clock, and a schema that stored
-- only durations would silently double-count them — the breakdown would sum to
-- more than the turn and there would be no way to tell whether that was overlap
-- or a bug. With the offset, concurrency is visible in the data: two stages
-- with the same `at` ran together, and "we parallelised these" is a fact a
-- reader can check rather than a claim in a commit message.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT STORED
-- ---------------------------------------------------------------------------
--   An average of anything. Percentiles are computed at read time from the raw
--     rows, because the mean is the one statistic that actively hides the
--     problem: what ruins the experience is the nineteen-second turn, and an
--     average buries it behind ninety fast ones. Storing a pre-aggregated mean
--     would make the misleading number the cheap one to reach for.
--   Per-tool timings. audit_events.latency_ms already has them, per call, with
--     the tool id. Only the count and the sum are kept here, which is what a
--     turn-shaped question needs.
--   The question, the answer, or any text at all. This table is integers. It
--     is what lets it live ninety days with no redaction pass behind it.

-- ---------------------------------------------------------------------------
-- 1. One measured turn
-- ---------------------------------------------------------------------------
create table if not exists public.turn_latencies (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  -- The assistant message this turn produced, when there was one. Nullable for
  -- the same reason turn_contexts.message_id is: the row is written from the
  -- stream's onFinish, and a turn whose reply failed to persist is exactly the
  -- turn whose timing is worth having.
  message_id uuid references public.messages(id) on delete set null,
  user_id uuid not null references public.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,

  -- Latency is not comparable across either of these, so both are on the row
  -- rather than inferred. A model change and a surface change both move every
  -- number here, and a distribution that mixes them describes nothing.
  model text not null,
  surface text not null default 'web',

  -- THE HEADLINE. Start of the turn to the first character the person can see,
  -- reasoning or answer. Null only when the turn produced nothing visible.
  first_visible_ms int,
  -- Start of the turn to the first character of the ANSWER. Kept apart from
  -- the above because this product streams the model's reasoning, so on a
  -- normal turn the first visible character is a word of thinking and the
  -- answer begins seconds later. One number cannot honestly be both.
  first_answer_ms int,
  total_ms int not null,
  -- Everything before the request left for the model: retrieval, tool ranking,
  -- transcript, prompt assembly. The part of first_visible_ms that belongs to
  -- Cortex rather than to the model, and therefore the only part engineering
  -- can shorten without touching the answer.
  prelude_ms int not null default 0,

  -- [{stage, at, ms}] — see the header. `at` is what makes overlap legible.
  stages jsonb not null default '[]'::jsonb,

  -- Round-trips to the model. One when no tool ran; a tool-calling turn chains
  -- several and each one pays the full prompt again.
  steps int not null default 0,
  tool_calls int not null default 0,
  -- Summed, not wall-clocked: the SDK runs a step's tool calls concurrently, so
  -- the sum is what the tools cost and total_ms is what the turn paid.
  tool_ms int not null default 0,

  prompt_tokens int,
  completion_tokens int,

  -- [{read, written, promptTokens}] — one entry per model round-trip, in order.
  -- PER STEP AND NOT PER TURN, because that is the unit the prompt cache works
  -- in: the first request of a conversation writes the prefix and the rest
  -- should read it, so a turn that calls three tools contains one write and
  -- three hits. Folding that into a per-turn boolean would report the turn as a
  -- miss and understate the saving threefold.
  --
  -- This is the column that answers whether caching is really working here.
  -- Cortex picks its tools per turn by semantic relevance, and the tools sit in
  -- front of the system prompt in the request, so a changed tool list moves the
  -- prefix and misses. Whether that happens often is an empirical question
  -- about real conversations, and this is where the answer accumulates.
  cache jsonb not null default '[]'::jsonb,

  created_at timestamptz not null default now(),

  -- Stated on the row, like turn_contexts, so a row ages out under the policy
  -- it was written with rather than being retroactively re-dated by an edit to
  -- the constant. Set from packages/agent-tools/src/latency/policy.ts.
  purge_at timestamptz not null
);

comment on table public.turn_latencies is
  'How long one turn took and where the time went: time to the first visible character, time to the first character of the answer, the total, and every stage with the offset at which it started. One row per turn, written after the answer has already been delivered. Integers only — no text is captured, which is why it needs no redaction pass.';

comment on column public.turn_latencies.first_visible_ms is
  'Start of the turn to the first character on screen, reasoning included. The number that decides whether Cortex feels alive rather than hung; total_ms is context for it, not a substitute.';

comment on column public.turn_latencies.stages is
  '[{stage, at, ms}] where `at` is milliseconds from the start of the turn. Durations alone would double-count the stages that run concurrently; the offset is what makes the overlap readable.';

comment on column public.turn_latencies.cache is
  'One entry per model round-trip: {read, written, promptTokens} from the provider''s own cache_read_input_tokens / cache_creation_input_tokens. Per step because a turn with tool calls makes several requests and they do not behave alike.';

-- Every aggregate read is "this workspace, recently, by model".
create index if not exists turn_latencies_org_idx
  on public.turn_latencies (organization_id, created_at desc);

-- Reading one conversation's turns in order, from the transcript.
create index if not exists turn_latencies_conversation_idx
  on public.turn_latencies (conversation_id, created_at);

create index if not exists turn_latencies_message_idx
  on public.turn_latencies (message_id) where message_id is not null;

-- The sweep predicate.
create index if not exists turn_latencies_purge_at_idx
  on public.turn_latencies (purge_at);

-- ---------------------------------------------------------------------------
-- 2. The sweep
-- ---------------------------------------------------------------------------
-- One pass, not two. turn_contexts needs a redaction step because it quotes the
-- corpus; this table holds integers, so there is nothing to strip and the row
-- either exists or does not.
--
-- Marked `maintenance` in RPC_TENANCY: no workspace argument, no tenant-visible
-- data returned, called by the same Inngest cron that sweeps turn contexts.
create or replace function public.turn_latency_purge()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted bigint;
begin
  with removed as (
    delete from public.turn_latencies
    where purge_at < now()
    returning 1
  )
  select count(*) into v_deleted from removed;

  return v_deleted;
end;
$$;

comment on function public.turn_latency_purge() is
  'Retention sweep for turn_latencies: deletes rows past their purge_at and returns how many. Install-wide maintenance — no tenant argument, nothing tenant-visible returned.';

revoke all on function public.turn_latency_purge() from public;
