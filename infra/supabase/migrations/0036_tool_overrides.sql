-- Per-user tool overrides: org admins can explicitly enable or disable a
-- single tool for a single user from the /tools catalog. A row here means
-- "this user's access to this tool has been explicitly set"; no row means
-- the user inherits the agent's defaults (allowed_tool_ids). Enforcement is
-- deny-list only: enabled=false rows block the tool for that user, while
-- enabled=true rows are a no-op at runtime that simply records an explicit
-- allow decision (useful as an audit trail of who re-enabled what).
create table if not exists public.user_tool_overrides (
  user_id uuid not null references public.users(id) on delete cascade,
  tool_id text not null,
  enabled boolean not null default false,
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, tool_id)
);

alter table public.user_tool_overrides enable row level security;
-- Service-role only (RLS deny-all), same as the rest of the schema.
