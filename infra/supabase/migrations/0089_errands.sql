-- Encargos: work you hand over and walk away from.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS MISSING
-- ---------------------------------------------------------------------------
-- Cortex answers questions and runs tools inside one turn of chat. The
-- orchestrator (0055, 0070) already executes long, durable, multi-agent work —
-- but it executes ONE objective, straight through, and whatever comes out is
-- what you get. If the objective was ambiguous it guesses. If a branch dies it
-- reports the gap and stops. There is no way to say "go and get me this" and
-- have something come back either with the answer or with a QUESTION.
--
-- An errand is that missing wrapper. It owns:
--   * the request a person actually made, in their words;
--   * a sequence of LEGS, each of which is one orchestrator run;
--   * a question channel, so the thing can stop and ask instead of inventing;
--   * a spend ledger with a ceiling, so an autonomous job cannot bill for ever;
--   * one deliverable, with its sources.
--
-- The orchestrator stays exactly as it is. An errand does not re-implement
-- planning, sub-agents, waves, cancellation, heartbeats or the live console —
-- it COMMISSIONS runs and reads their rows. That is why there is no execution
-- state in these tables beyond a pointer to the run that is currently working.
--
-- ---------------------------------------------------------------------------
-- THE LINE THIS SCHEMA REFUSES TO CROSS
-- ---------------------------------------------------------------------------
-- An errand SEARCHES, COMPARES AND PROPOSES. It never buys, never books, never
-- signs, and never sends anything to a third party on its own account.
--
-- That is not a convention here, it is the reason several columns do NOT exist.
-- There is no `approved_by`, no `executed_at`, no `external_ref`, no payment or
-- booking reference anywhere in these tables, because an errand has no
-- outbound side to record. Everything that leaves the building goes through the
-- approval machinery that already exists — `mcp_pending_actions` (0033) for a
-- tool call waiting on a yes, `actions` (0077) for a message waiting on one —
-- and what runs there is bound by hash to what a person actually approved.
--
-- The enforcement lives in apps/web/lib/errands/boundary.ts, which hands each
-- leg an EXPLICIT allow-list of read-only tool ids. Keep the two in step: this
-- comment is the promise, that file is the mechanism.
--
-- ---------------------------------------------------------------------------
-- THREE KINDS, AND NOTHING ELSE
-- ---------------------------------------------------------------------------
-- `kind` is a CHECK constraint rather than free text on purpose. "Encárgame
-- cualquier cosa" is a promise no autonomous system keeps, and a product that
-- makes it spends its life apologising. Three shapes, each of which the tool
-- catalogue can genuinely serve:
--
--   research_compare  investigate a topic and produce a comparison
--   gather_sources    collect what exists about something, inside and outside
--   monitor_change    look again on a cadence and say when something changed
--
-- Adding a fourth means widening this constraint AND adding it to
-- apps/web/lib/errands/kinds.ts, which is where each kind's brief and toolset
-- live. Making it easy to add would be making it easy to over-promise.

-- ---------------------------------------------------------------------------
-- 1. The errand
-- ---------------------------------------------------------------------------

