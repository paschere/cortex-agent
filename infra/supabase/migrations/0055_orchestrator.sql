-- Multi-agent orchestrator.
--
-- One natural-language objective is planned (a single structured LLM call) into
-- a small DAG of tasks, and each task is then executed by its own sub-agent
-- with a narrow tool allow-list. Tasks whose dependencies are satisfied run in
-- PARALLEL, so several sub-agents write to these tables at the same time.
--
-- Three tables instead of one because they have three different lifetimes and
-- read patterns:
--   * a run is the unit a person sees in a list and comes back to later,
--   * the tasks are the graph the executor walks and mutates as it goes,
--   * the events are an append-only log tailed by the live console at ~2 Hz.
-- Keeping the log separate is what lets the console ask for "everything after
-- id N" with one index scan, instead of re-reading and diffing JSON blobs.
--
-- Everything reaches these tables through the service role (the app never
-- connects to Postgres as the end user), so RLS is enabled with NO policies:
-- deny-all for anon/authenticated, same as the rest of the schema.

create table if not exists public.orchestration_runs (
  id              uuid primary key default gen_random_uuid(),
  -- better-auth organization id, which is TEXT and not a uuid. Present on
  -- every row so multi-tenancy is enforced by the query, not by hope.
  organization_id text not null,
  -- Kept nullable + `set null`: deleting a person must not delete the record
  -- of work their runs did on behalf of the workspace.
  user_id         uuid references public.users(id) on delete set null,
  objective       text not null,
  status          text not null default 'planning'
                    check (status in ('planning', 'running', 'completed', 'failed', 'cancelled')),
  -- The planner's raw output, kept verbatim. The tasks table is the executable
  -- form; this is the audit trail of what was actually asked for.
  plan            jsonb,
  summary         text,
  total_tokens    integer not null default 0,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now()
);

-- The index the history page reads: one workspace, newest first.
create index if not exists orchestration_runs_org_created_idx
  on public.orchestration_runs (organization_id, created_at desc);

-- Sweeps over live work — "what is still running", and the recovery query for
-- runs orphaned by a process that died mid-flight.
create index if not exists orchestration_runs_status_idx
  on public.orchestration_runs (status);

create table if not exists public.orchestration_tasks (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.orchestration_runs(id) on delete cascade,
  -- 1-based position in the plan. This is the identity the planner reasons
  -- with, so depends_on stores seq numbers rather than uuids.
  seq           integer not null,
  title         text not null,
  instruction   text not null,
  status        text not null default 'pending'
                  check (status in ('pending', 'running', 'completed', 'failed', 'skipped')),
  -- Only ever points BACKWARDS (see lib/orchestrator/graph.ts): the executor
  -- normalises the planner's edges so a cycle cannot deadlock a run.
  depends_on    integer[] not null default '{}',
  agent_label   text,
  allowed_tools text[] not null default '{}',
  result        text,
  error         text,
  tokens        integer not null default 0,
  started_at    timestamptz,
  finished_at   timestamptz
);

-- Unique rather than plain: seq IS the task's identity inside its run, and a
-- duplicate would make depends_on ambiguous. The index also serves the ordered
-- read the console does on every page load.
create unique index if not exists orchestration_tasks_run_seq_idx
  on public.orchestration_tasks (run_id, seq);

create table if not exists public.orchestration_events (
  id         bigserial primary key,
  run_id     uuid not null references public.orchestration_runs(id) on delete cascade,
  -- Null for run-level events (the plan itself, the final report, a failure
  -- that happened before any task started).
  task_id    uuid references public.orchestration_tasks(id) on delete cascade,
  kind       text not null
               check (kind in ('plan', 'task_start', 'tool_call', 'tool_result',
                               'message', 'task_done', 'error', 'run_done')),
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- The one query the SSE endpoint runs, twice a second, per viewer:
--   where run_id = $1 and id > $2 order by id
create index if not exists orchestration_events_run_id_idx
  on public.orchestration_events (run_id, id);

alter table public.orchestration_runs   enable row level security;
alter table public.orchestration_tasks  enable row level security;
alter table public.orchestration_events enable row level security;
-- Service-role only (RLS deny-all), same as the rest of the schema.
