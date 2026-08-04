-- Vehicles: a small registry of the plates a person is responsible for, plus
-- the two Colombian sources of truth about them — RUNT (the national vehicle
-- registry: SOAT and RTM validity) and SIMIT (outstanding traffic fines).
--
-- WHY PERSIST ANYTHING AT ALL. Both lookups are scraped, not APIs: a RUNT
-- consult drives a headless browser through an OCR captcha and takes ~18
-- seconds. That is far too expensive to repeat on every question, and it is
-- also the only way to answer the question that actually matters — "what
-- CHANGED?". A fine is only new relative to what we saw last time, and a SOAT
-- only becomes urgent relative to today. Neither RUNT nor SIMIT keeps history
-- for us, so the history lives here.
--
-- Everything is scoped to a user. This is personal bookkeeping, not company
-- data: two people may legitimately track the same plate, and neither should
-- see the other's record of it.

create table if not exists public.vehicles (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  -- Always stored normalized: uppercase, no spaces or dashes. RUNT and SIMIT
  -- are both keyed on the plate and both are picky about formatting, so the
  -- normalization happens once, on the way in, and never at read time.
  plate             text not null,
  label             text,                                  -- "the red Mazda", "mamá's car"

  -- RUNT refuses to answer on a plate alone: it demands the owner's document
  -- type and number as a crude access control. Stored per vehicle because the
  -- owner is a property of the vehicle, not of the Cortex user asking.
  owner_doc_type    text,                                  -- CC | CE | NIT | PA
  owner_doc_number  text,

  -- Facts RUNT hands back. Denormalized onto the vehicle so `vehicles.list`
  -- answers "is anything expired?" in one query, with no scraping at all.
  brand             text,
  line              text,
  model_year        integer,
  runt_estado       text,                                  -- e.g. ACTIVO
  soat_expires_at   date,
  rtm_expires_at    date,
  last_runt_sync    timestamptz,

  -- Facts SIMIT hands back. total_pending_cop is the amount SIMIT itself
  -- reports as owed, kept alongside the fine rows so a summary never has to
  -- re-add them (SIMIT includes interest we do not model per fine).
  total_pending_cop bigint not null default 0,
  last_simit_sync   timestamptz,

  notes             text,
  archived          boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One row per plate per person. Registering a plate twice is the ordinary case
-- (a person re-runs the same request), so it must be idempotent rather than an
-- error the model has to reason about.
create unique index if not exists vehicles_user_plate_idx
  on public.vehicles(user_id, plate);

create index if not exists vehicles_user_idx
  on public.vehicles(user_id, archived, plate);

alter table public.vehicles enable row level security;
-- Service-role only (RLS deny-all), same pattern as the rest of the schema.

-- ---------------------------------------------------------------------------
-- Fines
-- ---------------------------------------------------------------------------

-- One row per comparendo (citation) SIMIT reports for a vehicle. These accrue:
-- a fine seen last month is still the same fine this month, possibly with a
-- new status once it is paid or disputed.
create table if not exists public.vehicle_fines (
  id           uuid primary key default gen_random_uuid(),
  vehicle_id   uuid not null references public.vehicles(id) on delete cascade,
  code         text not null,                              -- infraction code, e.g. C14
  description  text not null default '',
  amount_cop   bigint not null default 0,                  -- fine + interest, as SIMIT reports it
  issued_at    timestamptz,
  status       text not null default 'PENDING',            -- PENDING | PAID | DISPUTED
  location     text,
  secretaria   text,
  comparendo   text,
  -- When WE first saw it, which is not when it was issued. This is what makes
  -- "any new fines this week?" answerable: a comparendo issued in March can
  -- surface on SIMIT in July, and it is news to the owner on the day it shows up.
  detected_at  timestamptz not null default now()
);

-- The dedupe key SIMIT gives us. Partial because the comparendo number is
-- occasionally missing from a scraped row, and a null must not collide with
-- another null — those cases are deduped in the tool by (code, issued_at)
-- instead. Mirrors how the source scraper service dedupes.
create unique index if not exists vehicle_fines_comparendo_idx
  on public.vehicle_fines(vehicle_id, comparendo)
  where comparendo is not null;

create index if not exists vehicle_fines_vehicle_idx
  on public.vehicle_fines(vehicle_id, detected_at desc);

alter table public.vehicle_fines enable row level security;

-- ---------------------------------------------------------------------------
-- Consult log
-- ---------------------------------------------------------------------------

-- Every RUNT/SIMIT attempt, successful or not. Two reasons it earns its keep:
-- a failed scrape is indistinguishable from "nothing to report" unless it is
-- recorded, and the ~18s RUNT consult is expensive enough that anyone tuning a
-- monitoring routine needs to see how often it actually ran.
create table if not exists public.vehicle_consults (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references public.vehicles(id) on delete cascade,
  source      text not null,                               -- RUNT | SIMIT
  status      text not null,                               -- ok | error
  message     text,                                        -- the human sentence shown on failure
  fines_found integer not null default 0,
  ran_at      timestamptz not null default now()
);

create index if not exists vehicle_consults_vehicle_idx
  on public.vehicle_consults(vehicle_id, ran_at desc);

alter table public.vehicle_consults enable row level security;
