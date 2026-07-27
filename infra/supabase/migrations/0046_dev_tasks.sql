-- Zippy picks up its own development work.
--
-- A human assigns a Linear issue to Zippy; /api/webhooks/linear turns that into
-- a row here, and the executor (Inngest, event `dev/task.queued`) does the work
-- and writes its result back into the same row. Three tables:
--
--   dev_repositories  the ALLOWLIST — Zippy can only touch a repo that somebody
--                     registered here, and only opens PRs where allowed.
--   dev_tasks         one unit of work, from queued to done/failed.
--   dev_task_events   every inbound webhook delivery we accepted or turned away.
--                     This is where retry-idempotency is enforced.
--
-- See docs/operations/zippy-dev-tasks.md for the event contract.

-- ---------------------------------------------------------------------------
-- Allowlist
-- ---------------------------------------------------------------------------

create table if not exists public.dev_repositories (
  id uuid primary key default gen_random_uuid(),
  -- Stable short handle used everywhere a human names a repo: the `Repo:` line
  -- in an issue, the `repo:<key>` Linear label, the executor's clone target.
  -- Lowercased so matching never depends on how somebody typed it.
  key text not null unique check (key = lower(key) and key <> ''),
  name text not null,
  provider text not null default 'github' check (provider in ('github')),
  clone_url text not null,
  default_branch text not null default 'main',
  -- Registering a repo lets Zippy READ and work in it. Opening a pull request
  -- is a second, separate grant — a repo can be added for exploration long
  -- before anyone wants unattended PRs in it.
  allow_pull_requests boolean not null default false,
  is_active boolean not null default true,
  -- Repo selection rule, tier 3 (see resolveRepository in
  -- apps/web/lib/dev-tasks/repository.ts): issues from these Linear teams or
  -- projects belong to this repo unless the issue says otherwise. Kept as data
  -- so a new team→repo mapping is an UPDATE, not a deploy.
  linear_team_keys text[] not null default '{}',
  linear_project_ids text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists dev_repositories_team_idx
  on public.dev_repositories using gin (linear_team_keys);
create index if not exists dev_repositories_project_idx
  on public.dev_repositories using gin (linear_project_ids);

alter table public.dev_repositories enable row level security;

-- The three repos this org actually has. The mechanism is generic: adding a
-- fourth is one INSERT, no code change. linear_team_keys is intentionally empty
-- — until somebody maps a team, every issue must name its repo explicitly,
-- which is the safe default (a wrong mapping silently sends work to the wrong
-- codebase; a missing one just asks the human).
insert into public.dev_repositories (key, name, clone_url, default_branch, allow_pull_requests, notes)
values
  ('zipdev-agent', 'zipdev-agent', 'https://github.com/Zipdev-Team/zipdev-agent.git', 'main', true,
   'Zippy itself — the Next.js app, agent tools and Inngest workers.'),
  ('zipdev-matcher', 'zipdev-matcher', 'https://github.com/Zipdev-Team/zipdev-matcher.git', 'main', true,
   'Recruiting/matching service behind the recruit.* tools.'),
  ('payroll', 'payroll', 'https://github.com/Zipdev-Team/payroll.git', 'main', true,
   'Payroll service behind the payroll.* tools.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------

create table if not exists public.dev_tasks (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'linear' check (source in ('linear')),
  -- Linear's issue UUID (stable) and its human identifier, e.g. "ENG-142".
  external_id text not null,
  external_identifier text not null,
  external_url text,
  title text not null,
  description text,

  repository_id uuid not null references public.dev_repositories(id) on delete restrict,
  -- Denormalised so the executor and the oversight UI can read a task without
  -- a join, and so history survives a repo being renamed or removed.
  repository_key text not null,

  -- Whoever caused the pickup (the assigner, or the issue's creator).
  requester_name text,
  requester_email text,
  requester_external_id text,

  status text not null default 'queued'
    check (status in ('queued', 'running', 'needs_review', 'done', 'failed', 'cancelled')),
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,

  -- Written back by the executor via `dev/task.status`; never set at intake.
  branch_name text,
  pr_url text,
  summary text,
  error text,

  -- Snapshot of the webhook fields the decision was made on, for debugging a
  -- pickup months later without Linear's audit log.
  -- Not named `trigger`: it is a Postgres keyword, and a column that needs
  -- quoting in half the tools that touch it is a papercut with no upside.
  trigger_context jsonb not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- Idempotency, level 2: AT MOST ONE OPEN TASK PER ISSUE.
--
-- The dedupe ledger below stops identical retries; this stops the other half of
-- the problem — an issue that is unassigned and reassigned, or relabelled while
-- Zippy is already working, producing a second concurrent run against the same
-- branch. Terminal rows are excluded so an issue CAN legitimately be picked up
-- again after a failed or cancelled attempt.
create unique index if not exists dev_tasks_one_open_per_issue
  on public.dev_tasks (source, external_id)
  where status in ('queued', 'running', 'needs_review');

create index if not exists dev_tasks_status_idx on public.dev_tasks(status, created_at desc);
create index if not exists dev_tasks_repo_idx on public.dev_tasks(repository_id, created_at desc);
create index if not exists dev_tasks_external_idx on public.dev_tasks(source, external_id);

alter table public.dev_tasks enable row level security;

-- ---------------------------------------------------------------------------
-- Delivery ledger / idempotency
-- ---------------------------------------------------------------------------

create table if not exists public.dev_task_events (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'linear' check (source in ('linear')),
  -- Deterministic fingerprint of the delivery (see linearEventKey). Linear
  -- resends the byte-identical body on retry, so the same delivery always
  -- produces the same key and loses the race against the unique constraint.
  event_key text not null,
  external_id text,
  action text,
  outcome text not null default 'received'
    check (outcome in ('received', 'accepted', 'ignored', 'rejected')),
  task_id uuid references public.dev_tasks(id) on delete set null,
  reason text,
  received_at timestamptz not null default now(),
  -- Idempotency, level 1. The webhook INSERTs this row before doing anything
  -- else; a duplicate delivery gets 23505 and is answered 200 without work.
  unique (source, event_key)
);

create index if not exists dev_task_events_received_idx
  on public.dev_task_events(received_at desc);
create index if not exists dev_task_events_external_idx
  on public.dev_task_events(external_id, received_at desc);

alter table public.dev_task_events enable row level security;
