-- Profiles are private to a person until that owner explicitly shares them.
-- No legacy organization cookie directory is adopted into a personal profile.
create table public.browser_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  shared boolean not null default false,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now()
);
create index browser_profiles_owner_idx on public.browser_profiles(organization_id, owner_id);
alter table public.browser_profiles enable row level security;
revoke all on public.browser_profiles from public, anon, authenticated;
grant select, insert, update, delete on public.browser_profiles to service_role;
alter table public.browser_flows add column profile_id uuid references public.browser_profiles(id) on delete restrict;
