-- Cortex is sold per person. This makes the product agree with the price list.
--
-- WHAT THE PUBLIC PAGE PROMISES, AND WHAT THE PRODUCT DID INSTEAD. apps/web/
-- app/_landing/Landing.tsx sells one assistant per person at a rate per person:
-- $30.000 each from five people, $24.000 each from twenty-five, and under each
-- rate the line "cada persona trae al mes" with the answers and documents that
-- come with a head. Migration 0085 shipped the other model — one package per
-- company, 2.000 answers for $290.000 however many people were inside — because
-- when it was written that was the model. Two prices for the same product is not
-- a rounding error; it is the sales conversation going one way and the invoice
-- going another.
--
-- ===========================================================================
-- THE COLUMNS ARE RENAMED, NOT REINTERPRETED. THIS IS THE WHOLE POINT.
-- ===========================================================================
-- `plans.answers_limit` means, today, in production, in every reader: THE CAP ON
-- THE WHOLE COMPANY FOR THE MONTH. The new number that wants to live in that
-- slot — 150 — is a per-person allocation, and the two differ by a factor of
-- however many people the customer has.
--
-- Writing 150 into `answers_limit` would leave `entitlementFor()` comparing a
-- fifteen-person company's whole month of consumption against one person's
-- allowance. Nothing would fail. Typecheck passes, tests pass, the migration
-- applies, and the product blocks a paying customer on the third of the month
-- with a message that says they used 151 of their 150 answers. Nobody finds out
-- from the inside, because from the inside it is arithmetic that adds up.
--
-- This repository has been burned twice by a threshold whose meaning moved under
-- the code that read it. So:
--
--   price_cop        -> price_cop_per_seat        (per person, per month)
--   answers_limit    -> answers_per_seat          (per person, per month)
--   documents_limit  -> documents_per_seat        (per person, per month)
--   seats_limit      -> SPLIT IN TWO, see below
--
-- and the old four are DROPPED in the same migration. Not deprecated, not kept
-- "for one release": dropped. A reader that still asks for `answers_limit` gets
-- an error from PostgREST naming the column, in development, on its first query
-- — instead of a plausible small number. The suffix `_per_seat` is doing work
-- too: `used > plan.answers_per_seat` is a sentence that reads wrong out loud,
-- which is the cheapest review tool there is.
--
-- ===========================================================================
-- seats_limit WAS ONE NUMBER DOING TWO OPPOSITE JOBS
-- ===========================================================================
-- Under the package model `seats_limit` was a ceiling: fifteen people or you
-- cannot invite a sixteenth. Under the per-person model the numbers on the page
-- — "desde 5 personas", "desde 25 personas" — are the opposite of a ceiling.
-- They are a FLOOR ON THE BILL. A team of eight belongs on Equipo and must not
-- be told it needs seven more people; a team of three that wants Equipo pays for
-- five, because five is the smallest invoice that plan has.
--
-- One column cannot be a floor and a ceiling, so there are two:
--
--   billable_seats_minimum   The fewest people this plan is charged for. A price
--                            floor. It never refuses anybody anything.
--
--   seats_maximum            The only hard ceiling left on people, and only the
--                            free plan has one (three, as the page says). NULL on
--                            every paid plan: when each person is billed, capping
--                            how many can join is a way of declining money.
--
-- ===========================================================================
-- WHAT THE COMPANY'S CEILING IS, AND WHO COUNTS TOWARD IT
-- ===========================================================================
-- Per-person quota, one company-wide meter. The effective cap for a workspace in
-- a period is
--
--     answers_per_seat x billable seats
--
-- and consumption is still counted for the workspace as a whole, exactly as
-- `usage_counters` already counts it. That is what the pricing page states in
-- its own footnote — "los cupos se cuentan juntos para tu empresa; lo que cambia
-- con cada persona que entra es cuánto suma al total" — and it is the kinder
-- reading: a lawyer who asks forty questions in the week a contract lands is not
-- stopped because the quota with her name on it ran out while nine colleagues
-- left theirs untouched.
--
-- BILLABLE SEATS is the largest of four numbers, and every one of them is there
-- for a reason:
--
--   1. members             People with a directory row in `public.users` — the
--                          ones who can actually ask Cortex something.
--
--   2. peak (this period)  The most members this workspace had AT ONCE during
--                          the period. See the next section; this is the one
--                          that stops the disaster.
--
--   3. contracted_seats    What was agreed with the customer, when something was
--                          agreed. New column on the subscription.
--
--   4. billable_seats_minimum   The plan's floor.
--
-- Pending invitations are deliberately NOT in that list. An invitation that is
-- never accepted would otherwise buy a month of quota for a person who never
-- arrived. They still count against `seats_maximum`, which is the question they
-- are actually relevant to ("can this workspace hold one more person?").
--
-- The same number is the quota basis and the billing basis. You get exactly the
-- seats you are charged for — which is why the floor grants quota as well as
-- charging for it, and why there is nothing left to reconcile between the screen
-- and the invoice.
--
-- ===========================================================================
-- THE RATCHET: A CEILING MAY RISE MID-MONTH, IT MAY NOT FALL
-- ===========================================================================
-- Somebody joins on the 14th and the company's ceiling goes up. Fine — they are
-- paying for that person and they get what they paid for immediately.
--
-- Somebody LEAVES on the 14th and the naive answer is that the ceiling drops by
-- 150 answers. But those answers have already been consumed. A workspace at
-- 1.400 of 1.500 that loses two people would find itself at 1.400 of 1.200:
-- blocked instantly, mid-afternoon, by a personnel change, having done nothing.
-- That is the worst failure this product can have, because it is retroactive.
--
-- So the basis includes a per-period high-water mark, kept in
-- `organization_seat_periods` and maintained by triggers on `public.users`. The
-- ceiling within a period is monotonic: it rises when people join and does not
-- move when they leave. It comes back down at the period boundary, which is also
-- when the invoice changes — the two move together, once a month, on a date the
-- customer already has in their head.
--
-- The high-water mark is a TRIGGER, for the reason 0085 § 9 gives about the
-- meters and tables.ts gives about tenancy: a directory row is written from
-- signup, from an accepted invitation, from provisioning, and will be written
-- from somewhere else next quarter. A rule that has to be remembered at each of
-- those places is a rule that is already broken. The BEFORE DELETE half is the
-- important one — it records the count while the leaving person is still counted,
-- which is precisely the number that must not be lost.
--
-- ===========================================================================
-- THE WORKSPACE THAT ALREADY EXISTS, AGAIN, AND MORE CAREFULLY
-- ===========================================================================
-- There is a real company in production. 0085 § 7 put it on `custom`, whose
-- three limits are NULL, which every reader treats as "sin límite". It also has
-- its first-run guide marked dismissed.
--
-- This migration renames that plan to `enterprise` (§ 3), because "A la medida"
-- is not what the page sells any more — the page sells Enterprise. The rename is
-- done as insert-new, repoint-subscriptions, delete-old, in that order, because
-- `organization_subscriptions.plan_code` is a foreign key with no ON UPDATE
-- CASCADE and an `update plans set code=…` would simply fail.
--
-- The row keeps all three quotas NULL, keeps `self_serve = false`, and every
-- subscription that pointed at `custom` is repointed with its `status`,
-- `started_at` and `notes` untouched. Nothing about that workspace's entitlement
-- changes: NULL per-seat quota times any number of seats is still NULL, and
-- `entitlementFor` still returns `ok` forever. Its onboarding row is not touched
-- by this file at all, so `dismissed_at` stays where 0085 put it.
--
-- Idempotent throughout: `add column if not exists`, `drop column if exists`,
-- `create table if not exists`, `create or replace function`, `drop trigger if
-- exists` before each `create trigger`, constraints added only after checking
-- `pg_constraint`, and every data statement written so that a second run finds
-- nothing to do.
--
-- No new enum values anywhere, for the reason 0085 gives: an enum value cannot be
-- used in the transaction that adds it, and this file both defines and uses its
-- vocabulary.


