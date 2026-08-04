-- What Cortex learns about a person from working with them.
--
-- WHAT THIS IS, AND WHAT IT IS NOT. This is not a second Knowledge Base. The
-- personal KB space (migration 0049) already holds a person's DOCUMENTS, and it
-- is retrieved — chunks come back when they look semantically like the
-- question. That is the right shape for "what did we quote Acme last March".
--
-- It is the wrong shape for a standing instruction. Retrieval only fires on
-- similarity, so "never CC the client" would load when the question is about
-- CC'ing and silently fail to load when the question is about anything else —
-- which is precisely when it still applies. A preference that holds
-- unpredictably is worse than no preference, because the person cannot reason
-- about when Cortex will honour it.
--
-- So these are NOT retrieved. Every active row for a person is injected WHOLE
-- into the system prompt of every turn, on every surface. That is only
-- affordable if the set stays small, which is what the cap and the eviction
-- below are for.
--
-- WHAT DOES NOT BELONG HERE.
--   - Company facts ("our standard margin is 35%"). They are true for
--     everybody, so per-user rows would be N drifting copies that only help
--     whoever happened to say it. They have an owner, need an admin gate, and
--     are findable by topic — all of which the global KB space already does.
--   - Documents and work products. Same reason: the KB space holds those.
--   - Credentials, compensation figures, contact details. Everything here is
--     injected into every prompt and therefore lands in every log and every
--     provider request. Screening happens on every write path in
--     packages/agent-tools/src/memory/sensitive.ts.
--
-- WHAT STAYS WHERE IT IS. `user_preferences.digest_focus` (migration 0043) is
-- free-form guidance folded into a prompt, so it looks like the same idea. It
-- is not, and it is deliberately not migrated: it applies to exactly one
-- feature (the morning inbox digest) and nowhere else. Promoting it to a
-- memory would inject "clients first, ignore newsletters" into every Google
-- Chat turn and every MCP session, where it means nothing, and would move the
-- control away from the toggle that turns the digest on. Feature-scoped
-- guidance belongs next to its feature; only guidance that applies
-- unpredictably across the whole product earns a slot in the always-on budget.

-- ---------------------------------------------------------------------------
-- 1. The shape of a memory
-- ---------------------------------------------------------------------------

-- What kind of thing it is. Used for ordering (instructions first — an
-- instruction ignored is a broken promise, a vocabulary note ignored is a
-- clarifying question) and for how the settings page groups them.
create type memory_kind as enum (
  'instruction',  -- a standing rule: "never CC the client"
  'preference',   -- how they like things: "costs always in USD"
  'vocabulary',   -- what their words mean: "the matcher = tpp.Cortex.com"
  'fact'          -- stable context about them and their work
);

-- 'suggested' is the whole point of the derived path: a wrongly-learned fact is
-- nearly impossible to debug from the outside — the symptom is "why does Cortex
-- keep assuming X?" with no visible cause. Approving costs one click;
-- un-learning a silent wrong belief costs a support conversation.
--
-- 'rejected' rows are KEPT, not deleted. A deleted rejection is one the nightly
-- job cheerfully proposes again next week.
create type memory_status as enum ('suggested', 'active', 'archived', 'rejected');

create type memory_source as enum (
  'explicit',     -- the person said "acuérdate de que…". Highest trust.
  'derived',      -- proposed by the nightly job from their conversations.
  'behavioural'   -- computed from audit_events. No model involved at all.
);

create table if not exists public.user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  -- One sentence, in the person's own terms, because this is what they read on
  -- the settings page AND what the model reads in the prompt. 240 characters
  -- is roughly two lines; anything longer is a document and belongs in the KB.
  content text not null,
  kind memory_kind not null default 'fact',
  status memory_status not null default 'active',
  source memory_source not null default 'explicit',
  -- WHY it was proposed. A suggestion without its evidence is a coin flip: the
  -- person is being asked to ratify a belief about themselves with nothing to
  -- check it against. Nulled out when the conversation is deleted, and never
  -- set to a conversation belonging to somebody else (see remember() below).
  source_conversation_id uuid references public.conversations(id) on delete set null,
  source_note text,
  -- "Last useful" drives eviction and is shown on the settings page. Null means
  -- it has never been loaded into a prompt.
  last_used_at timestamptz,
  use_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_memories_content_len check (char_length(btrim(content)) between 3 and 240),
  constraint user_memories_note_len check (source_note is null or char_length(source_note) <= 500)
);

