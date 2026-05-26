create type integration_provider as enum ('google', 'hubspot');

create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider integration_provider not null,
  access_token_enc text not null,
  refresh_token_enc text,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);
create index integrations_user_idx on public.integrations(user_id);
