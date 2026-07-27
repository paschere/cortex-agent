create table public.agents (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  team_id uuid references public.teams(id) on delete set null,
  system_prompt text not null,
  default_model text not null default 'gemini-3.1-flash-lite',
  allowed_tool_ids text[] not null default '{}',
  created_at timestamptz not null default now()
);
