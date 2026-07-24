-- Pipelines (playbooks): reusable, parameterized flows defined in natural
-- language from any chat surface and invoked as a single tool (pipeline.run).
-- The instruction body is a prompt template with {{param}} placeholders; when
-- run, the rendered playbook is loaded into the calling model's context and
-- executed step by step with the agent's tools — every step still flows
-- through runTool (audit + confirmation gates).
create table if not exists public.pipelines (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  description text not null default '',
  instruction text not null,
  params      jsonb not null default '[]',   -- [{name, description, required}]
  created_by  uuid references public.users(id) on delete set null,
  times_run   integer not null default 0,
  last_run_at timestamptz,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.pipelines enable row level security;
-- Service-role only (RLS deny-all), same as the rest of the schema.

update public.agents
set allowed_tool_ids = array_append(allowed_tool_ids, 'pipeline.*')
where slug = 'zippy'
  and not ('pipeline.*' = any(allowed_tool_ids));
