-- Proposed actions: the step between "Cortex noticed something" and "somebody
-- did something about it".
--
-- WHAT THIS IS FOR. Cortex already knows that Coltrans is 47 days late, that a
-- SOAT lapses in nine days, that a customs deadline is tomorrow. Until now it
-- said so, and stopped. Saying so is not the job — the job is the email that
-- goes out afterwards, and today that email is written by whoever read the
-- answer, in another tab, from memory, if they remember.
--
-- A row in this table is that email, ALREADY WRITTEN: its recipient, its
-- subject, its body, what it was derived from and why. A person reads it,
-- adjusts it if they want, and approves. Nothing here ever sends anything on
-- its own.
--
-- ===========================================================================
-- THE RULE THIS SCHEMA EXISTS TO ENFORCE
-- ===========================================================================
-- WHAT RUNS IS EXACTLY WHAT WAS ON SCREEN WHEN THE PERSON SAID YES.
--
-- This is the whole product. An approval means nothing if the text can move
-- between the moment it is shown and the moment it leaves the building — and
-- it does not have to be malice: two tabs, a background sweep re-drafting a
-- stale figure, a retried job. One email that went out saying something the
-- approver never read, and no one approves anything here again.
--
-- Three mechanisms, each closing a different hole:
--
--   1. `content_hash` — a fingerprint of `tool_input`, computed by
--      packages/agent-tools/src/actions/shape.ts (canonical JSON, SHA-256).
--      What the screen renders, it renders together with this value.
--
--   2. THE CLAIM CARRIES THE HASH. Approving is one conditional UPDATE:
--
--        update actions set state='approved', …
--         where id = … and user_id = … and state='proposed'
--           and expires_at > now() and content_hash = <the hash on screen>
--        returning tool_input
--
--      The payload the caller executes is the payload that statement RETURNED.
--      So the bytes that run are, by construction, bytes whose fingerprint was
--      a precondition of the approval succeeding — with no window in between,
--      because it is a single statement. A payload that changed since it was
--      displayed matches zero rows and the person is told the text moved,
--      rather than being asked to trust that it did not. (Same reasoning as
--      lib/approvals/claim.ts, which this reuses rather than re-implements.)
--
--   3. `actions_content_guard` (below) — the database's own opinion, holding
--      for every writer including a psql session: `tool_input` cannot change
--      without `content_hash` changing with it, and once an action has been
--      decided its content is frozen outright.
--
-- ===========================================================================
-- WHAT NOBODY APPROVES
-- ===========================================================================
-- Nothing. Ever. There is no state transition in this schema that executes an
-- action, and `expires_at` does not cause one — it REVOKES the ability to
-- approve. That direction is the point: time passing can only ever make Cortex
-- do less. A cobro drafted around "lleva 47 días" is a true sentence for about
-- a week; after that the numbers in the body are wrong and the right answer is
-- a fresh proposal, not a stale one somebody finally got round to.
--
-- This is the same posture the unattended path already takes: schedule-run
-- skips a confirmation-gated tool and REPORTS it rather than running it (see
-- apps/web/inngest/functions/schedule-run.ts).
--
-- ===========================================================================
-- WHY A TABLE AND NOT A PIPELINE
-- ===========================================================================
-- A pipeline (migration 0043) is a procedure someone wrote down: steps, params,
-- checkpoints, executed by the calling model. An action is the opposite shape —
-- no steps, no parameters, one already-decided call whose entire content is
-- data. Modelling it as a one-step pipeline with a checkpoint would put the
-- text that gets sent inside a prose `detail` field rendered from a template at
-- run time, which is precisely the thing the rule above forbids.
--
-- ===========================================================================
-- TENANCY
-- ===========================================================================
-- `organization_id` on both tables, both registered as `tenant()` in
-- packages/agent-tools/src/tenancy/tables.ts, and the application only ever
-- holds a scoped handle (0064). RLS is deny-all + service_role, matching 0065,
-- 0067 and 0069.
--
-- Idempotent throughout.

-- ===========================================================================
-- 1. The actions themselves
-- ===========================================================================