-- ===========================================================================
-- 1. The plan catalogue, in the units it is sold in
-- ===========================================================================
-- New columns first, values second, old columns last. Deliberately NOT a
-- `rename column`: a rename would carry 290000 into a column called
-- `price_cop_per_seat` and 2000 into one called `answers_per_seat`, and there
-- would be a moment — however brief, however inside one transaction — at which
-- the database asserted that a seat costs $290.000 a month. Values that mean
-- something different get written explicitly or they do not get written.

alter table public.plans
  add column if not exists price_cop_per_seat      integer not null default 0,
  add column if not exists answers_per_seat        integer,
  add column if not exists documents_per_seat      integer,
  add column if not exists billable_seats_minimum  integer not null default 1,
  add column if not exists seats_maximum           integer;

comment on column public.plans.price_cop_per_seat is
  'Monthly price in Colombian pesos FOR ONE PERSON. The invoice is this times the billable seats; there is no package price anywhere in this schema.';
comment on column public.plans.answers_per_seat is
  'Answers included per person per month. NULL = sin limite. The workspace ceiling is this times its billable seats — never compare a workspace total against this number on its own.';
comment on column public.plans.documents_per_seat is
  'Documents included per person per month. NULL = sin limite. Same multiplication as answers_per_seat.';
comment on column public.plans.billable_seats_minimum is
  'The fewest people this plan is charged for: a floor on the bill, never a limit on use. A team of eight belongs on a plan whose minimum is five, and a team of three on that plan pays for five and receives five seats of quota.';
