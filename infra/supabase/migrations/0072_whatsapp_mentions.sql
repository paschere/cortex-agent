-- Cortex answers in a WhatsApp group — but only when it is mentioned.
--
-- WHAT CHANGES. Until now a group was read-only: Cortex was a silent member,
-- archiving the groups somebody switched on (migration 0068). Now it can also
-- REPLY, and only ever in response to an explicit @mention. No mention, no
-- reply, exactly as before.
--
-- WHY THESE ARE TWO SEPARATE PERMISSIONS. Archiving a group and answering in it
-- are different decisions with different risks and different people who should
-- make them. Archiving is about what the company REMEMBERS: it writes other
-- people's words into a searchable space and its risk is disclosure inside the
-- company. Answering is about what Cortex SAYS OUT LOUD in a room that contains
-- clients, suppliers and drivers: its risk is disclosure OUTSIDE the company,
-- which is worse and is not recoverable. A group you want archived is very
-- often not one you want the agent talking in — a client group is the obvious
-- case — and the reverse is just as common: an internal coordination group
-- where Cortex is useful and nobody needs a transcript. So `reply_enabled` is
-- its own column, its own switch on the screen, and its own audit trail. One is
-- never implied by the other.
--
-- ── THE LEAK, WHICH IS THE REAL PROBLEM HERE ────────────────────────────────
--
-- When the group was read-only, an answer could not leak because there was no
-- answer. Now there is, and the person who asked is not the only person who
-- reads it. Somebody in operations asking "¿cuánto nos debe este cliente?" in a
-- group that the client is in gets a correct answer and a disaster.
--
-- The defence is three layers, narrowest first, and every layer is visible on
-- the Cortex screen so nobody learns the scope by leaking something:
--
--   1. `reply_scope` — what Cortex is allowed to reach for in THIS group.
--      Default `plain`: no tools at all. It can read the conversation in the
--      room and answer from it — summarise what was agreed, translate, do the
--      arithmetic, draft the message — and nothing it says can come from a
--      company system, because it cannot reach one. That is both the safe
--      default and, in practice, most of what a group actually asks for.
--
--      `knowledge` adds read-only Brain Knowledge, restricted to ONE
--      company-wide space named below. `internal` adds the asker's read-only
--      business tools and is for rooms with no outsiders in them.
--
--   2. `reply_space_id` — the single Brain Knowledge space that may be cited
--      here, and it must be a GLOBAL space. A personal space is by definition
--      one person's private notes; there is no version of "quote my private
--      notes to a room containing a client" that is correct, so it is not a
--      setting, it is a constraint. Enforced when the group is switched on and
--      again on every turn (ToolContext.kbSpaceIds).
--
--   3. The privacy guard that already exists for Google Chat spaces
--      (apps/web/app/api/chat-app/google/turn.ts): if a turn touches payroll,
--      personal data, anything the security classifier rates high, or repeats
--      one of the asker's own memories, the answer is WITHHELD from the room
--      and delivered to the asker privately. In the group Cortex says only that
--      it answered privately. Useful without leaking, which is the whole aim.
--
-- ── LOOPS AND NOISE ─────────────────────────────────────────────────────────
--
-- A bot that can talk in a group can also become the reason people leave it.
-- `whatsapp_group_replies` is one row per mention, claimed BEFORE the answer is
-- composed, which makes two things true at once: the same mention can never be
-- answered twice (WhatsApp re-delivers, routinely), and counting recent rows is
-- the rate limit. Past `reply_limit_per_hour` Cortex goes quiet rather than
-- announcing that it has gone quiet, because "estoy limitado" is itself noise.
--
-- Idempotent throughout.

-- ===========================================================================
-- 1. Answering, as its own permission
-- ===========================================================================

alter table public.whatsapp_groups
  add column if not exists reply_enabled boolean not null default false;

alter table public.whatsapp_groups
  add column if not exists reply_scope text not null default 'plain';

alter table public.whatsapp_groups drop constraint if exists whatsapp_groups_reply_scope_check;
alter table public.whatsapp_groups
  add constraint whatsapp_groups_reply_scope_check
  check (reply_scope in ('plain', 'knowledge', 'internal'));