create table if not exists public.actions (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,

  -- Whose action this is ---------------------------------------------------
  -- The person who must approve it AND whose credentials execute it. Not an
  -- arbitrary reviewer: the mail leaves from this person's Gmail and is signed
  -- with their name, so "someone else approved it" would be a forgery with an
  -- audit trail. `claimApproval` refuses anybody else, exactly as it does for
  -- mcp_pending_actions.
  user_id           uuid        not null references public.users(id) on delete cascade,
  agent_id          uuid        references public.agents(id) on delete set null,
  -- The thread it was proposed in, when it was proposed in one. Null for the
  -- unattended sweep, which has no conversation.
  conversation_id   uuid        references public.conversations(id) on delete set null,

  -- What kind of thing this is ---------------------------------------------
  -- Three, chosen rather than enumerated. Each one is a message a real person
  -- at a postal and customs operator writes by hand today:
  --   collect_payment  a cobro to a client whose invoice has lapsed
  --   remind_owner     a deadline handed back to whoever answers for it
  --   reply_to_client  an answer to a client's email that is still unanswered
  -- Adding a fourth is a migration, on purpose: a catalogue of proposals
  -- nobody approves is worse than three that get used.
  kind              text        not null
                                check (kind in ('collect_payment','remind_owner','reply_to_client')),

  -- WHAT WILL RUN ----------------------------------------------------------
  -- `tool_id` is a registry id and `tool_input` its validated input. Execution
  -- goes through runTool like every other call in this product, so the audit
  -- row, the rate limit and the risk classification are the ordinary ones —
  -- there is no second, quieter way to send an email from here.
  tool_id           text        not null check (length(tool_id) between 3 and 120),
  tool_input        jsonb       not null,
  -- Fingerprint of tool_input. Read the header. Maintained by the application
  -- (one writer: packages/agent-tools/src/actions/store.ts) and policed by
  -- actions_content_guard below.
  content_hash      text        not null check (content_hash ~ '^[0-9a-f]{64}$'),

  -- A readable projection of the payload, so a list of twenty actions is one
  -- query rather than twenty jsonb digs. Derived, never authoritative: nothing
  -- reads these to decide anything, and the hash does not cover them.
  recipient         text        not null check (length(btrim(recipient)) between 1 and 320),
  subject           text        not null check (length(btrim(subject)) between 1 and 300),

  -- WHERE IT CAME FROM -----------------------------------------------------
  -- An action with no derivation is a suggestion, and this product does not
  -- make suggestions. `rationale` is the sentence shown under the draft — one
  -- line, in Spanish, naming the fact that produced it.
  origin_kind       text        not null
                                check (origin_kind in ('commitment','email_thread','manual')),
  -- The commitment id, the Gmail thread id, or null when a person asked for it
  -- outright. Text rather than uuid because a Gmail thread id is not one.
  origin_id         text        check (length(origin_id) <= 200),
  rationale         text        not null check (length(btrim(rationale)) between 3 and 600),

  -- Who it is about, when that is a client we actually have a record of.
  -- Nullable and stays nullable: `public.clients` (migration 0075) is new, most
  -- counterparties are not in it yet, and an action addressed to a name we
  -- cannot resolve to a row is still a perfectly good action.
  client_id         uuid,

  -- Lifecycle ---------------------------------------------------------------
  -- Three states and no fourth. 'approved' is set by the claim, at which point
  -- the execution columns below start being filled in; a failed execution does
  -- NOT return the row to 'proposed', because "it may or may not have gone out"
  -- is a far worse thing to hand somebody than "it did not, ask me again".
  state             text        not null default 'proposed'
                                check (state in ('proposed','approved','dismissed')),
  -- When it stops being approvable. See "WHAT NOBODY APPROVES" in the header.
  expires_at        timestamptz not null,
  decided_at        timestamptz,
  decided_by        uuid        references public.users(id) on delete set null,
  decided_via       text        check (decided_via in ('web','chat','mcp')),
  dismissed_reason  text        check (length(dismissed_reason) <= 400),

  -- Execution ---------------------------------------------------------------
  executed_at       timestamptz,
  execution_status  text        check (execution_status in ('ok','failed','blocked')),
  execution_error   text        check (length(execution_error) <= 2000),
  execution_result  jsonb,
  -- The Gmail thread the send landed in. This is the thread the follow-up
  -- sweep watches to find out whether anybody answered.
  thread_id         text        check (length(thread_id) <= 200),

  -- What happened next ------------------------------------------------------
  -- An action that was sent and then never looked at again is the failure mode
  -- this column exists to prevent: the point of a cobro is that the client
  -- pays, not that an email left.
  --   none      not executed (proposed, or dismissed)
  --   awaiting  sent, nobody has replied yet
  --   replied   somebody other than us wrote back on the thread
  --   resolved  the thing it was about got closed (the commitment was met)
  --   no_reply  the follow-up window passed in silence — itself worth knowing
  outcome           text        not null default 'none'
                                check (outcome in ('none','awaiting','replied','resolved','no_reply')),
  outcome_at        timestamptz,
  outcome_note      text        check (length(outcome_note) <= 1000),

  -- How many times a human rewrote the draft before approving it. The
  -- revisions themselves are in the table below; this is here so a list can
  -- show "editado" without a join.
  edited_count      int         not null default 0 check (edited_count >= 0),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- A decided action names who decided it and when. Both or neither.
  constraint actions_decision_complete check (
    (state = 'proposed'  and decided_at is null and decided_by is null)
    or
    (state in ('approved','dismissed') and decided_at is not null)
  ),
  -- Only an approved action can have run, and an executed one carries the fact.
  constraint actions_execution_needs_approval check (
    executed_at is null or state = 'approved'
  ),
  constraint actions_outcome_needs_execution check (
    outcome = 'none' or executed_at is not null
  )
);

