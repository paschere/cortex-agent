-- Meeting briefings: the ledger that keeps pre-meeting briefings from being
-- scheduled twice.
--
-- Why a table and not just a query over scheduled_jobs:
--   `meetings.schedule_briefings` creates a ONE-OFF scheduled job per upcoming
--   meeting (meeting start minus leadMinutes), because a single cron cannot
--   fire "30 minutes before" for meetings that start at different times. That
--   scan is meant to be re-run — by hand, and by a daily routine — over
--   overlapping windows, so the same calendar entry shows up again and again.
--   scheduled_jobs cannot answer "did we already cover this meeting?": a job
--   flips to status='completed' the moment it runs, is deletable by the user,
--   and only carries the event id buried inside its free-text instruction.
--
-- So each covered meeting is recorded here instead, and the unique
-- (user_id, event_id) constraint does the real work: the scan CLAIMS a meeting
-- by inserting a row before creating its job, and a uniqueness violation is
-- how it learns another scan (or an earlier run) already booked that briefing.
-- Claim-then-create also makes two concurrent scans safe — the loser of the
-- insert race skips instead of double-booking, and a failed job creation rolls
-- its own claim back.
--
-- status tracks the life of one briefing: 'scheduled' when booked, 'sent' once
-- delivered, 'skipped' when it was deliberately dropped. job_id is nullable and
-- ON DELETE SET NULL so deleting the routine leaves the history intact.
--
-- RLS note (same as 0026): SSO is better-auth, auth.uid() is always NULL, so
-- enabling row level security here locks the table to the service-role client.

create table if not exists public.meeting_briefings (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references public.users(id) on delete cascade,
  event_id      text        not null,                 -- Google Calendar event id
  meeting_start timestamptz not null,
  job_id        uuid        references public.scheduled_jobs(id) on delete set null,
  status        text        not null default 'scheduled',   -- scheduled | sent | skipped
  created_at    timestamptz not null default now(),
  unique (user_id, event_id)
);

-- Hot path: "which of these upcoming events are already covered for this user".
create index if not exists meeting_briefings_user_start_idx
  on public.meeting_briefings(user_id, meeting_start desc);

alter table public.meeting_briefings enable row level security;
