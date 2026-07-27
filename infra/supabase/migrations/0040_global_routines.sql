-- Global routines: scheduled jobs that belong to the workspace rather than to
-- one person, mail their results to an explicit list, and can be triggered by
-- hand from the UI.
--
-- `recipients` is an explicit email list (empty = fall back to the owner's
-- address, the previous behaviour). `is_global` makes the job visible to the
-- whole team on /schedules instead of only its creator — the row still keeps a
-- user_id because every tool call runs with a real user's credentials and must
-- stay attributable in the audit trail.
alter table public.scheduled_jobs
  add column if not exists recipients text[] not null default '{}',
  add column if not exists is_global boolean not null default false;

create index if not exists scheduled_jobs_global_idx
  on public.scheduled_jobs(is_global)
  where is_global = true;
