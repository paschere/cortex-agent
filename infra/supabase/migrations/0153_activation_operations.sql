-- A reviewable operation prepared from an activation case.
--
-- Activations already own detection, source snapshots and case provenance.
-- This table only adds the effect boundary: one exact company tool call, one
-- read-only verifier, and the approval that permits the call. It deliberately
-- does not add a new permission model. The approval id points at the existing
-- mcp_pending_actions queue and the web bridge claims that row through the
-- existing atomic approval store.
create table if not exists public.activation_operations (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  actor_id uuid not null references public.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete restrict,
  case_id uuid not null references public.management_cases(id) on delete cascade,
  -- This is an immutable historical pointer, not a live dependency. Feed
  -- attachments and their activation_runs are retained for a shorter period
  -- than the operation audit, so deleting an expired run must never delete an
  -- attempted or reconciled operation.
  activation_run_id uuid not null,

  action_tool_id text not null check (length(btrim(action_tool_id)) between 3 and 180),
  action_input jsonb not null check (jsonb_typeof(action_input) = 'object'),
  action_tool_snapshot text not null check (length(action_tool_snapshot) = 64),
  verifier_tool_id text not null check (length(btrim(verifier_tool_id)) between 3 and 180),
  verifier_input jsonb not null check (jsonb_typeof(verifier_input) = 'object'),
  verifier_path text not null default '',
  verifier_match text not null default 'equals' check (verifier_match in ('equals','contains')),
  verifier_expected jsonb not null,
  verifier_tool_snapshot text not null check (length(verifier_tool_snapshot) = 64),

  -- The activation evidence is copied at preparation time. It is an immutable
  -- link to the source rows that caused the case and is not rebuilt from Feed
  -- after the source expires or changes.
  source_evidence jsonb not null check (jsonb_typeof(source_evidence) = 'object'),
  intent_hash text not null check (length(intent_hash) = 64),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 16 and 300),

  approval_id uuid references public.mcp_pending_actions(id) on delete set null,
  approval_expires_at timestamptz,
  status text not null default 'awaiting_approval' check (status in (
    'awaiting_approval', 'executing', 'verifying', 'succeeded',
    'blocked', 'failed', 'cancelled', 'outcome_unknown', 'verification_failed'
  )),
  attempt integer not null default 0 check (attempt >= 0),
  before_observation jsonb,
  action_result jsonb,
  verification_result jsonb,
  evidence jsonb,
  provider_ref text,
  error text,
  revision integer not null default 1 check (revision >= 1),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists activation_operations_idempotency
  on public.activation_operations (organization_id, idempotency_key);
create index if not exists activation_operations_case_recent
  on public.activation_operations (organization_id, case_id, created_at desc);
create index if not exists activation_operations_actor_recent
  on public.activation_operations (organization_id, actor_id, created_at desc);
create index if not exists activation_operations_pending
  on public.activation_operations (organization_id, status)
  where status in ('awaiting_approval','executing','verifying','outcome_unknown','verification_failed');

alter table public.activation_operations enable row level security;
revoke all on public.activation_operations from public, anon, authenticated, service_role;
grant select, insert, update on public.activation_operations to service_role;

comment on table public.activation_operations is
  'Activation operation bridge: exact company tool proposal, existing approval id, read-only verification and immutable source evidence. It never closes a management case automatically.';
comment on column public.activation_operations.action_tool_snapshot is
  'Fingerprint of the company tool configuration at preparation time. A changed tool invalidates the approval.';
comment on column public.activation_operations.verifier_tool_snapshot is
  'Fingerprint of the read-only verifier configuration at preparation time.';
comment on column public.activation_operations.source_evidence is
  'Server-owned snapshot of the activation case evidence; never accepted from the editable client payload.';
comment on column public.activation_operations.status is
  'Outcome of the operation and its verification. outcome_unknown forbids blind retry after an ambiguous provider result.';

-- Keep the approval in the existing queue, but label its owning flow so the
-- generic /approvals, MCP and Chat executors refuse to consume it. The
-- activation route still calls the same atomic claim store, then performs its
-- mandatory read-only verification.
alter table public.mcp_pending_actions
  drop constraint if exists mcp_pending_actions_staged_via_check;
alter table public.mcp_pending_actions
  add constraint mcp_pending_actions_staged_via_check
  check (staged_via is null or staged_via in ('mcp', 'google_chat', 'whatsapp', 'web', 'schedule', 'activation'));
