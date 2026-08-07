-- Selling Cortex: a company that can start on its own, a meter it can audit,
-- and a plan that says what happens when it runs out.
--
-- WHAT WAS MISSING. Migration 0064 made the product multi-tenant for real —
-- every row belongs to exactly one workspace, and `createOrgScopedClient`
-- refuses to touch a table nobody has classified. That is the hard half, and it
-- is done. What it does not give you is a BUSINESS: today a second company can
-- only start because somebody on our side applies migrations and pastes keys,
-- and once it has started nothing anywhere says what it is allowed to consume
-- or what it owes. For company number two that is annoying. For company number
-- five it is impossible.
--
-- This migration adds the four things that turn tenancy into a product:
--
--   § 2  plans                        what you can buy, and what it includes
--   § 3  organization_subscriptions   which plan each workspace is on
--   § 4  usage_events                 the append-only ledger: one row per unit
--   § 5  usage_counters               the same numbers, pre-added, for the gate
--   § 8  organization_onboarding      the one question a new company answers
--
-- ===========================================================================
-- THE UNIT: RESPUESTAS AND DOCUMENTOS, NOT TOKENS
-- ===========================================================================
-- What costs us money is model tokens, embeddings and Deepgram minutes. What a
-- customer can hold in their head is neither of those. Nobody has ever decided
-- to buy 4.2 million tokens; a warehouse lead in Bogotá decides whether Cortex
-- answering two thousand questions a month is worth what it costs.
--
-- So the meters are the two things the customer actually DOES:
--
--   answers    one row every time Cortex answers somebody. Chat, WhatsApp,
--              Google Chat, a routine, MCP — the surface does not change the
--              price, because it does not change what the customer got.
--
--   documents  one row every time something enters Brain Knowledge. An uploaded
--              contract, a Drive file, an archived mail thread, a recording.
--
-- Two meters and not one, deliberately. A single blended "credit" would be a
-- token by another name: the customer would have to learn an exchange rate to
-- predict their own bill, which is the exact failure of pricing in tokens. Two
-- meters map onto two sentences somebody says out loud — "Cortex nos respondió
-- 1.240 veces" and "tenemos 800 documentos adentro" — and each one has its own
-- cost curve, so blending them would also make the price wrong.
--
-- Transcription is NOT a third meter. An hour of audio becomes one document,
-- and that is how the customer experiences it: they added a recording. Charging
-- separately for the minutes would reintroduce a unit nobody asked for, on the
-- one input that is already the most expensive to produce.
--
-- ===========================================================================
-- WHY THE METER IS A TRIGGER AND NOT A FUNCTION CALL
-- ===========================================================================
-- This is the same argument as tables.ts, applied to money.
--
-- `recordUsage(db, …)` at every call site works exactly as long as everybody
-- remembers. An answer is persisted from six places today and will be persisted
-- from a seventh next quarter; a document is created from at least five. One of
-- those will be written without the meter call, it will pass review because it
-- looks like the code next to it, and the customer will be undercharged with no
-- error, no log line and no failing test. Undercharging silently is a slower
-- version of the same bug as leaking rows: nobody finds out from the inside.
--
-- So the meter fires where the work is RECORDED, not where somebody remembers
-- to bill for it. `public.messages` and `public.kb_documents` already have to be
-- written for the product to work at all — a path that skips them has not
-- produced an answer or a document. Metering off those two inserts means:
--
--   * it cannot be forgotten, because it is not a step anybody performs;
--   * it cannot double-count, because of the unique index in § 4;
--   * it cannot disagree with the product, because the ledger row and the thing
--     it bills for are written in the same transaction.
--
-- The counters in § 5 are maintained by a third trigger on the ledger itself,
-- in that same transaction, so the number the gate reads and the number the
-- customer can audit cannot drift apart. § 6 ships a function that proves it.
--
-- ===========================================================================
-- METERING STARTS TODAY, NOT RETROACTIVELY
-- ===========================================================================
-- The ledger is NOT backfilled from the messages and documents that already
-- exist. Two reasons, and the second is the real one. First, a backfill over
-- every message in the install is a long write on tables the product is using.
-- Second and decisive: a ledger is a claim about what somebody owes, and we
-- would be manufacturing that claim after the fact for a period during which
-- nobody had agreed to a plan. The honest statement is the one the product
-- makes on screen — "tu consumo se mide desde hoy" — and it costs us one month
-- of revenue that was never contracted anyway.
--
-- ===========================================================================
-- THE WORKSPACE THAT ALREADY EXISTS LOSES NOTHING
-- ===========================================================================
-- There is a real company in production with real data. § 7 puts every
-- workspace that exists at the moment this migration runs onto the `custom`
-- plan, whose three limits are all NULL, which the entitlement code reads as
-- "sin límite" — no gate, no margin, no block, no banner. Only workspaces
-- CREATED AFTER this migration get `free`, via the trigger in § 7. That is not
-- a courtesy setting somebody has to remember to apply; it is the shape of the
-- backfill, so a grandfathered workspace cannot be downgraded by an omission.
--
-- Idempotent throughout: `create table if not exists`, `create index if not
-- exists`, `create or replace function`, `drop trigger if exists` before each
-- `create trigger`, and inserts guarded by `on conflict do nothing`.
--
-- No new enum values anywhere. Every closed set here is `text` plus a check
-- constraint, on purpose: an enum value cannot be USED in the transaction that
-- adds it, and this file both adds and uses its vocabulary.


