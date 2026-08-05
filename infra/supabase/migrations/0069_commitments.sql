-- Commitments: the dated promises this company has to keep, watched by Cortex
-- instead of by whoever happens to remember them.
--
-- WHAT THIS IS FOR. A postal and customs operator in Colombia lives on dates it
-- did not choose: the SOAT and the tecnomecánica of every truck, the renewal on
-- each client contract, an insurance policy, a warranty, a customs deadline, a
-- payment that was promised for the 15th. Today those live in one person's head,
-- and the week that person takes holiday something lapses. This table is where
-- they live instead, and `commitment_notices` is the record of Cortex having
-- said so, out loud, before it was too late.
--
-- ===========================================================================
-- THE RULE THIS SCHEMA EXISTS TO ENFORCE
-- ===========================================================================
-- A COMMITMENT WITHOUT A VERIFIABLE SOURCE CANNOT EXIST.
--
-- Everything else here is negotiable; this is not. A product that shouts at
-- people about dates is only as good as its worst date. One invented expiry —
-- a model reading "vence en marzo" out of a contract that said no such thing —
-- and every alarm the system raises afterwards is discounted, including the
-- correct ones. The damage is not the false alarm, it is that the true ones
-- stop working.
--
-- So `source_kind` is NOT NULL with no default, and each of its three values
-- carries a CHECK constraint naming what it must produce:
--
--   manual    A person typed it. `source_user_id` is that person. The source
--             of the date is their word, and their word is on the row.
--
--   system    Read out of a system of record — RUNT already returns the SOAT
--             and RTM expiry for a plate. `source_system` names it and
--             `source_read_at` says when it was read, because a scraped value
--             is a fact about a MOMENT, not a standing truth.
--
--   document  Extracted from a document in Brain Knowledge. Needs the document,
--             the chunk, and `source_quote`: the literal sentence the date was
--             read out of. Not a summary, not a paraphrase — the words on the
--             page, so a human can check the claim in one glance. The
--             extraction path additionally refuses any candidate whose quote is
--             not found verbatim in the chunk it claims to come from (see
--             packages/agent-tools/src/commitments/extract.ts).
--
-- And extracted commitments DO NOT ENTER SURVEILLANCE ON THEIR OWN. They land
-- with `review_state = 'pending'`, which the daily watcher filters out, and the
-- constraint `commitments_extracted_needs_human` makes it impossible to mark
-- one confirmed without naming the human who confirmed it and when. The
-- database, not a convention, is what stands between a model's guess and a
-- 6 a.m. alarm on somebody's phone.
--
-- ===========================================================================
-- A DEADLINE IS A CALENDAR DAY, NOT AN INSTANT
-- ===========================================================================
-- `due_on` is a `date` and every comparison is against the calendar day in
-- Bogotá (UTC-5, no daylight saving). "Se vence hoy" has to mean hoy AQUÍ: a
-- timestamptz compared against `now()` reports a 4 December deadline as expired
-- from 19:00 on the 3rd for anyone in Colombia, and reports it as still fine
-- until 19:00 on the 4th if the server clock is read the other way round. Both
-- are wrong, and both are the kind of wrong nobody notices until an alarm fires
-- a day early for a month. Storing a date removes the question entirely; the
-- single place the timezone is applied is `bogotaToday()` in
-- packages/agent-tools/src/commitments/shape.ts, and it is unit-tested at the
-- midnight boundary.
--
-- ===========================================================================
-- STATE
-- ===========================================================================
-- Named for what the thing IS, which is how the people using it talk:
--
--   in_force  vigente   — emerald. In force, nothing to do.
--   due_soon  por vencer— amber. Inside its own warning window.
--   overdue   vencido   — rose. The day passed and nobody closed it.
--   met       cumplido  — done: renewed, paid, filed.
--   dropped   descartado— no longer applies (truck sold, contract cancelled).
--
-- The first three are a pure function of `due_on`, `notice_days` and today, so
-- the stored column is a CACHE, refreshed by the daily watcher, kept only so
-- the screen and the tools can filter and sort in the database. Nothing reads
-- it to decide anything: `deriveState()` recomputes from the date every time a
-- row is displayed, so a row is never a day stale between watcher runs. The
-- only authoritative stored states are the two a human sets, `met` and
-- `dropped`, and the watcher never overwrites those.
--
-- ===========================================================================
-- RECURRENCE, AND WHY IT IS NOT ONE THING
-- ===========================================================================
-- The SOAT expires every year. That does not make "due_on + 1 year" a fact.
--
--   from_source  For anything a system of record reports (SOAT, RTM). Cortex
--                does NOT roll these forward. The next expiry is whatever RUNT
--                says on the next consult, and until it says so there is no
--                next commitment. Rolling it forward ourselves would be
--                inventing a date and filing it as read-from-RUNT, which is
--                precisely the failure this whole schema is built against.
--
--   monthly / quarterly / yearly
--                For a cadence a PERSON stated ("this rent is due on the 5th,
--                every month"). Advancing it is not inference, it is what they
--                said. The successor inherits the source: a manual one stays
--                confirmed, a document-sourced one lands PENDING again, because
--                the contract named one date, not every future date.
--
-- History is kept whole: fulfilling a commitment never mutates its date. The
-- old row stays, `met`, with its own notices and its own provenance, and the
-- successor is a new row pointing back through `previous_commitment_id`.
-- `commitments_successor_once_idx` makes a double rollover impossible in the
-- database, so a retried job cannot produce two next-years.
--
-- ===========================================================================
-- TENANCY
-- ===========================================================================
-- `organization_id` on every row, both tables registered as `tenant()` in
-- packages/agent-tools/src/tenancy/tables.ts, and the application only ever
-- holds a scoped handle (0064). RLS is deny-all + service_role, the same
-- posture as 0065 and 0067 — see the 0064 header for why an `auth.uid()` policy
-- would be theatre in this schema, and why the column here is the whole
-- prerequisite for making RLS real later.
--
-- Idempotent throughout.

-- ===========================================================================
-- 1. The commitments themselves
-- ===========================================================================

create table if not exists public.commitments (
  id                     uuid        primary key default gen_random_uuid(),
  organization_id        text        not null references public.ba_organization(id) on delete cascade,

  -- What is owed ----------------------------------------------------------
  title                  text        not null check (length(btrim(title)) between 1 and 200),
  detail                 text        check (length(detail) <= 2000),
  -- Drives the default warning window and the wording of the notice. 'other'
  -- is a legitimate answer, not a fallback for laziness — a promise made on a
  -- call fits nowhere else and still deserves watching.
  kind                   text        not null default 'other'
                                     check (kind in ('soat','rtm','contract','policy',
                                                     'warranty','customs','payment','other')),
  -- Who it is with. Free text ON PURPOSE: this install has no customers table
  -- (people/ and hubspot/ are API clients over systems that live elsewhere),
  -- and inventing one to hold a name would be a worse lie than a string. When a
  -- real customer record exists, this becomes a foreign key and the text stays
  -- as the fallback for counterparties that are not customers.
  counterparty           text        check (length(counterparty) <= 160),
  -- Only meaningful for kind='payment'. Pesos, no decimals — COP has none.
  amount_cop             bigint      check (amount_cop >= 0),

  -- When ------------------------------------------------------------------
  due_on                 date        not null,
  -- How far ahead the first warning goes out. No per-kind default is possible
  -- here (a column default cannot read another column), so the sensible value
  -- per kind lives in DEFAULT_NOTICE_DAYS in shape.ts — a month for a SOAT,
  -- three days for a payment — and every writer passes it explicitly. The
  -- default below is only the floor for a row written by hand in SQL.
  notice_days            int         not null default 15 check (notice_days between 0 and 365),

  -- State -----------------------------------------------------------------
  state                  text        not null default 'in_force'
                                     check (state in ('in_force','due_soon','overdue','met','dropped')),
  met_at                 timestamptz,
  met_by                 uuid        references public.users(id) on delete set null,
  met_note               text        check (length(met_note) <= 500),
  dropped_at             timestamptz,
  dropped_reason         text        check (length(dropped_reason) <= 500),

  -- Who answers for it ----------------------------------------------------
  owner_user_id          uuid        references public.users(id) on delete set null,
  -- Where it goes when the day arrives and nothing happened. Null means "the
  -- workspace admins", resolved at escalation time rather than frozen here.
  escalate_to_user_id    uuid        references public.users(id) on delete set null,
  escalate_after_days    int         not null default 3 check (escalate_after_days between 0 and 90),

  -- WHERE THE DATE CAME FROM. Read the header. -----------------------------
  source_kind            text        not null check (source_kind in ('manual','system','document')),
  source_system          text        check (length(source_system) <= 60),
  source_read_at         timestamptz,
  source_user_id         uuid        references public.users(id) on delete set null,
  source_document_id     uuid        references public.kb_documents(id) on delete set null,
  source_chunk_id        uuid        references public.kb_chunks(id) on delete set null,
  source_quote           text        check (length(source_quote) <= 600),

  review_state           text        not null default 'confirmed'
                                     check (review_state in ('pending','confirmed','rejected')),
  confirmed_at           timestamptz,
  confirmed_by           uuid        references public.users(id) on delete set null,
  rejected_at            timestamptz,
  rejected_by            uuid        references public.users(id) on delete set null,

  -- What it hangs off ------------------------------------------------------
  -- A truck's SOAT is a commitment ABOUT that truck: selling the truck should
  -- take its paperwork deadlines with it, hence cascade.
  vehicle_id             uuid        references public.vehicles(id) on delete cascade,

  -- Recurrence -------------------------------------------------------------
  recurrence             text        not null default 'none'
                                     check (recurrence in ('none','monthly','quarterly','yearly','from_source')),
  -- Every occurrence of the same standing obligation shares this, so "show me
  -- the history of this SOAT" is one query and does not depend on walking the
  -- previous_commitment_id chain backwards.
  series_id              uuid        not null default gen_random_uuid(),
  previous_commitment_id uuid        references public.commitments(id) on delete set null,

  -- Google Calendar, one way only (Cortex -> Calendar) ---------------------
  -- The event lives on the calendar of whoever answers for the commitment, so
  -- `calendar_user_id` is the person whose Google credential created it — kept
  -- because it is the only credential that can update or delete it later.
  calendar_event_id      text,
  calendar_id            text,
  calendar_user_id       uuid        references public.users(id) on delete set null,
  -- The due date the event currently reflects. When it differs from due_on the
  -- event has to be moved; when the event is gone from Google it is recreated.
  calendar_synced_due_on date,
  calendar_error         text        check (length(calendar_error) <= 500),

  created_by             uuid        references public.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- --- The rule, in constraints -------------------------------------------
  constraint commitments_source_manual check (
    source_kind <> 'manual' or source_user_id is not null
  ),
  constraint commitments_source_system check (
    source_kind <> 'system' or (source_system is not null and source_read_at is not null)
  ),
  -- A quote of five characters is not a citation. Eight is still short, and is
  -- there to stop "n/a" and "-" rather than to judge prose.
  constraint commitments_source_document check (
    source_kind <> 'document'
    or (source_document_id is not null
        and source_quote is not null
        and length(btrim(source_quote)) >= 8)
  ),
  -- An extracted date can only become watchable through a person. There is no
  -- code path that can set review_state='confirmed' on one without recording
  -- who did it, because there is no such row.
  constraint commitments_extracted_needs_human check (
    source_kind <> 'document'
    or review_state <> 'confirmed'
    or (confirmed_by is not null and confirmed_at is not null)
  ),
  constraint commitments_met_has_time check (state <> 'met' or met_at is not null),
  constraint commitments_dropped_has_time check (state <> 'dropped' or dropped_at is not null)
);

-- The screen, and the watcher's daily scan: what is open in this workspace,
-- soonest first.
create index if not exists commitments_org_state_due_idx
  on public.commitments (organization_id, state, due_on);

-- The review inbox — the extracted ones waiting for a human.
create index if not exists commitments_org_review_idx
  on public.commitments (organization_id, review_state, created_at desc);

-- "What is on my plate", and the escalation lookup.
create index if not exists commitments_org_owner_due_idx
  on public.commitments (organization_id, owner_user_id, due_on);

-- The history of one standing obligation, oldest first.
create index if not exists commitments_series_idx
  on public.commitments (series_id, due_on);

-- Fleet sync idempotency. RUNT reporting the same SOAT expiry for the same
-- plate on Tuesday as on Monday must update one row, not add a second — the
-- sync upserts on exactly this key.
create unique index if not exists commitments_vehicle_kind_due_idx
  on public.commitments (organization_id, vehicle_id, kind, due_on)
  where vehicle_id is not null;

-- Recurrence cannot fork. A retried "mark met" that tries to create a second
-- successor for the same occurrence is rejected by the database rather than by
-- a hopeful `if (!exists)` in application code.
create unique index if not exists commitments_successor_once_idx
  on public.commitments (previous_commitment_id)
  where previous_commitment_id is not null;

comment on table public.commitments is
  'Dated promises the company has to keep: fleet paperwork, contracts, policies, warranties, customs deadlines and payments. Every row records where its date came from (source_kind + its evidence), and anything extracted from a document stays review_state=pending — invisible to the watcher — until a person confirms it.';

comment on column public.commitments.source_kind is
  'manual | system | document. Never null and never defaulted: a commitment whose date has no traceable origin is exactly the thing this table refuses to hold. Each value has its own CHECK constraint naming the evidence it must carry.';

comment on column public.commitments.source_quote is
  'The literal sentence the date was read out of, for document-sourced rows. Verified to appear verbatim in source_chunk_id at extraction time; a candidate whose quote cannot be found is discarded rather than saved with a paraphrase.';

comment on column public.commitments.review_state is
  'pending until a human confirms an extracted commitment. The daily watcher only ever reads confirmed rows, so a pending one raises no alarm and sends no mail.';

comment on column public.commitments.state is
  'in_force / due_soon / overdue are a cache of a pure function of due_on, notice_days and today in Bogotá — recomputed on every read by deriveState(). met and dropped are set by people and the watcher never touches them.';

comment on column public.commitments.due_on is
  'A calendar day, not an instant. Always compared against the current day in America/Bogota (UTC-5); see the migration header.';

comment on column public.commitments.recurrence is
  'from_source means Cortex will NOT roll this forward — the next SOAT expiry comes from RUNT, not from arithmetic. monthly/quarterly/yearly are cadences a person stated, and rolling those forward is repeating what they said rather than guessing.';

comment on column public.commitments.calendar_event_id is
  'The Google Calendar event id, so the event can be moved when the date changes and removed when the commitment is met. Sync is one-way, Cortex -> Calendar; see commitments/calendar.ts for why.';

-- ===========================================================================
-- 2. What was already said, to whom, and whether anybody answered
-- ===========================================================================
-- This table is the reason the same commitment does not shout every morning.
--
-- A row is a CLAIM on one notice, taken before the mail is sent, and
-- `commitment_notices_once_idx` makes the claim unique per (commitment,
-- notice kind, occurrence). So a watcher run that overlaps another, or is
-- retried by Inngest, or runs twice because somebody redeployed at 06:00,
-- inserts nothing the second time and sends nothing the second time.
--
-- `delivered` records the outcome separately from the claim. A claim whose
-- send failed (Resend down, no address on file) stays delivered=false and is
-- retried by the next day's run — the row is not re-created, only the attempt
-- is repeated. Delivered rows are never touched again. At-most-once for the
-- message, at-least-once for the attempt, which is the right way round: the
-- cost of a repeated attempt is one API call, the cost of a repeated MESSAGE is
-- a person learning to ignore Cortex.
--
-- FOUR KINDS, DELIBERATELY NOT MORE. One warning when it enters its window,
-- one on the day, one when it lapses, one escalation. There is no daily nag:
-- an overdue commitment is already sitting in rose at the top of the screen,
-- and the answer to "nobody is acting on it" is to tell somebody ELSE
-- (escalation), not to tell the same person again in the same words.

create table if not exists public.commitment_notices (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  commitment_id       uuid        not null references public.commitments(id) on delete cascade,

  notice_kind         text        not null
                                  check (notice_kind in ('ahead','due_today','overdue','escalation')),
  -- The occurrence this notice was about. Part of the key, so deliberately
  -- moving a due date re-opens the notices for the NEW date — which is correct:
  -- a rescheduled deadline is a different deadline and deserves its own warning.
  due_on              date        not null,
  -- The calendar day in Bogotá the notice went out. Reporting, not identity.
  sent_on             date        not null,

  channel             text        not null default 'email'
                                  check (channel in ('email','calendar','none')),
  recipient_user_id   uuid        references public.users(id) on delete set null,
  recipient_email     text,

  delivered           bool        not null default false,
  delivery_note       text        check (length(delivery_note) <= 500),

  -- Somebody saw it and said so. The escalation rule reads this: an overdue
  -- commitment whose notice was acknowledged is being handled, and going over
  -- that person's head would be wrong.
  acknowledged_at     timestamptz,
  acknowledged_by     uuid        references public.users(id) on delete set null,

  created_at          timestamptz not null default now()
);

-- The whole anti-repetition mechanism, in one index.
create unique index if not exists commitment_notices_once_idx
  on public.commitment_notices (commitment_id, notice_kind, due_on);

create index if not exists commitment_notices_org_sent_idx
  on public.commitment_notices (organization_id, sent_on desc);

create index if not exists commitment_notices_commitment_idx
  on public.commitment_notices (commitment_id, created_at desc);

comment on table public.commitment_notices is
  'One row per notice Cortex has already sent about one occurrence of one commitment. The unique index on (commitment_id, notice_kind, due_on) is what makes the daily watcher idempotent: running it twice claims nothing the second time and therefore sends nothing.';

comment on column public.commitment_notices.delivered is
  'False means the claim was taken but the message did not go out (mail not configured, provider error). The next run retries the send on the same row; it never creates a second one.';

comment on column public.commitment_notices.acknowledged_at is
  'Set when a person marks the notice seen. Suppresses escalation: going over somebody''s head when they already answered is how an escalation path gets switched off.';

-- ===========================================================================
-- 3. Access
-- ===========================================================================
-- Deny-all + service_role, matching 0065 and 0067. The tenant boundary is
-- createOrgScopedClient, not a policy keyed off auth.uid().

alter table public.commitments enable row level security;
alter table public.commitment_notices enable row level security;

revoke all on table public.commitments from public, anon, authenticated;
revoke all on table public.commitment_notices from public, anon, authenticated;

grant select, insert, update, delete on table public.commitments to service_role;
grant select, insert, update, delete on table public.commitment_notices to service_role;