alter table public.whatsapp_groups
  add column if not exists reply_space_id uuid references public.kb_collections(id) on delete set null;

alter table public.whatsapp_groups
  add column if not exists reply_enabled_by uuid references public.users(id) on delete set null;

alter table public.whatsapp_groups
  add column if not exists reply_enabled_at timestamptz;

alter table public.whatsapp_groups
  add column if not exists reply_limit_per_hour integer not null default 10;

create index if not exists whatsapp_groups_org_reply_idx
  on public.whatsapp_groups (organization_id, reply_enabled);

comment on column public.whatsapp_groups.reply_enabled is
  'Whether Cortex may answer in this group when mentioned. Completely independent of archive_enabled: answering risks disclosure OUTSIDE the company, archiving risks it inside, and the same group rarely wants both. See migration 0072.';
comment on column public.whatsapp_groups.reply_scope is
  'What Cortex may reach for when answering here. `plain` (default) is no tools at all — it answers from the conversation in the room. `knowledge` adds read-only Brain Knowledge limited to reply_space_id. `internal` adds the asker''s read-only business tools and is only for rooms with no outsiders.';
comment on column public.whatsapp_groups.reply_space_id is
  'The ONE Brain Knowledge space that may be cited in this group, and it must be a global (company-wide) space. Personal spaces are structurally excluded: there is no correct way to quote one person''s private notes into a room containing a client.';

-- ===========================================================================
-- 2. One row per mention: the dedupe, the rate limit and the audit trail
-- ===========================================================================
-- Written BEFORE the answer is composed, not after. A row that exists means
-- "this mention is being handled", which is what makes a re-delivered message
-- free; a row that exists with an outcome says what happened and is what an
-- operator reads when somebody asks why Cortex did or did not say something.
create table if not exists public.whatsapp_group_replies (
  id              uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  group_jid       text not null,
  -- WhatsApp's id for the message that mentioned Cortex.
  message_id      text not null,
  sender_jid      text,
  -- The Cortex person the sender resolved to. NULL means the number is not
  -- linked to anybody, which is exactly why nothing was executed.
  user_id         uuid references public.users(id) on delete set null,
  outcome         text not null default 'claimed'
    check (outcome in (
      -- Claimed but not yet resolved; only visible if the process died midway.
      'claimed',
      -- Answered in the group.
      'answered',
      -- Answered in the group with the substance sent privately instead.
      'withheld',
      -- The number is not linked to a person, and Cortex said so once. No tool
      -- ran either way. See the header.
      'unlinked',
      -- Handled and deliberately silent: the same unlinked number mentioning
      -- Cortex again inside the cooldown. Distinct from `unlinked` because only
      -- rows that actually produced a message count against the per-hour
      -- ceiling — otherwise a stranger could mute Cortex for the whole room
      -- just by tapping the name, which is a denial of service with no
      -- privileges required.
      'ignored',
      -- Over the per-hour ceiling for this group. Silent.
      'rate_limited',
      -- The turn broke. Recorded so it is visible rather than mysterious.
      'failed'
    )),
  /** Which privacy rule redirected the answer, when one did. */
  withheld_reason text,
  created_at      timestamptz not null default now()
);

-- The dedupe. A mention is answered once, ever.
create unique index if not exists whatsapp_group_replies_org_group_msg_idx
  on public.whatsapp_group_replies (organization_id, group_jid, message_id);

-- The rate-limit query: "how many times has Cortex spoken in this group in the
-- last hour", and the once-a-day refusal lookup for an unlinked number.
create index if not exists whatsapp_group_replies_window_idx
  on public.whatsapp_group_replies (organization_id, group_jid, created_at desc);

comment on table public.whatsapp_group_replies is
  'One row per @mention of Cortex in a WhatsApp group, claimed before the answer is composed. The unique index is what stops the same mention being answered twice; counting recent rows is the per-group rate limit; the outcome column is why Cortex did or did not speak.';