comment on column public.plans.seats_maximum is
  'The only hard ceiling on how many people a workspace may hold. NULL = sin tope, which is every paid plan: when each person is billed, refusing one more is refusing money. Only the free plan sets it.';

-- The numbers, from apps/web/app/_landing/Landing.tsx. They are stated one plan
-- at a time rather than in a single UPDATE with a CASE, so that a reader with a
-- psql prompt and the pricing page open can check them line by line.
--
-- free      $0            up to 3 people      50 answers   15 documents each
-- team      $30.000 c/u   from 5 people      150 answers   70 documents each
-- business  $24.000 c/u   from 25 people     250 answers  150 documents each

update public.plans set
  price_cop_per_seat     = 0,
  answers_per_seat       = 50,
  documents_per_seat     = 15,
  billable_seats_minimum = 1,
  seats_maximum          = 3,
  tagline                = 'Para probar Cortex con tu equipo, sin tarjeta. Hasta 3 personas.',
  sort_order             = 1
where code = 'free';

update public.plans set
  price_cop_per_seat     = 30000,
  answers_per_seat       = 150,
  documents_per_seat     = 70,
  billable_seats_minimum = 5,
  seats_maximum          = null,
  tagline                = 'Un asistente por persona, para el equipo que ya trabaja adentro.',
  sort_order             = 2
where code = 'team';

update public.plans set
  price_cop_per_seat     = 24000,
  answers_per_seat       = 250,
  documents_per_seat     = 150,
  billable_seats_minimum = 25,
  seats_maximum          = null,
  tagline                = 'El mismo producto, más barato por persona, desde 25 personas.',
  sort_order             = 3
where code = 'business';


-- ===========================================================================
-- 2. Seats agreed with a human
-- ===========================================================================
-- The pricing page says, in its own words, that the product does not add or
-- charge for one more person on its own: "acordamos contigo cuántas personas
-- entran y lo activamos". This column is where that agreement is written down.
--
-- It is a FLOOR, like the plan minimum, and not a ceiling. A workspace that
-- contracted twenty-five seats and grew to thirty is entitled to thirty seats of
-- quota and owes for thirty — being right about the bill matters more than
-- enforcing a number somebody typed in a contract. NULL means nothing was
-- agreed, which is every workspace today.

alter table public.organization_subscriptions
  add column if not exists contracted_seats integer;

comment on column public.organization_subscriptions.contracted_seats is
  'Seats agreed with the customer, when something was agreed. A floor on the billing and quota basis, never a ceiling: a workspace that outgrows it is entitled to — and owes for — what it actually has. NULL means nothing was agreed.';


-- ===========================================================================
-- 3. `custom` becomes `enterprise`
-- ===========================================================================
-- Insert, repoint, delete — in that order, because `plan_code` is a foreign key
-- without ON UPDATE CASCADE.
--
-- THE PRODUCTION WORKSPACE IS ON THIS ROW. Its quotas stay NULL, its
-- subscription keeps its status, its start date and the note 0085 wrote on it,
-- and its onboarding row is not touched by this file. The only thing that
-- changes for it is the word on the screen.

insert into public.plans
  (code, name, tagline, price_cop_per_seat, answers_per_seat, documents_per_seat,
   billable_seats_minimum, seats_maximum, self_serve, sort_order)
values
  ('enterprise', 'Enterprise',
   'Sin tope de personas. Volumen, ingreso corporativo y contrato acordados contigo.',
   0, null, null, 1, null, false, 4)
on conflict (code) do nothing;

