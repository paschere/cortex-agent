create type audit_status as enum ('ok', 'error', 'rate_limited', 'confirmation_required');

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  agent_id uuid references public.agents(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  tool_id text not null,
  input_hash text not null,
  status audit_status not null,
  latency_ms int not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_user_idx on public.audit_events(user_id, created_at desc);
create index audit_events_tool_idx on public.audit_events(tool_id, created_at desc);

-- Token bucket for rate limiting (per user per tool)
create table public.rate_limit_buckets (
  user_id uuid not null references public.users(id) on delete cascade,
  tool_id text not null,
  tokens int not null,
  refill_at timestamptz not null,
  primary key (user_id, tool_id)
);