-- The link to the client record, added only if migration 0075 has landed.
-- Ordinary migration order guarantees it has (0075 < 0077); the guard is for a
-- working tree where the two branches have not met yet, and it makes this file
-- applicable on its own rather than conditionally broken.
do $$
begin
  if to_regclass('public.clients') is not null
     and not exists (
       select 1 from pg_constraint where conname = 'actions_client_id_fkey'
     )
  then
    alter table public.actions
      add constraint actions_client_id_fkey
      foreign key (client_id) references public.clients(id) on delete set null;
  end if;
end $$;

-- The queue: what is waiting on this person, newest first.
create index if not exists actions_org_user_open_idx
  on public.actions (organization_id, user_id, created_at desc)
  where state = 'proposed';

-- The whole workspace's queue and history, for the screen.
create index if not exists actions_org_state_idx
  on public.actions (organization_id, state, created_at desc);

-- What the follow-up sweep scans: executed, still waiting on an answer.
create index if not exists actions_org_awaiting_idx
  on public.actions (organization_id, executed_at)
  where outcome = 'awaiting';

-- What an action was derived from, so a commitment screen can show it.
create index if not exists actions_origin_idx
  on public.actions (organization_id, origin_kind, origin_id);

-- ONE OPEN PROPOSAL PER THING. The daily sweep runs every morning and the
-- overdue payment is still overdue tomorrow; without this it would file a
-- second identical cobro every day until somebody drowned. The sweep does not
-- have to remember what it did yesterday — it writes, and the index decides.
-- Same design as commitment_notices_once_idx in 0069.
create unique index if not exists actions_open_origin_idx
  on public.actions (organization_id, kind, origin_kind, origin_id)
  where state = 'proposed' and origin_id is not null;

comment on table public.actions is
  'An action Cortex has drafted and is offering: recipient, content, provenance, and the exact tool call that runs if a human approves it. Nothing in this schema executes anything — approval is a conditional UPDATE whose WHERE clause contains the fingerprint of the content the approver was shown.';

comment on column public.actions.content_hash is
  'SHA-256 of the canonical JSON of tool_input. Rendered with the draft and sent back with the approval; it is a condition of the claim, so an action whose text moved since it was displayed cannot be approved by someone who read the old text.';

comment on column public.actions.expires_at is
  'When the proposal stops being approvable. It never causes execution — time passing can only make Cortex do less. A stale draft quotes stale figures, so the correct answer after this is a fresh proposal.';

