-- Cortex SaaS auth: better-auth organization + admin + two-factor plugins
--
-- Extends the better-auth schema from 0011 with everything the SaaS surface
-- needs (multi-tenant organizations with invitations, platform admin fields,
-- TOTP two-factor). Column names are quoted camelCase to match better-auth's
-- Kysely adapter defaults; table names are mapped in apps/web/lib/auth.ts via
-- per-model `modelName` / plugin `schema` config.

-- ----------------------------------------------------------------------
-- 1. Admin plugin fields on ba_user / ba_session
-- ----------------------------------------------------------------------

alter table public.ba_user
  add column if not exists role text not null default 'user',
  add column if not exists banned boolean not null default false,
  add column if not exists "banReason" text,
  add column if not exists "banExpires" timestamptz;

alter table public.ba_session
  add column if not exists "impersonatedBy" text;

-- ----------------------------------------------------------------------
-- 2. Two-factor plugin
-- ----------------------------------------------------------------------

alter table public.ba_user
  add column if not exists "twoFactorEnabled" boolean not null default false;

create table if not exists public.ba_two_factor (
  id text primary key,
  secret text not null,
  "backupCodes" text not null,
  "userId" text not null references public.ba_user(id) on delete cascade
);

create index if not exists ba_two_factor_user_idx on public.ba_two_factor ("userId");

-- ----------------------------------------------------------------------
-- 3. Organization plugin (multi-tenant workspaces)
-- ----------------------------------------------------------------------

create table if not exists public.ba_organization (
  id text primary key,
  name text not null,
  slug text unique,
  logo text,
  metadata text,
  "createdAt" timestamptz not null default now()
);

create table if not exists public.ba_member (
  id text primary key,
  "organizationId" text not null references public.ba_organization(id) on delete cascade,
  "userId" text not null references public.ba_user(id) on delete cascade,
  role text not null default 'member',
  "createdAt" timestamptz not null default now()
);

create unique index if not exists ba_member_org_user_uidx
  on public.ba_member ("organizationId", "userId");
create index if not exists ba_member_user_idx on public.ba_member ("userId");

create table if not exists public.ba_invitation (
  id text primary key,
  "organizationId" text not null references public.ba_organization(id) on delete cascade,
  email text not null,
  role text,
  status text not null default 'pending',
  "expiresAt" timestamptz not null,
  "inviterId" text not null references public.ba_user(id) on delete cascade
);

create index if not exists ba_invitation_org_idx on public.ba_invitation ("organizationId");
create index if not exists ba_invitation_email_idx on public.ba_invitation (lower(email));

-- The session remembers which workspace the user is acting in.
alter table public.ba_session
  add column if not exists "activeOrganizationId" text;

-- ----------------------------------------------------------------------
-- 4. RLS: service-role only, same posture as 0011
-- ----------------------------------------------------------------------
-- better-auth talks to the DB over SUPABASE_DB_URL (service role, bypasses
-- RLS); anon / client callers must never read these tables directly.

alter table public.ba_two_factor enable row level security;
alter table public.ba_organization enable row level security;
alter table public.ba_member enable row level security;
alter table public.ba_invitation enable row level security;

create policy ba_no_client_access_two_factor on public.ba_two_factor for all using (false) with check (false);
create policy ba_no_client_access_organization on public.ba_organization for all using (false) with check (false);
create policy ba_no_client_access_member on public.ba_member for all using (false) with check (false);
create policy ba_no_client_access_invitation on public.ba_invitation for all using (false) with check (false);
