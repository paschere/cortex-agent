-- Growth pilot (Cortex evaluation tests 5-7): persistent store for job-post
-- signals so weekly sweeps dedupe against history and Mikey reviews a stable
-- queue instead of a chat scrollback. Wired to the growth.* tools.
create table if not exists public.growth_signals (
  id           uuid primary key default gen_random_uuid(),
  company      text not null,
  role_title   text not null,
  url          text not null,
  source       text not null default 'web',          -- job board / site it was found on
  summary      text,                                  -- why it matches the ICP (evidence)
  region       text,                                  -- e.g. "US"
  status       text not null default 'new',           -- new | qualified | rejected | contacted
  contact_name  text,
  contact_title text,
  contact_path  text,                                 -- found or pattern-inferred email/channel
  contact_confidence text,                            -- found | inferred | unknown
  found_by     uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Dedupe key: same posting URL is the same signal.
create unique index if not exists growth_signals_url_idx on public.growth_signals(url);
create index if not exists growth_signals_status_idx on public.growth_signals(status, created_at desc);

alter table public.growth_signals enable row level security;
-- Service-role only (RLS deny-all), same pattern as the rest of the schema.

-- Cortex picks up the new tool family.
update public.agents
set allowed_tool_ids = array_append(allowed_tool_ids, 'growth.*')
where slug = 'cortex'
  and not ('growth.*' = any(allowed_tool_ids));
