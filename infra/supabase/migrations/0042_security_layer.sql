-- Security layer: risk classification, enforcement decisions and the signals
-- behind them.
--
-- Every tool call already lands in audit_events; these columns record WHY a
-- call was allowed, flagged or blocked so the audit log answers "was anything
-- risky done, and what did we do about it" — not just "what ran".
--
-- risk_level  low | medium | high | critical  (derived deterministically in
--             runTool from the tool's data sensitivity and blast radius)
-- decision    allowed | flagged | blocked | confirmed
-- risk_reason short human sentence for the audit UI
alter table public.audit_events
  add column if not exists surface text,
  add column if not exists risk_level text,
  add column if not exists decision text,
  add column if not exists risk_reason text,
  add column if not exists risk_signals jsonb not null default '[]';

create index if not exists audit_events_risk_idx
  on public.audit_events(risk_level, created_at desc)
  where risk_level in ('high', 'critical');

create index if not exists audit_events_decision_idx
  on public.audit_events(decision, created_at desc)
  where decision in ('blocked', 'flagged');

-- Standalone incident record: one row per blocked or flagged attempt, kept
-- even if the audit row is pruned. This is what a security review reads.
create table if not exists public.security_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references public.users(id) on delete set null,
  agent_id     uuid references public.agents(id) on delete set null,
  tool_id      text not null,
  surface      text,
  risk_level   text not null,
  decision     text not null,
  reason       text not null,
  signals      jsonb not null default '[]',
  input_digest text,
  created_at   timestamptz not null default now()
);
create index if not exists security_events_created_idx on public.security_events(created_at desc);
create index if not exists security_events_user_idx on public.security_events(user_id, created_at desc);

alter table public.security_events enable row level security;

-- Per-workspace policy knobs so thresholds can be tuned without a deploy.
create table if not exists public.security_policies (
  key         text primary key,
  value       jsonb not null,
  updated_by  uuid references public.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);
alter table public.security_policies enable row level security;

insert into public.security_policies(key, value) values
  ('block_critical', 'true'::jsonb),
  ('sensitive_reads_per_hour', '40'::jsonb),
  ('external_send_requires_confirmation', 'true'::jsonb)
on conflict (key) do nothing;