comment on table public.user_memories is
  'Small, always-on, per-person context injected whole into every Cortex system prompt. Not retrieved and not a document store — the personal KB space (kb_collections, scope=user) holds documents. Capped and evicted least-recently-useful first; see user_memory_remember().';
comment on column public.user_memories.status is
  'active = injected into every prompt. suggested = proposed by the nightly job, waiting for the person. archived = evicted by the cap, still visible and restorable. rejected = the person said no; kept so it is never proposed again.';
comment on column public.user_memories.source_conversation_id is
  'The conversation a derived suggestion came from, so the person can check the evidence before accepting it. Always the asking user''s own conversation.';

-- One memory per person per sentence, across every status. Saying the same
-- thing twice reactivates the row rather than creating a twin, and a rejected
-- or archived sentence cannot be re-proposed as if it were new.
create unique index if not exists user_memories_person_content_idx
  on public.user_memories (user_id, lower(btrim(content)));

-- The hot path: "every active memory for this person", run on every turn.
create index if not exists user_memories_live_idx
  on public.user_memories (user_id, status, kind);

alter table public.user_memories enable row level security;
-- Service-role only, like the rest of the schema (auth is better-auth; the app
-- never holds an anon key). The functions below are the real boundary.

-- ---------------------------------------------------------------------------
-- 2. The boundary
-- ---------------------------------------------------------------------------
-- Same rule as kb_spaces (0049), for the same reason: the visible set is
-- derived from the user id INSIDE Postgres, so no function exists that could
-- return someone else's memories. Nothing here takes "which memories" as an
-- argument — every function takes the person, and an id argument can only ever
-- narrow within what that person already owns.
--
-- A null user id yields nothing and writes nothing, so a caller that has lost
-- track of who it is asking for fails closed rather than open.

-- How many memories may be loaded at once, and it is a product decision, not a
-- storage one. At the 240-character ceiling a memory is ~60 tokens and typically
-- ~20, so 40 of them is roughly 800–2,400 tokens — paid on every turn, on three
-- surfaces, forever. Beyond about forty lines of standing instruction the middle
-- of the list stops reliably influencing behaviour, which would make the cap a
-- lie: the memories would still be listed on the settings page while quietly
-- ceasing to work. Forty is the largest number that still does what the page
-- says it does.
create or replace function public.user_memory_limit()
returns int language sql immutable as $$ select 40 $$;

-- Pending suggestions are capped separately. An approval queue nobody can face
-- is an approval queue nobody empties, and the nightly job would happily grow
-- one forever.
create or replace function public.user_memory_suggestion_limit()
returns int language sql immutable as $$ select 12 $$;

/**
 * The ONLY read entry point for prompt injection. Ordered so that if anything
 * downstream ever truncates, instructions survive and trivia is what is lost.
 */
create or replace function public.user_memory_context(p_user_id uuid)
returns table (
  id uuid,
  content text,
  kind memory_kind,
  source memory_source,
  last_used_at timestamptz
)
language sql
stable
as $$
  select m.id, m.content, m.kind, m.source, m.last_used_at
  from public.user_memories m
  where p_user_id is not null
    and m.user_id = p_user_id
    and m.status = 'active'
  order by
    case m.kind
      when 'instruction' then 0
      when 'vocabulary' then 1
      when 'preference' then 2
      else 3
    end,
    m.created_at
  limit public.user_memory_limit();
$$;

comment on function public.user_memory_context(uuid) is
  'Every memory injected into this person''s prompts, derived from the user id inside the database. There is no variant that takes a list of memory ids — one person''s memory cannot reach another person''s answer because no function exists that would return it.';

/** Everything the person may see about themselves, for the settings page. */
create or replace function public.user_memory_list(p_user_id uuid)
returns table (
  id uuid,
  content text,
  kind memory_kind,
  status memory_status,
  source memory_source,
  source_conversation_id uuid,
  source_note text,
  last_used_at timestamptz,
  use_count int,
  created_at timestamptz
)
language sql
stable
as $$
  select m.id, m.content, m.kind, m.status, m.source, m.source_conversation_id,
         m.source_note, m.last_used_at, m.use_count, m.created_at
  from public.user_memories m
  where p_user_id is not null
    and m.user_id = p_user_id
  order by
    case m.status
      when 'suggested' then 0
      when 'active' then 1
      when 'archived' then 2
      else 3
    end,
    m.created_at desc;