create table if not exists public.errands (
  id               uuid primary key default gen_random_uuid(),
  -- better-auth organization id, TEXT and not a uuid. An errand belongs to the
  -- company that commissioned it, and every read is filtered on this.
  organization_id  text not null
                     references public.ba_organization(id) on delete cascade,
  -- Nullable + `set null`: deleting a person must not delete the record of
  -- work their errand did on behalf of the workspace. The unattended engine
  -- reads the person off this row (there is no session out there), so an
  -- errand whose owner is gone stops being advanceable — which is correct.
  user_id          uuid references public.users(id) on delete set null,

  kind             text not null
                     check (kind in ('research_compare', 'gather_sources', 'monitor_change')),
  -- What the person typed, verbatim. Never rewritten: the brief below is the
  -- machine's reading of it, and keeping both is what lets a reader see
  -- whether the reading was right.
  request          text not null check (length(btrim(request)) between 10 and 4000),
  -- The refined objective, written by triage once the questions (if any) are
  -- answered. Null until then.
  brief            text,

  state            text not null default 'queued'
                     check (state in ('queued', 'working', 'blocked', 'watching',
                                      'delivered', 'failed', 'cancelled', 'exhausted')),

  -- ── The ceiling ────────────────────────────────────────────────────────
  -- Checked at the LEG BOUNDARY, which is the only moment where stopping is
  -- free: mid-leg the tokens are already spent. Same argument the orchestrator
  -- makes about wave boundaries. See apps/web/lib/errands/budget.ts.
  token_ceiling    integer not null check (token_ceiling between 10000 and 2000000),
  tokens_spent     integer not null default 0 check (tokens_spent >= 0),
  leg_ceiling      integer not null check (leg_ceiling between 1 and 6),
  legs_used        integer not null default 0 check (legs_used >= 0),

  -- ── Monitoring (kind = 'monitor_change' only) ──────────────────────────
  check_interval_minutes integer check (check_interval_minutes between 15 and 20160),
  checks_done            integer not null default 0 check (checks_done >= 0),
  next_check_at          timestamptz,
  -- The reading the next check is compared against. Prose, not a hash: a
  -- fingerprint would fire on a reworded sentence, and "cambió" has to mean
  -- something a person would call a change.
  baseline               text,

  -- ── Where it came from ─────────────────────────────────────────────────
  -- The conversation it was commissioned in, when it was one. Null for an
  -- errand started from the /errands form.
  --
  -- This column is the whole answer to "what happens when an errand needs to
  -- ask something". A question waiting on a screen nobody has open is a
  -- question nobody answers, and a blocked errand costs the same as a running
  -- one while it waits. So an errand born in a chat WRITES ITS QUESTION BACK
  -- INTO THAT CHAT, as an assistant message — the same mechanism a scheduled
  -- routine already uses to deliver its result (scheduled_jobs.conversation_id,
  -- inngest/functions/schedule-run.ts). The question itself stays in
  -- errand_questions and is answered through the same conditional UPDATE
  -- wherever the answer comes from; only the DELIVERY is new.
  conversation_id  uuid references public.conversations(id) on delete set null,

  -- ── What it is doing right now ─────────────────────────────────────────
  -- The orchestration run currently working, or null between legs. This is the
  -- ONLY execution state here; everything else about that run lives in
  -- orchestration_runs / _tasks / _events and is read from there.
  current_run_id   uuid references public.orchestration_runs(id) on delete set null,

  -- ── What it has learnt, and what it delivered ──────────────────────────
  -- Carried forward across legs, and across a clarification: this is what
  -- makes "asks a question mid-way without losing what it already did" true.
  findings         text,
  -- The answer, in markdown. Sources are separate and structured so the screen
  -- can stamp them, because a research result without provenance is a rumour.
  deliverable      text,
  sources          jsonb not null default '[]'::jsonb,
  -- Why it ended the way it did, in the person's language. Always written on a
  -- terminal state, including the happy one.
  closing_note     text,

  -- ── Liveness, same shape and the same argument as orchestration_runs ────
  last_heartbeat_at timestamptz not null default now(),
  -- Single-flight for one transition of the state machine. Cleared at the end
  -- of every transition, so it is a short-lived lease and not an ownership
  -- claim: an errand lives for hours and its worker for seconds.
  claimed_at        timestamptz,

  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- A monitor without a cadence would never be re-checked; a one-shot errand
  -- with one would be re-checked for ever. The two are the same mistake.
  constraint errands_monitor_has_cadence check (
    (kind = 'monitor_change') = (check_interval_minutes is not null)
  ),
  -- Only a monitor waits between looks.
  constraint errands_watching_is_monitor check (
    state <> 'watching' or kind = 'monitor_change'
  ),
  -- A terminal errand has stopped, and says so with both a timestamp and a
  -- sentence. Silence is the failure mode this whole feature exists to remove.
  constraint errands_terminal_is_closed check (
    state in ('queued', 'working', 'blocked', 'watching')
    or (finished_at is not null and closing_note is not null)
  )
);

