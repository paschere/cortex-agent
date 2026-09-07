-- Identity-owned conversation history. Never ingested into any workspace brain.
create table public.global_conversations (
  id uuid primary key default gen_random_uuid(),
  account_id text not null references public.ba_user(id) on delete cascade,
  workspace_ids text[] not null default '{}',
  title text not null,
  messages jsonb not null default '[]' check (jsonb_typeof(messages) = 'array'),
  lease_id uuid,
  lease_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(workspace_ids) <= 30)
);
create index global_conversations_account_updated on public.global_conversations(account_id, updated_at desc);
alter table public.global_conversations enable row level security;
revoke all on public.global_conversations from anon, authenticated;
-- Access goes through the authenticated server using account ownership AND
-- current membership in every source workspace, including when reopening history.
grant select, insert, update, delete on public.global_conversations to service_role;
create policy global_conversations_service on public.global_conversations for all to service_role using (true) with check (true);