$$;

/**
 * Keep the active set inside the cap by archiving the least-recently-useful
 * memories — not the oldest. A note from a year ago that loads into every turn
 * is doing its job; a note from last week that has never been useful is not.
 *
 * Archived, never deleted: the person can see what fell out and put it back.
 * Silently dropping something they explicitly asked Cortex to remember would be
 * exactly the invisible behaviour this whole feature exists to avoid.
 *
 * Defined before user_memory_remember(), which calls it.
 */
create or replace function public.user_memory_enforce_cap(
  p_user_id uuid,
  p_keep_id uuid default null
)
returns int
language sql
as $$
  -- Ordered most-useful-first, then everything past the allowance is dropped.
  -- p_keep_id is the row being written right now: it is excluded from the
  -- ranking and reserves one slot, so a brand-new memory can never evict itself.
  with surplus as (
    select m.id
    from public.user_memories m
    where m.user_id = p_user_id
      and m.status = 'active'
      and (p_keep_id is null or m.id <> p_keep_id)
    order by coalesce(m.last_used_at, m.created_at) desc, m.use_count desc, m.created_at desc
    offset greatest(public.user_memory_limit() - (case when p_keep_id is null then 0 else 1 end), 0)
  ),
  archived as (
    update public.user_memories m
    set status = 'archived', updated_at = now()
    where m.id in (select id from surplus)
    returning m.id
  )
  select count(*)::int from archived;
$$;

/**
 * Write a memory. Insert, or reactivate the row that already says this.
 *
 * Returns the row id, or null when the write was declined — which happens when
 * the pending-suggestion queue is full. A null is not an error: the nightly job
 * proposing into a full queue is the normal case, not a failure.
 */