-- The list page: one workspace, newest first.
create index if not exists errands_org_created_idx
  on public.errands (organization_id, created_at desc);

-- The sweep's two questions, both about a small live minority, so both partial.
--   "which errands are mid-leg and might have finished or gone quiet?"
create index if not exists errands_live_idx
  on public.errands (last_heartbeat_at)
  where state in ('queued', 'working');
--   "which monitors are due for another look?"
create index if not exists errands_due_idx
  on public.errands (next_check_at)
  where state = 'watching';

-- Admission control reads this: how many errands is this workspace already
-- running? See MAX_LIVE_ERRANDS in apps/web/lib/errands/budget.ts.
create index if not exists errands_org_live_idx
  on public.errands (organization_id)
  where state in ('queued', 'working', 'blocked', 'watching');

-- "Which errands in this conversation are waiting on me" — read when a chat
-- turn starts, so a question asked half an hour ago is not lost to scrollback.
create index if not exists errands_conversation_idx
  on public.errands (conversation_id)
  where conversation_id is not null;

comment on column public.errands.current_run_id is
  'The orchestration run currently doing this errand''s work, or null between legs. An errand does not execute anything itself: it commissions runs (0055) and reads their rows.';
comment on column public.errands.findings is
  'Everything established so far, carried across legs AND across a clarification. This column is why asking a question mid-way does not throw away the work already paid for.';
comment on column public.errands.sources is
  'Array of {url, title, readAt} the deliverable rests on. Structured rather than prose so the screen can stamp each one — a research result without provenance is a rumour.';

-- ---------------------------------------------------------------------------
-- 2. The legs
-- ---------------------------------------------------------------------------
--
-- One row per orchestrator run this errand commissioned. Kept as its own table
-- rather than derived from orchestration_runs because a leg carries things the
-- run does not know it has: which errand asked for it, what the errand knew
-- when it asked, and what the errand took away afterwards. It is also the spend
-- ledger — "what did this cost, leg by leg" is the question a surprise bill
-- makes somebody ask.

create table if not exists public.errand_legs (
  id           uuid primary key default gen_random_uuid(),
  organization_id text not null
                 references public.ba_organization(id) on delete cascade,
  errand_id    uuid not null references public.errands(id) on delete cascade,
  seq          integer not null check (seq >= 1),
  -- Null only in the window between claiming the leg and the run row existing.
  run_id       uuid references public.orchestration_runs(id) on delete set null,
  -- The objective handed to the orchestrator, which is NOT the person's
  -- request: it is the request plus what earlier legs established plus any
  -- answered clarification. Stored so a reader can see what was actually asked.
  objective    text not null,
  status       text not null default 'running'
                 check (status in ('running', 'completed', 'failed', 'interrupted', 'cancelled')),
  -- The run's own report, copied here at assessment time. The run rows are the
  -- source of truth while it works; this is the snapshot the errand reasons
  -- over afterwards, and it survives even if the run is later purged.
  summary      text,
  tokens       integer not null default 0 check (tokens >= 0),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  -- When the errand READ this leg and decided what it meant. The distinction
  -- between "finished" and "read" is what makes assessment re-entrant: a
  -- worker that dies between the run ending and the verdict being written
  -- leaves a leg that is finished and unread, and the next worker knows to
  -- read it rather than either re-running it or skipping past it.
  assessed_at  timestamptz
);

-- seq IS the leg's identity inside its errand, and the ordered read the detail
-- page does on every load.
create unique index if not exists errand_legs_errand_seq_idx
  on public.errand_legs (errand_id, seq);