-- ===========================================================================
-- 1. The billing period
-- ===========================================================================
-- A period is a calendar month in America/Bogota, as 'YYYY-MM'.
--
-- Calendar month rather than "30 days from the day you signed up", because the
-- reader of the bill is a Colombian administrator who closes a month, and a
-- period that starts on the 14th makes every conversation about the invoice
-- start with arithmetic. Bogotá rather than UTC for the same reason: a
-- conversation at 8pm on the 31st belongs to the month the person was living
-- in, not to the one Greenwich was.
--
-- STABLE, not IMMUTABLE, because `timestamptz at time zone <text>` depends on
-- the timezone database. That is also why `usage_events.period` is a plain
-- stored column filled by the trigger rather than a generated column —
-- Postgres will not accept a stable expression in `generated always as`, and
-- declaring this immutable to get around that would be a lie that survives
-- until the next tzdata update.
--
-- `usagePeriod()` in packages/agent-tools/src/billing/plans.ts computes the
-- same string in TypeScript, from Intl with the same timezone. The two are
-- checked against each other in that module's tests.

create or replace function public.usage_period_of(at timestamptz)
returns text
language sql
stable
as $$
  select to_char(at at time zone 'America/Bogota', 'YYYY-MM')
$$;

comment on function public.usage_period_of(timestamptz) is
  'The billing period a moment falls in: calendar month in America/Bogota, as YYYY-MM. Mirrored in TypeScript by usagePeriod() in packages/agent-tools/src/billing/plans.ts.';


-- ===========================================================================
-- 2. Plans — what you can buy
-- ===========================================================================
-- Product content, identical for every workspace, exactly like
-- `tool_embeddings`. Registered as `shared()` in the tenancy registry with that
-- reason. A workspace never writes here.
--
-- A NULL limit means "sin límite". It is deliberately not a large number: a
-- sentinel like 999999999 reads as a limit in every screen that formats it, and
-- somebody eventually renders "999.999.999 respuestas restantes" to a customer.
-- NULL forces the entitlement code to have a branch for the unlimited case,
-- which is what the grandfathered workspace needs it to have.

