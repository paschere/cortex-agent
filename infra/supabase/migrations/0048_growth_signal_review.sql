-- Growth signals get a review UI (/prospects), so a signal has to be able to
-- say WHO moved it and WHEN.
--
-- Until now the only trace of a triage decision was `updated_at` changing, which
-- answers "something happened" and nothing else. A prospecting list is shared —
-- two people can look at the same company on the same morning — so "Qualified by
-- Mikey, 2 days ago" is the difference between a queue and a guessing game.
--
-- `found_by` already records who ran the sweep that discovered the signal. That
-- is a different person from the one who judged it, so it is left alone.
alter table public.growth_signals
  add column if not exists reviewed_by uuid references public.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz;

comment on column public.growth_signals.reviewed_by is
  'The person whose decision put the signal in its current status. Written by growth.update_signal, from whoever the call is attributed to — the web page and Cortex both go through it.';
comment on column public.growth_signals.reviewed_at is
  'When that status was set. Distinct from updated_at, which also moves when only the contact is filled in.';

-- The four states are the whole workflow: the sweep creates "new", a human moves
-- it to "qualified" or "rejected", and "contacted" closes it out. The tool and
-- the page both enum over exactly these, so the database should refuse a fifth
-- rather than let a typo invent one that no filter will ever show.
alter table public.growth_signals
  drop constraint if exists growth_signals_status_check;
alter table public.growth_signals
  add constraint growth_signals_status_check
  check (status in ('new', 'qualified', 'rejected', 'contacted'));

-- Nothing is ever deleted, so the list grows and the funnel counts read every
-- row. Status is already indexed; this one serves "who has been reviewing".
create index if not exists growth_signals_reviewed_idx
  on public.growth_signals(reviewed_at desc)
  where reviewed_at is not null;