-- ---------------------------------------------------------------------------
-- 3. The questions
-- ---------------------------------------------------------------------------
--
-- THE MOST IMPORTANT TABLE HERE, and the one that separates an errand from a
-- lucky button. An assistant that cannot ask has exactly two ways to handle not
-- knowing something: invent an answer, or give up quietly. Both are worse than
-- a run that stops and says "¿marítima o terrestre?".
--
-- A question is asked in two situations and they are deliberately different:
--
--   BEFORE anything is spent (leg 0, from triage). The cheapest possible
--   moment to discover the request is ambiguous, and the one a person is most
--   likely to still be at their desk for.
--
--   MID-WAY (after a leg). The leg found something that forks, or found
--   nothing usable. Everything the leg produced is already in
--   errands.findings and errand_legs.summary before the question is written,
--   so answering it resumes rather than restarts.
--
-- At most one question is open per errand at a time — enforced below. A person
-- returning to a blocked errand should find ONE thing to answer, not a form.

create table if not exists public.errand_questions (
  id              uuid primary key default gen_random_uuid(),
  organization_id text not null
                    references public.ba_organization(id) on delete cascade,
  errand_id       uuid not null references public.errands(id) on delete cascade,
  -- 0 when it came from triage, before any leg ran.
  leg             integer not null default 0 check (leg >= 0),
  question        text not null check (length(btrim(question)) between 5 and 600),
  -- Why the errand cannot sensibly continue without this. Displayed, because a
  -- question with no stated reason reads as an interrogation.
  why             text not null check (length(btrim(why)) between 5 and 600),
  -- Suggested answers, so the common case is one click and not an essay.
  options         text[] not null default '{}',
  state           text not null default 'open'
                    check (state in ('open', 'answered', 'withdrawn')),
  answer          text check (length(answer) <= 2000),
  asked_at        timestamptz not null default now(),
  answered_at     timestamptz,
  answered_by     uuid references public.users(id) on delete set null,

  constraint errand_questions_answer_complete check (
    (state = 'answered') = (answered_at is not null and answer is not null)
  )
);

-- One open question per errand. Partial unique rather than application logic:
-- two workers assessing the same errand is exactly the race that produces two
-- questions, and only the database can decide which of them was first.
create unique index if not exists errand_questions_one_open_idx
  on public.errand_questions (errand_id)
  where state = 'open';

create index if not exists errand_questions_errand_idx
  on public.errand_questions (errand_id, asked_at desc);

-- The badge on the nav and the "esperan tu respuesta" count.
create index if not exists errand_questions_org_open_idx
  on public.errand_questions (organization_id, asked_at desc)
  where state = 'open';

-- ---------------------------------------------------------------------------
-- 4. updated_at
-- ---------------------------------------------------------------------------

create or replace function public.errands_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists errands_touch_updated_at_trg on public.errands;
create trigger errands_touch_updated_at_trg
  before update on public.errands
  for each row execute function public.errands_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Access
-- ---------------------------------------------------------------------------
--
-- Everything reaches these tables through the service role behind an
-- org-scoped handle (packages/agent-tools/src/tenancy), so RLS is enabled with
-- NO policies: deny-all for anon and authenticated, same as the rest of the
-- schema. The three tables are registered in tenancy/tables.ts, without which
-- the scoped client refuses to query them at all.

alter table public.errands          enable row level security;
alter table public.errand_legs      enable row level security;
alter table public.errand_questions enable row level security;

revoke all on public.errands          from public, anon, authenticated;
revoke all on public.errand_legs      from public, anon, authenticated;
revoke all on public.errand_questions from public, anon, authenticated;

grant select, insert, update, delete on public.errands          to service_role;
grant select, insert, update, delete on public.errand_legs      to service_role;
grant select, insert, update, delete on public.errand_questions to service_role;