create table if not exists public.plans (
  code              text primary key,
  name              text        not null,
  tagline           text        not null,
  -- Monthly price in Colombian pesos, as an integer. COP is quoted without
  -- cents in every real invoice in this market, and storing it in the currency
  -- it is charged in means no rounding step stands between the number on the
  -- page and the number on the bill.
  price_cop         integer     not null default 0 check (price_cop >= 0),
  -- NULL = sin límite. See the note above.
  answers_limit     integer     check (answers_limit is null or answers_limit > 0),
  documents_limit   integer     check (documents_limit is null or documents_limit > 0),
  seats_limit       integer     check (seats_limit is null or seats_limit > 0),
  -- The courtesy margin, as a fraction of the limit, granted ONCE the limit is
  -- crossed. See the long note in § 4 on what happens at the limit.
  grace_ratio       numeric(4,3) not null default 0.100
                      check (grace_ratio >= 0 and grace_ratio <= 1),
  grace_minimum     integer     not null default 10 check (grace_minimum >= 0),
  -- False for plans an owner cannot put themselves on from the product.
  self_serve        boolean     not null default true,
  sort_order        integer     not null default 0,
  created_at        timestamptz not null default now()
);

comment on table public.plans is
  'The plan catalogue. Product content, not tenant data: every workspace sees the same rows and none of them writes here. A NULL limit means sin limite; see migration 0085 section 2 for why it is not a sentinel number.';

-- The numbers. They are here rather than in TypeScript because the entitlement
-- decision has to be answerable from SQL when somebody is looking at a bill
-- with a psql prompt open, and because a limit that lives in a deploy is a
-- limit that changes when an unrelated deploy goes out.
--
-- `on conflict (code) do nothing` and not `do update`: re-running this file
-- must never quietly move a paying workspace's ceiling. Prices and limits are
-- changed by a later migration that says so.

insert into public.plans
  (code, name, tagline, price_cop, answers_limit, documents_limit, seats_limit, self_serve, sort_order)
values
  ('free', 'Gratis',
   'Para probar Cortex con tu equipo, sin tarjeta.',
   0, 150, 50, 3, true, 1),
  ('team', 'Equipo',
   'Para un equipo que ya trabaja adentro todos los días.',
   290000, 2000, 1000, 15, true, 2),
  ('business', 'Empresa',
   'Para varias áreas, con todo el archivo adentro.',
   980000, 10000, 10000, 60, true, 3),
  ('custom', 'A la medida',
   'Volumen acordado contigo. Sin límites en el producto.',
   0, null, null, null, false, 4)
on conflict (code) do nothing;


-- ===========================================================================
-- 3. Which plan a workspace is on
-- ===========================================================================
-- One row per workspace. Tenant data — the plan a company is on, what it is
-- paying and whether it is behind is nobody else's business — so it carries
-- `organization_id` and is registered as `tenant()`, even though it will only
-- ever hold one row per tenant.
--
-- `status` is text with a check rather than an enum for the reason in the
-- header: this file both defines and uses the vocabulary.

create table if not exists public.organization_subscriptions (
  organization_id           text        primary key
                              references public.ba_organization(id) on delete cascade,
  plan_code                 text        not null references public.plans(code),
  status                    text        not null default 'active'
                              check (status in ('active', 'past_due', 'canceled')),
  started_at                timestamptz not null default now(),
  -- BILLING IS PREPARED, NOT WIRED. These two columns are where a gateway's
  -- customer and subscription identifiers go on the day a commercial decision
  -- exists. Nothing writes them today and no gateway SDK is installed. See the
  -- note in packages/agent-tools/src/billing/plans.ts for why integrating one
  -- before the price and the collection method are decided is work that gets
  -- thrown away — in this market the realistic rails (Wompi, PayU, dLocal) and
  -- Stripe do not even agree on what a subscription IS.
  billing_customer_ref      text,
  billing_subscription_ref  text,
  -- Why this workspace is on this plan, when a human decided it.
  notes                     text,
  updated_at                timestamptz not null default now()
);