comment on column public.actions.tool_input is
  'The validated input of tool_id, verbatim. This is the ONLY copy: the approval carries an id and a hash, never a payload, so there is nothing for a transport to truncate or a caller to substitute.';

comment on column public.actions.outcome is
  'What happened after it ran. Closing the loop is what keeps an executed action from becoming an orphan: a cobro that was answered is done, a cobro that went nowhere for two weeks is a fact somebody should see.';

-- ===========================================================================
-- 2. The edits
-- ===========================================================================
-- Who rewrote the draft before sending it is not bookkeeping — it is the most
-- useful signal this whole feature produces. A cobro that four people out of
-- five rewrite the same way is a template that is wrong, and the only way to
-- ever know that is to keep the before and the after.

create table if not exists public.action_revisions (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  text        not null references public.ba_organization(id) on delete cascade,
  action_id        uuid        not null references public.actions(id) on delete cascade,
  edited_by        uuid        references public.users(id) on delete set null,
  edited_at        timestamptz not null default now(),
  -- The fingerprints on either side of the edit, so a revision chain can be
  -- verified end to end against the action's current content_hash.
  from_hash        text        not null check (from_hash ~ '^[0-9a-f]{64}$'),
  to_hash          text        not null check (to_hash ~ '^[0-9a-f]{64}$'),
  -- Both sides in full. Storing a diff would mean the record of what was sent
  -- depends on replaying every edit correctly.
  before_input     jsonb       not null,
  after_input      jsonb       not null,
  constraint action_revisions_actually_changed check (from_hash <> to_hash)
);

create index if not exists action_revisions_action_idx
  on public.action_revisions (action_id, edited_at desc);

create index if not exists action_revisions_org_idx
  on public.action_revisions (organization_id, edited_at desc);

comment on table public.action_revisions is
  'Every human edit to a drafted action, both sides in full. Who adjusts the wording before approving is the signal that tells us which drafts are wrong.';

-- ===========================================================================
-- 3. The content guard
-- ===========================================================================
-- The database's own opinion about the rule in the header, so it holds for
-- writers that never pass through the application: a migration, a support
-- script, a psql session at 2am.

create or replace function public.actions_content_guard()
returns trigger
language plpgsql
as $$
begin
  -- The content of a decided action is frozen. After approval the payload has
  -- been executed or is about to be, and the row is the record of what was
  -- sent; a later edit would rewrite history rather than change an outcome.
  if old.state <> 'proposed' and new.tool_input is distinct from old.tool_input then
    raise exception
      'actions: the content of a % action is frozen (action %)', old.state, old.id
      using errcode = 'check_violation';
  end if;

  -- Changing the text without changing the fingerprint is exactly the failure
  -- the fingerprint exists to catch: it would leave an approval, already
  -- granted against the old hash, valid for new content.
  if new.tool_input is distinct from old.tool_input and new.content_hash = old.content_hash then
    raise exception
      'actions: tool_input changed but content_hash did not (action %) — the fingerprint must be recomputed with the content', old.id
      using errcode = 'check_violation';
  end if;

  -- And the reverse, which would be a forged fingerprint: a hash that moved
  -- while the content stood still.
  if new.content_hash <> old.content_hash and new.tool_input is not distinct from old.tool_input then
    raise exception
      'actions: content_hash changed but tool_input did not (action %)', old.id
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists actions_content_guard_trg on public.actions;
create trigger actions_content_guard_trg
  before update on public.actions
  for each row execute function public.actions_content_guard();

comment on function public.actions_content_guard() is
  'Keeps tool_input and content_hash inseparable, and freezes both once the action has been decided. The application enforces the same rule; this is the copy that holds when the application is not involved.';

-- ===========================================================================
-- 4. Access
-- ===========================================================================
-- Deny-all + service_role, matching 0065, 0067 and 0069. The tenant boundary is
-- createOrgScopedClient, not a policy keyed off auth.uid().

alter table public.actions enable row level security;
alter table public.action_revisions enable row level security;

revoke all on table public.actions from public, anon, authenticated;
revoke all on table public.action_revisions from public, anon, authenticated;

grant select, insert, update, delete on table public.actions to service_role;
grant select, insert, update, delete on table public.action_revisions to service_role;
