-- Scheduled jobs: user-created one-off or recurring jobs, created from chat via
-- the schedule.* tools and executed unattended by Inngest.
--
-- Execution model (see apps/web/inngest/functions/schedule-dispatch.ts):
--   - A single Inngest cron runs every minute and claims due rows
--     (status='active' AND next_run_at <= now()) by optimistically advancing
--     next_run_at (NULL for one-offs), then emits a `scheduled/job.run` event.
--   - The runner executes either a fixed tool call (kind='tool') or an
--     unattended agent turn (kind='agent'), records a scheduled_job_runs row,
--     and delivers the result (conversation message and/or email).
--
-- Safety: tools with requiresConfirmation only run unattended when the job was
-- created with allow_unattended_writes = true (explicit per-job opt-in).
--
-- RLS note (same as 0025): SSO is better-auth, auth.uid() is always NULL, so
-- the policies below are inert — they lock the tables to the service-role
-- client only.

create table if not exists public.scheduled_jobs (
  id                      uuid        primary key default gen_random_uuid(),
  user_id                 uuid        not null references public.users(id) on delete cascade,
  agent_id                uuid        not null references public.agents(id) on delete cascade,
  name                    text        not null,
  -- What runs: a fixed tool call, or an unattended agent turn.
  kind                    text        not null check (kind in ('tool', 'agent')),
  tool_id                 text,                 -- kind='tool'
  tool_input              jsonb,                -- kind='tool'
  instruction             text,                 -- kind='agent'
  -- When it runs: a single timestamp, or a cron expression.
  schedule_kind           text        not null check (schedule_kind in ('once', 'cron')),
  cron                    text,                 -- schedule_kind='cron'
  timezone                text        not null default 'UTC',
  run_at                  timestamptz,          -- schedule_kind='once'
  next_run_at             timestamptz,          -- NULL once a one-off is dispatched
  status                  text        not null default 'active'
                                      check (status in ('active', 'paused', 'completed', 'cancelled')),
  allow_unattended_writes boolean     not null default false,
  notify_conversation     boolean     not null default true,
  notify_email            boolean     not null default false,
  conversation_id         uuid        references public.conversations(id) on delete set null,
  last_run_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint scheduled_jobs_tool_fields  check (kind <> 'tool'  or (tool_id is not null and tool_input is not null)),
  constraint scheduled_jobs_agent_fields check (kind <> 'agent' or instruction is not null),
  constraint scheduled_jobs_cron_fields  check (schedule_kind <> 'cron' or cron is not null),
  constraint scheduled_jobs_once_fields  check (schedule_kind <> 'once' or run_at is not null)
);

create table if not exists public.scheduled_job_runs (
  id          uuid        primary key default gen_random_uuid(),
  job_id      uuid        not null references public.scheduled_jobs(id) on delete cascade,
  status      text        not null default 'running' check (status in ('running', 'ok', 'error')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  output      text,       -- agent reply or pretty-printed tool result (truncated)
  error       text,
  metadata    jsonb
);

-- Hot paths: the dispatcher's due-job scan, and per-user listings.
create index if not exists scheduled_jobs_due_idx
  on public.scheduled_jobs(next_run_at) where status = 'active';
create index if not exists scheduled_jobs_user_idx      on public.scheduled_jobs(user_id);
create index if not exists scheduled_job_runs_job_idx   on public.scheduled_job_runs(job_id, started_at desc);

alter table public.scheduled_jobs     enable row level security;
alter table public.scheduled_job_runs enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'scheduled_jobs' and policyname = 'owner_select') then
    create policy "owner_select" on public.scheduled_jobs
      for select using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'scheduled_job_runs' and policyname = 'owner_select') then
    create policy "owner_select" on public.scheduled_job_runs
      for select using (
        exists (select 1 from public.scheduled_jobs j where j.id = job_id and j.user_id = auth.uid())
      );
  end if;
end $$;

-- Grant the schedule.* tools to the existing agents (idempotent array append).
update public.agents
set allowed_tool_ids = (
  select array(select distinct unnest(allowed_tool_ids || array['schedule.create','schedule.list','schedule.update']))
)
where slug in ('sales', 'cortex', 'recruiting')
  and not allowed_tool_ids @> array['schedule.create'];