-- Every subscription that pointed at `custom` now points at `enterprise`.
-- `status`, `started_at`, `notes`, `billing_customer_ref` and
-- `billing_subscription_ref` are not named here, so they cannot be lost.
update public.organization_subscriptions
   set plan_code = 'enterprise',
       updated_at = now()
 where plan_code = 'custom';

delete from public.plans where code = 'custom';


-- ===========================================================================
-- 4. The old columns go away
-- ===========================================================================
-- After the values above are written and after the rename, so that nothing in
-- this file reads a column it has already dropped, and so that a reader of the
-- diff sees the new numbers arrive before the old ones leave.
--
-- Dropping rather than deprecating is the entire safety argument of this
-- migration; see the header. `answers_limit` meant "the whole company for the
-- month" and no column in this schema means that any more.

alter table public.plans
  drop column if exists price_cop,
  drop column if exists answers_limit,
  drop column if exists documents_limit,
  drop column if exists seats_limit;

-- The checks the old columns carried, restated for the new ones. `add
-- constraint` has no `if not exists`, so each is guarded by a lookup — which is
-- what makes re-running this file safe.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'plans_price_per_seat_nonneg') then
    alter table public.plans
      add constraint plans_price_per_seat_nonneg check (price_cop_per_seat >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'plans_answers_per_seat_positive') then
    alter table public.plans
      add constraint plans_answers_per_seat_positive
      check (answers_per_seat is null or answers_per_seat > 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'plans_documents_per_seat_positive') then
    alter table public.plans
      add constraint plans_documents_per_seat_positive
      check (documents_per_seat is null or documents_per_seat > 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'plans_billable_minimum_positive') then
    alter table public.plans
      add constraint plans_billable_minimum_positive check (billable_seats_minimum > 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'plans_seats_maximum_positive') then
    alter table public.plans
      add constraint plans_seats_maximum_positive
      check (seats_maximum is null or seats_maximum > 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'subscriptions_contracted_seats_positive') then
    alter table public.organization_subscriptions
      add constraint subscriptions_contracted_seats_positive
      check (contracted_seats is null or contracted_seats > 0);
  end if;
end $$;


-- ===========================================================================
-- 5. The high-water mark of people, per period
-- ===========================================================================
-- One row per (workspace, period). `peak_seats` is the most directory rows the
-- workspace held at once during that period, and it only ever goes up within a
-- period.
--
-- Tenant data, registered as `tenant()` in tables.ts: it is the number the
-- workspace's own ceiling and its own invoice are computed from, and a lost
-- filter here would not show one company another's rows — it would put another
-- company's headcount on their bill. Exactly the failure mode `usage_counters`
-- has, for exactly the same reason.
--
-- No foreign key on organization_id, matching `usage_events` and
-- `usage_counters` and for the same reason: a constraint failure here must never
-- abort the INSERT of the directory row that triggered it. Somebody's account
-- being created is the product; the bookkeeping about it is bookkeeping.
--
-- `period` uses `public.usage_period_of()` from 0085 § 1, so the seat basis and
-- the consumption counters are keyed by the same calendar month in the same
-- timezone. Two different notions of "this month" in one billing decision is a
-- bug waiting for the 31st.

create table if not exists public.organization_seat_periods (
  organization_id text        not null,
  period          text        not null,
  peak_seats      integer     not null default 0 check (peak_seats >= 0),
  first_at        timestamptz not null default now(),
  last_at         timestamptz not null default now(),
  primary key (organization_id, period)
);

comment on table public.organization_seat_periods is
  'The most people a workspace held at once in a billing period. Maintained by triggers on public.users, never by application code. It exists so a workspace ceiling can rise when somebody joins mid-month and cannot fall when somebody leaves — a falling ceiling would block a company retroactively for consumption it had already been entitled to.';

comment on column public.organization_seat_periods.peak_seats is
  'Monotonic within the period. Raised on insert and recorded on delete BEFORE the row goes, so the leaving person is still counted in the month they were present for.';

create or replace function public.seat_period_touch()
returns trigger
language plpgsql
as $$
declare
  v_org   text;
  v_count integer;