comment on table public.organization_subscriptions is
  'The plan each workspace is on. One row per workspace; a missing row is read by the application as the free plan, so a workspace can never end up with no entitlement at all.';

comment on column public.organization_subscriptions.billing_customer_ref is
  'Reserved for a payment gateway customer id. Nothing writes it yet: migration 0085 measures for billing and stops short of collecting. See the header of packages/agent-tools/src/billing/plans.ts.';


-- ===========================================================================
-- 4. The ledger — one row per unit sold
-- ===========================================================================
-- Append-only. Nothing in the product updates or deletes a row here.
--
-- EXACT. `usage_events_unit_idx` is unique on (organization_id, meter,
-- subject_id), and every writer inserts with `on conflict do nothing`. A retry,
-- a replayed Inngest step, a double-submitted form — none of them can charge
-- twice, because the unit IS the row it names. There is no counter anywhere
-- that can be incremented a second time.
--
-- AUDITABLE. Every unit names the row in the product that produced it:
-- `subject_table` + `subject_id` point at a message or a document the customer
-- can open. That is the whole promise — the figure on the invoice is not an
-- assertion, it is a list, and the list is theirs. `cost` carries what the unit
-- actually cost us (tokens, model) as evidence, and is explicitly NOT what is
-- billed; a customer reading it can see why the price is what it is without the
-- price depending on it.
--
-- NEVER CROSSES TENANTS. `organization_id` is copied from the row being
-- metered, which 0064 made NOT NULL on both source tables. The trigger cannot
-- pick the wrong workspace because it does not choose one. Reads go through the
-- scoped client like everything else.
--
-- No foreign key on organization_id, matching 0079. That is a deliberate
-- difference from § 3: a constraint failure here would abort the INSERT of the
-- message or document being metered, and a chat that fails because its receipt
-- failed is a worse product than a receipt that is briefly orphaned.

create table if not exists public.usage_events (
  id             uuid        primary key default gen_random_uuid(),
  organization_id text       not null,
  meter          text        not null check (meter in ('answers', 'documents')),
  quantity       integer     not null default 1 check (quantity > 0),
  -- The row this unit IS, so the customer can open it.
  subject_table  text        not null check (subject_table in ('messages', 'kb_documents')),
  subject_id     uuid        not null,
  -- Where it happened, for the reader: 'web', 'mcp', 'upload', 'gdrive'…
  source         text,
  -- What it cost US. Evidence, never the billed figure.
  cost           jsonb       not null default '{}'::jsonb,
  occurred_at    timestamptz not null default now(),
  period         text        not null
);

comment on table public.usage_events is
  'The consumption ledger: one append-only row per billable unit, naming the message or document it is. Written by triggers on public.messages and public.kb_documents, never by application code. Unique on (organization_id, meter, subject_id), so a unit cannot be counted twice.';

comment on column public.usage_events.cost is
  'What the unit cost us — tokens, model, seconds of audio. Evidence for the reader, never the figure charged. Best-effort and may be empty.';

-- Exactness lives in this index. Everything else about the ledger is a
-- consequence of it.
create unique index if not exists usage_events_unit_idx
  on public.usage_events (organization_id, meter, subject_id);

-- The reading order of the audit screen: one workspace, one meter, one month,
-- newest first.
create index if not exists usage_events_period_idx
  on public.usage_events (organization_id, meter, period, occurred_at desc);


-- ===========================================================================
-- 5. The counters — the same numbers, pre-added
-- ===========================================================================
-- The gate runs before every answer. It cannot count ten thousand ledger rows
-- to decide whether to allow the ten thousand and first, so the total is
-- maintained as it goes.
--
-- WHY THIS DOES NOT DRIFT, WHICH IS THE ONLY THING WRONG WITH A CACHED TOTAL.
-- The counter is updated by an AFTER INSERT trigger on the ledger, so it moves
-- inside the same transaction as the row it summarises. There is no window in
-- which one exists and the other does not, no job that reconciles them, and no
-- code path that writes one without the other — the ledger is the only way in.
-- § 6 ships the function that proves it on demand.

