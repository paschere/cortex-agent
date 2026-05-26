-- Extensions
create extension if not exists "pgcrypto";

create type user_role as enum ('member', 'team_admin', 'org_admin');

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  name text,
  role user_role not null default 'member',
  google_sub text,
  created_at timestamptz not null default now()
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create type team_member_role as enum ('member', 'team_admin');

create table public.team_members (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role team_member_role not null default 'member',
  primary key (team_id, user_id)
);

create index team_members_user_idx on public.team_members(user_id);