begin
  -- Same workspace on both halves; the DELETE half reads it from OLD because
  -- there is no NEW.
  v_org := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;

  if v_org is not null then
    begin
      -- On BEFORE DELETE the row being removed is still visible to this count,
      -- which is the whole point of the timing: the number that must survive is
      -- the one that included the person who is leaving.
      select count(*) into v_count
        from public.users u
       where u.organization_id = v_org;

      insert into public.organization_seat_periods
        (organization_id, period, peak_seats, first_at, last_at)
      values
        (v_org, public.usage_period_of(now()), coalesce(v_count, 0), now(), now())
      on conflict (organization_id, period) do update
        set peak_seats = greatest(public.organization_seat_periods.peak_seats, excluded.peak_seats),
            last_at    = greatest(public.organization_seat_periods.last_at, excluded.last_at);
    exception when others then
      -- Swallowed for the reason 0085 § 9 gives about the meters, and the
      -- priorities are the same: somebody joining or leaving a workspace is the
      -- product, and this is a receipt about it. A failure here costs the
      -- ceiling some headroom for the rest of the month; taking account
      -- creation down over it would be the wrong trade every time.
      null;
    end;
  end if;

  -- A BEFORE DELETE trigger that returns NULL CANCELS THE DELETE. Returning OLD
  -- is not a formality here; getting it wrong would make it impossible to remove
  -- anybody from a workspace, and the failure would look like nothing at all.
  if tg_op = 'DELETE' then
    return old;
  end if;
  return null;
end;
$$;

comment on function public.seat_period_touch() is
  'Raises the workspace high-water mark of people for the current period. AFTER INSERT and BEFORE DELETE on public.users; the DELETE timing is deliberate — the count has to include the person who is leaving.';

drop trigger if exists users_seat_period_insert on public.users;
create trigger users_seat_period_insert
  after insert on public.users
  for each row execute function public.seat_period_touch();

drop trigger if exists users_seat_period_delete on public.users;
create trigger users_seat_period_delete
  before delete on public.users
  for each row execute function public.seat_period_touch();

-- Every workspace that exists right now gets its current headcount as this
-- period's mark, so nobody's ceiling starts at zero and waits for the next
-- person to join. `do nothing` rather than `do update`: if a row already exists
-- it was written by the trigger and is at least as high as this count.
insert into public.organization_seat_periods (organization_id, period, peak_seats, first_at, last_at)
select u.organization_id, public.usage_period_of(now()), count(*), now(), now()
from public.users u
where u.organization_id is not null
group by u.organization_id
on conflict (organization_id, period) do nothing;

-- The reading order of the seat basis: one workspace, one period.
create index if not exists organization_seat_periods_period_idx
  on public.organization_seat_periods (organization_id, period);


-- ===========================================================================
-- 6. Row-level security posture
-- ===========================================================================
-- Deny-all plus service_role, matching 0085 § 10. The tenant boundary is
-- `createOrgScopedClient`; see the 0064 header for why a policy keyed off
-- auth.uid() would be theatre in this schema.
--
-- No delete grant. A high-water mark that can be deleted is a ceiling that can
-- be lowered mid-month by anything with the service key, which is the one thing
-- this table exists to prevent.

alter table public.organization_seat_periods enable row level security;

revoke all on table public.organization_seat_periods from public, anon, authenticated;

grant select, insert, update on table public.organization_seat_periods to service_role;


-- ===========================================================================
-- 7. Still measured, still not collected
-- ===========================================================================
-- 0085 argued that a payment gateway written before the commercial decisions
-- exist is work that gets thrown away, because Wompi, PayU, dLocal and Stripe do
-- not agree on what a subscription IS and a Colombian SMB is as likely to ask
-- for a monthly transfer against an electronic invoice as for a card.
--
-- That argument has not weakened; it has gained a fact. The pricing page says,
-- in its own words, "todavía no cobramos dentro de Cortex" and "el producto no
-- suma ni cobra una persona más por su cuenta". Shipping a gateway now would
-- make the page wrong in the one direction a page about not overstating things
-- must never be wrong.
--
-- What per-seat pricing adds is that the amount owed is now DERIVABLE, which it
-- was not before. Under the package model the invoice was whatever plan somebody
-- was on. Under this one it is
--
--     plans.price_cop_per_seat x billable seats
--
-- where billable seats is the max() of the four numbers in the header, all of
-- which are in this database and none of which is a judgement call. That figure
-- is computed by `monthlyChargeCop()` in packages/agent-tools/src/billing/
-- plans.ts, shown on /plan next to the seat count it came from, and it is the
-- same number a gateway would be told to charge on the day one exists. The
-- columns waiting for that day are still `billing_customer_ref` and
-- `billing_subscription_ref`, still empty, still written by nobody.