create table if not exists public.usage_counters (
  organization_id text        not null,
  period          text        not null,
  meter           text        not null,
  used            integer     not null default 0,
  first_at        timestamptz not null default now(),
  last_at         timestamptz not null default now(),
  primary key (organization_id, period, meter)
);

comment on table public.usage_counters is
  'Pre-added totals of public.usage_events, one row per (workspace, period, meter). Maintained by a trigger on the ledger inside the same transaction, so it cannot drift from it; usage_counter_drift() re-derives and compares.';

create or replace function public.usage_apply_counter()
returns trigger
language plpgsql
as $$
begin
  insert into public.usage_counters
    (organization_id, period, meter, used, first_at, last_at)
  values
    (new.organization_id, new.period, new.meter, new.quantity, new.occurred_at, new.occurred_at)
  on conflict (organization_id, period, meter) do update
    set used     = public.usage_counters.used + excluded.used,
        first_at = least(public.usage_counters.first_at, excluded.first_at),
        last_at  = greatest(public.usage_counters.last_at, excluded.last_at);
  return null;
end;
$$;

drop trigger if exists usage_events_apply_counter on public.usage_events;
create trigger usage_events_apply_counter
  after insert on public.usage_events
  for each row execute function public.usage_apply_counter();


-- ===========================================================================
-- 6. Proving the counter and the ledger agree
-- ===========================================================================
-- Install-wide maintenance: it takes no workspace and returns no tenant-visible
-- content — a workspace id, a period, a meter and two integers that ought to be
-- equal. Registered as 'maintenance' in RPC_TENANCY.
--
-- It exists because "the total is maintained by a trigger so it cannot drift"
-- is the kind of sentence that is true until it is not, and the customer-facing
-- promise ("this figure is the length of that list") deserves something that
-- can be run rather than believed.

-- The output columns are named `drift_*` rather than after the columns they
-- report. In a LANGUAGE sql function, RETURNS TABLE names are parameters and
-- share a namespace with column references in the body; naming an output
-- `organization_id` while the body also selects one is how a function that
-- reads correctly fails to create.
create or replace function public.usage_counter_drift()
returns table (
  drift_organization_id text,
  drift_period          text,
  drift_meter           text,
  drift_counter_used    integer,
  drift_ledger_used     bigint
)
language sql
stable
as $$
  select
    c.organization_id,
    c.period,
    c.meter,
    c.used                               as counter_used,
    coalesce(sum(e.quantity), 0)::bigint as ledger_used
  from public.usage_counters c
  left join public.usage_events e
    on  e.organization_id = c.organization_id
    and e.period          = c.period
    and e.meter           = c.meter
  group by c.organization_id, c.period, c.meter, c.used
  having c.used <> coalesce(sum(e.quantity), 0)
$$;

comment on function public.usage_counter_drift() is
  'Every (workspace, period, meter) whose pre-added counter disagrees with the ledger it summarises. Returns zero rows when the two agree, which is the expected state. Install-wide maintenance: no tenant argument, no tenant content returned.';

revoke all on function public.usage_counter_drift() from public;


-- ===========================================================================
-- 7. Where a workspace's plan comes from
-- ===========================================================================
-- THE GRANDFATHER CLAUSE. Every workspace that exists right now goes onto
-- `custom`, whose limits are all NULL. Read the header: this is not a courtesy
-- flag somebody sets later, it is the backfill itself, so the production
-- workspace cannot be gated by an omission in code that ships next week.
--
-- The two reserved service workspaces from 0064 are skipped. Neither has
-- members, so neither can ever be a session's active workspace, and giving
-- them a subscription would put two rows in every operator's plan listing that
-- mean nothing.