create or replace function public.user_memory_remember(
  p_user_id uuid,
  p_content text,
  p_kind memory_kind default 'fact',
  p_source memory_source default 'explicit',
  p_status memory_status default 'active',
  p_conversation_id uuid default null,
  p_note text default null
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
  v_content text := btrim(p_content);
  v_conversation uuid;
  v_existing_status memory_status;
begin
  if p_user_id is null or char_length(v_content) < 3 then
    return null;
  end if;

  -- Citing a conversation is citing evidence, and evidence the person cannot
  -- open is worse than none. It also must not become a way to learn that
  -- somebody else's conversation exists, so a foreign id is dropped rather
  -- than rejected.
  select c.id into v_conversation
  from public.conversations c
  where c.id = p_conversation_id and c.user_id = p_user_id;

  select m.status into v_existing_status
  from public.user_memories m
  where m.user_id = p_user_id and lower(btrim(m.content)) = lower(v_content);

  -- A suggestion must never overwrite something already settled. Re-proposing
  -- what the person rejected is how an approval step becomes a nag.
  if v_existing_status is not null and p_status = 'suggested' then
    return null;
  end if;

  if v_existing_status is null and p_status = 'suggested' then
    if (
      select count(*) from public.user_memories m
      where m.user_id = p_user_id and m.status = 'suggested'
    ) >= public.user_memory_suggestion_limit() then
      return null;
    end if;
  end if;

  insert into public.user_memories (
    user_id, content, kind, status, source, source_conversation_id, source_note
  )
  values (p_user_id, v_content, p_kind, p_status, p_source, v_conversation, p_note)
  on conflict (user_id, lower(btrim(content))) do update
    set kind = excluded.kind,
        -- Saying it again brings an archived or already-active memory back;
        -- it never silently downgrades one.
        status = excluded.status,
        source = excluded.source,
        source_conversation_id = coalesce(excluded.source_conversation_id,
                                          user_memories.source_conversation_id),
        source_note = coalesce(excluded.source_note, user_memories.source_note),
        updated_at = now()
  returning id into v_id;

  -- Only an ACTIVE memory occupies a prompt slot, so only an active write can
  -- push somebody else out. A pending suggestion costs nothing until accepted.
  if p_status = 'active' then
    perform public.user_memory_enforce_cap(p_user_id, v_id);
  end if;
  return v_id;
end;
$$;

/** Delete one of the caller's own memories. False when it was not theirs. */
create or replace function public.user_memory_forget(p_user_id uuid, p_id uuid)
returns boolean
language sql
as $$
  with gone as (
    delete from public.user_memories m
    where m.user_id = p_user_id and m.id = p_id and p_user_id is not null
    returning m.id
  )
  select exists (select 1 from gone);
$$;

/**
 * Accept or reject a pending suggestion, or archive/restore a settled one.
 * The user id is part of the WHERE, so an id belonging to somebody else
 * matches nothing and reports false — indistinguishable from a stale id, which
 * is the point: a distinguishable "forbidden" would confirm the row exists.
 */
create or replace function public.user_memory_set_status(
  p_user_id uuid,
  p_id uuid,
  p_status memory_status
)
returns boolean
language plpgsql
as $$
declare
  v_rows int;
begin
  if p_user_id is null then return false; end if;

  update public.user_memories m
  set status = p_status, updated_at = now()
  where m.user_id = p_user_id and m.id = p_id;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then return false; end if;

  if p_status = 'active' then
    perform public.user_memory_enforce_cap(p_user_id, p_id);
  end if;
  return true;
end;
$$;

/**
 * Mark the memories that were just loaded into a prompt as useful.
 *
 * "Useful" here means "was in the room", not "changed the answer" — the model
 * does not report which lines it leaned on, and asking it to would be a guess
 * dressed as telemetry. Being loaded is the honest signal, and it is enough for
 * the only decision it feeds: which memory to evict when a person is at the
 * cap. Ids not belonging to the caller update nothing.
 */
create or replace function public.user_memory_touch(p_user_id uuid, p_ids uuid[])
returns void
language sql
as $$
  update public.user_memories m
  set last_used_at = now(), use_count = m.use_count + 1
  where p_user_id is not null
    and m.user_id = p_user_id
    and m.id = any(p_ids);
$$;

-- PostgREST publishes everything in `public` under /rpc/, and every one of
-- these takes the user id as a plain argument. The app reaches them with the
-- service role only.
revoke all on function public.user_memory_limit() from public, anon, authenticated;
revoke all on function public.user_memory_suggestion_limit() from public, anon, authenticated;
revoke all on function public.user_memory_context(uuid) from public, anon, authenticated;
revoke all on function public.user_memory_list(uuid) from public, anon, authenticated;
revoke all on function public.user_memory_remember(uuid, text, memory_kind, memory_source, memory_status, uuid, text) from public, anon, authenticated;
revoke all on function public.user_memory_enforce_cap(uuid, uuid) from public, anon, authenticated;
revoke all on function public.user_memory_forget(uuid, uuid) from public, anon, authenticated;
revoke all on function public.user_memory_set_status(uuid, uuid, memory_status) from public, anon, authenticated;
revoke all on function public.user_memory_touch(uuid, uuid[]) from public, anon, authenticated;

grant execute on function public.user_memory_limit() to service_role;
grant execute on function public.user_memory_suggestion_limit() to service_role;
grant execute on function public.user_memory_context(uuid) to service_role;
grant execute on function public.user_memory_list(uuid) to service_role;
grant execute on function public.user_memory_remember(uuid, text, memory_kind, memory_source, memory_status, uuid, text) to service_role;
grant execute on function public.user_memory_enforce_cap(uuid, uuid) to service_role;
grant execute on function public.user_memory_forget(uuid, uuid) to service_role;
grant execute on function public.user_memory_set_status(uuid, uuid, memory_status) to service_role;
grant execute on function public.user_memory_touch(uuid, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 3. When the nightly job last looked at this person
-- ---------------------------------------------------------------------------
-- Lives on user_preferences rather than in a new table: it is one timestamp per
-- person and that table is already "the row keyed to this person". Null means
-- never, which the job reads as "look at the last 7 days".
alter table public.user_preferences
  add column if not exists memories_derived_at timestamptz;

comment on column public.user_preferences.memories_derived_at is
  'High-water mark for the nightly memory-derivation job, so a run reads only conversation turns it has not already considered.';
