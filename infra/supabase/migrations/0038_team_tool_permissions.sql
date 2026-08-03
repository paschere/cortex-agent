-- Team-based tool permissions. Replaces the per-user `user_tool_overrides`
-- table from 0036: access is now governed by the TEAMS a user belongs to, not
-- by one-off rows per person, so onboarding someone into a team gives them
-- exactly the tool surface that team is supposed to have.
--
-- A row is a rule for one team about one *pattern*. A pattern is either an
-- exact tool id ('hubspot.search_deals') or a family wildcard ('hubspot.*'),
-- matching the semantics of filterTools/matchPattern in @cortex/agent-tools:
-- a pattern ending in '.*' matches every tool id with that prefix, otherwise
-- it must equal the tool id exactly.
--
-- SEMANTICS — DENY-LIST layered on top of the agent's allowed tools:
--   effective(user) = filterTools(agent.allowed_tool_ids)
--                     MINUS every pattern with allowed = false in ANY team
--                     the user belongs to.
-- * allowed = false blocks the pattern for every member of that team.
-- * allowed = true is a no-op at runtime; it records an explicit "this team
--   may use this" decision (and is how the UI clears a previous block).
-- * Teams are additive in restriction, never in permission: belonging to a
--   second, unrestricted team does NOT restore a tool another team denies.
-- * A user in no team at all is unrestricted — they get the agent's full
--   allowed toolset.
-- Enforcement lives in apps/web/lib/tool-access.ts and is applied by the chat
-- route (tool list handed to the model) and the MCP route (tools/list AND
-- tools/call, so a denied tool is neither advertised nor executable).
create table if not exists public.team_tool_permissions (
  team_id uuid not null references public.teams(id) on delete cascade,
  tool_pattern text not null,          -- exact tool id or 'family.*'
  allowed boolean not null default true,
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (team_id, tool_pattern)
);

alter table public.team_tool_permissions enable row level security;
-- Service-role only (RLS deny-all), same as the rest of the schema.

-- Superseded by the table above.
drop table if exists public.user_tool_overrides;