insert into public.organization_subscriptions (organization_id, plan_code, status, notes)
select
  o.id,
  'custom',
  'active',
  'Existía antes de que hubiera planes (migración 0085). Sin límites, sin cambios.'
from public.ba_organization o
where o.id not in ('cortex-template', 'cortex-quarantine')
on conflict (organization_id) do nothing;

-- From here on a new workspace gets `free` the moment it is created — see the
-- trigger at the end of § 8, which is where it lives because its function also
-- writes the onboarding row and that table is defined there.


-- ===========================================================================
-- 8. Onboarding — the one question, and what is derived instead of asked
-- ===========================================================================
-- The first ten minutes have to end in a useful answer, and a useful answer
-- needs something to answer FROM. So the product asks exactly one question —
-- what do you want Cortex to do first — and that answer chooses which source to
-- connect and which question to put in the box. Everything else about progress
-- is DERIVED from the data (is there an integration row, is there a document,
-- has an assistant message ever been written, is there a second member) rather
-- than stored as checkboxes, because a checkbox and the world drift apart and
-- the world is the thing the customer is looking at.
--
-- That leaves this table with only what cannot be derived: the answer to the
-- question, the company name somebody typed at signup, and whether they closed
-- the guide.

create table if not exists public.organization_onboarding (
  organization_id text        primary key
                    references public.ba_organization(id) on delete cascade,
  -- The one question. Null until answered; answering it re-orders the guide.
  primary_goal    text        check (primary_goal in ('email', 'documents', 'deadlines', 'meetings')),
  -- What the person typed as their company at signup, kept so the workspace can
  -- be renamed later without losing what they originally called themselves.
  company_name    text,
  -- Set when somebody closes the guide. Not "completed" — the steps decide that
  -- from the data.
  dismissed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.organization_onboarding is
  'What the first-run guide cannot derive: the answer to "what should Cortex do first", the company name typed at signup, and whether the guide was dismissed. Progress itself is read from integrations, kb_documents, messages and ba_member.';

-- Existing workspaces are past this. Marked dismissed so nobody who has been
-- using Cortex for months is shown a first-run guide by a migration.
insert into public.organization_onboarding (organization_id, dismissed_at)
select o.id, now()
from public.ba_organization o
where o.id not in ('cortex-template', 'cortex-quarantine')
on conflict (organization_id) do nothing;

-- What every new workspace gets, the moment it is created.
--
-- A trigger rather than a line in `createWorkspace` (apps/web/lib/organization.ts)
-- for the same reason the meters are triggers: a workspace is ALSO created by
-- better-auth's own organization.create endpoint, which is code we do not own.
-- Two writers, one rule, enforced where both of them land.
--
-- Defined here, after both tables it writes to exist. `create or replace
-- function` does not resolve a plpgsql body at creation time, so the order is
-- not strictly required — but a reader should not have to know that, and the
-- next person to add a statement to this function should not find out the hard
-- way.

create or replace function public.organization_default_subscription()
returns trigger
language plpgsql
as $$
begin
  if new.id in ('cortex-template', 'cortex-quarantine') then
    return null;
  end if;

  insert into public.organization_subscriptions (organization_id, plan_code)
  values (new.id, 'free')
  on conflict (organization_id) do nothing;

  insert into public.organization_onboarding (organization_id)
  values (new.id)
  on conflict (organization_id) do nothing;

  return null;
end;
$$;

drop trigger if exists ba_organization_default_plan on public.ba_organization;
create trigger ba_organization_default_plan
  after insert on public.ba_organization
  for each row execute function public.organization_default_subscription();


-- ===========================================================================
-- 9. The meters
-- ===========================================================================
-- Both are AFTER INSERT, both return null (nothing downstream reads the result),
-- and both swallow their own failure.
--
-- SWALLOWING IS NOT SLOPPINESS, IT IS THE ORDER OF PRIORITIES. `recordEmbeddingUsage`
-- makes the same choice and says why: the chunks are the product, the receipt is
-- a receipt. Here the stakes are higher in one direction and lower in the other
-- — a metering failure that aborted the transaction would fail the customer's
-- CHAT, which is unacceptable, while a metering failure that is swallowed costs
-- us one unit of revenue and shows up in usage_counter_drift() the moment
-- anybody looks. The only realistic way in is a constraint we have not thought
-- of; taking the product down over it would be the wrong trade every time.

create or replace function public.usage_meter_answer()
returns trigger
language plpgsql
as $$
declare
  v_source text;
begin
  -- Only what Cortex said. A user's own message is not a unit of anything, and
  -- 'system'/'tool' rows are bookkeeping.
  if new.role <> 'assistant' then
    return null;
  end if;
  if new.organization_id is null then
    return null;
  end if;

  begin
    select c.surface::text
      into v_source
      from public.conversations c
     where c.id = new.conversation_id;

    insert into public.usage_events
      (organization_id, meter, quantity, subject_table, subject_id, source, occurred_at, period)
    values
      (new.organization_id, 'answers', 1, 'messages', new.id,
       coalesce(v_source, 'other'), new.created_at,
       public.usage_period_of(new.created_at))
    on conflict (organization_id, meter, subject_id) do nothing;
  exception when others then
    -- See the note above. The answer has already reached the person.
    null;
  end;

  return null;
end;
$$;

drop trigger if exists messages_usage_meter on public.messages;
create trigger messages_usage_meter
  after insert on public.messages
  for each row execute function public.usage_meter_answer();

create or replace function public.usage_meter_document()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id is null then
    return null;
  end if;

  begin
    insert into public.usage_events
      (organization_id, meter, quantity, subject_table, subject_id, source, occurred_at, period)
    values
      (new.organization_id, 'documents', 1, 'kb_documents', new.id,
       new.source::text, new.created_at,
       public.usage_period_of(new.created_at))
    on conflict (organization_id, meter, subject_id) do nothing;
  exception when others then
    null;
  end;

  return null;
end;
$$;

drop trigger if exists kb_documents_usage_meter on public.kb_documents;
create trigger kb_documents_usage_meter
  after insert on public.kb_documents
  for each row execute function public.usage_meter_document();


-- ===========================================================================
-- 10. Row-level security posture
-- ===========================================================================
-- Deny-all plus service_role, matching 0065, 0067, 0069 and 0079. The tenant
-- boundary is `createOrgScopedClient`, not a policy keyed off auth.uid(); the
-- 0064 header explains why such a policy would be theatre in this schema and
-- why the organization_id column is the prerequisite for making RLS real later.
--
-- `plans` is in the list because it is reached through the same PostgREST role,
-- not because it holds anything private — it is the price list, and it is
-- registered as `shared()`.

alter table public.plans                     enable row level security;
alter table public.organization_subscriptions enable row level security;
alter table public.usage_events              enable row level security;
alter table public.usage_counters            enable row level security;
alter table public.organization_onboarding   enable row level security;

revoke all on table public.plans                      from public, anon, authenticated;
revoke all on table public.organization_subscriptions from public, anon, authenticated;
revoke all on table public.usage_events               from public, anon, authenticated;
revoke all on table public.usage_counters             from public, anon, authenticated;
revoke all on table public.organization_onboarding    from public, anon, authenticated;

-- The ledger is append-only by design, and the grant says so: no update, no
-- delete, for anybody. A correction is a new row, which is what "append-only"
-- has to mean for the list under the invoice to still be the list.
grant select                          on table public.plans                      to service_role;
grant select, insert, update, delete  on table public.organization_subscriptions to service_role;
grant select, insert                  on table public.usage_events               to service_role;
grant select, insert, update          on table public.usage_counters             to service_role;
grant select, insert, update, delete  on table public.organization_onboarding    to service_role;
