create table if not exists public.workspace_voice_profiles (
  id uuid primary key,
  owner_id text not null references public.ba_organization(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  language text not null check (language ~ '^[a-z]{2}$'),
  provider_voice_id text not null unique,
  provider_consent_id text not null,
  active boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workspace_voice_profiles_owner_created_idx
  on public.workspace_voice_profiles(owner_id, created_at desc);

create unique index if not exists workspace_voice_profiles_one_active_owner_idx
  on public.workspace_voice_profiles(owner_id) where active;

alter table public.workspace_voice_profiles enable row level security;
alter table public.workspace_voice_profiles force row level security;

-- Deliberately no anon/authenticated policies: provider identifiers and consent
-- linkage are available only to the trusted server DB role.
revoke all on public.workspace_voice_profiles from anon, authenticated;
