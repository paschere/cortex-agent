-- Server-side store for confirmation-gated MCP actions.
--
-- v1 used a stateless HMAC token that embedded the full validated input; for
-- large payloads the token ran thousands of characters and the model would
-- truncate/mangle it when echoing it back. Now the pending action lives here
-- and the model only round-trips a short single-use id.
create table if not exists public.mcp_pending_actions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  agent_id   uuid not null references public.agents(id) on delete cascade,
  tool_id    text not null,
  input      jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists mcp_pending_actions_expires_idx
  on public.mcp_pending_actions(expires_at);

alter table public.mcp_pending_actions enable row level security;
-- Service-role only, like every other internal table.
