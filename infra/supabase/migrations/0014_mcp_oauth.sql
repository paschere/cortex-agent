-- OAuth 2.1 authorization-server tables for the claude.ai MCP connector.
--
-- This app acts as both the OAuth 2.1 Authorization Server AND the MCP
-- Resource Server. claude.ai performs Dynamic Client Registration (RFC 7591),
-- authorization_code + PKCE (S256) with Resource Indicators (RFC 8707), and
-- refresh_token rotation.
--
-- All access to these tables goes through the service-role client; RLS is
-- enabled with deny-all policies so anon/non-service callers can never touch
-- them directly (see 0011 for the same pattern on better-auth tables).
--
-- Secret material (auth codes, access/refresh tokens) is NEVER stored in
-- plaintext: we store a SHA-256 hash of the opaque token and look up by hash.

-- ----------------------------------------------------------------------
-- 1. Registered OAuth clients (DCR)
-- ----------------------------------------------------------------------
create table if not exists public.oauth_clients (
  id text primary key,                       -- client_id (opaque)
  client_secret text,                        -- null for public clients (auth_method = none)
  client_name text not null,
  redirect_uris text[] not null default '{}',
  grant_types text[] not null default '{authorization_code,refresh_token}',
  response_types text[] not null default '{code}',
  token_endpoint_auth_method text not null default 'none',
  scope text,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------
-- 2. Authorization codes (short-lived, single-use)
-- ----------------------------------------------------------------------
create table if not exists public.oauth_authorization_codes (
  code_hash text primary key,                -- sha256(code)
  client_id text not null references public.oauth_clients(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,              -- PKCE S256 challenge
  code_challenge_method text not null default 'S256',
  scope text,
  resource text,                             -- RFC 8707 canonical resource URI
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists oauth_authorization_codes_expires_idx
  on public.oauth_authorization_codes (expires_at);

-- ----------------------------------------------------------------------
-- 3. Access tokens
-- ----------------------------------------------------------------------
create table if not exists public.oauth_access_tokens (
  token_hash text primary key,               -- sha256(access_token)
  client_id text not null references public.oauth_clients(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  scope text,
  resource text,                             -- audience this token is bound to
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists oauth_access_tokens_expires_idx
  on public.oauth_access_tokens (expires_at);

-- ----------------------------------------------------------------------
-- 4. Refresh tokens (rotated on use for public clients)
-- ----------------------------------------------------------------------
create table if not exists public.oauth_refresh_tokens (
  token_hash text primary key,               -- sha256(refresh_token)
  client_id text not null references public.oauth_clients(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  scope text,
  resource text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists oauth_refresh_tokens_expires_idx
  on public.oauth_refresh_tokens (expires_at);

-- ----------------------------------------------------------------------
-- 5. RLS: deny-all (service role bypasses RLS)
-- ----------------------------------------------------------------------
alter table public.oauth_clients enable row level security;
alter table public.oauth_authorization_codes enable row level security;
alter table public.oauth_access_tokens enable row level security;
alter table public.oauth_refresh_tokens enable row level security;

create policy oauth_no_client_access_clients on public.oauth_clients for all using (false) with check (false);
create policy oauth_no_client_access_codes on public.oauth_authorization_codes for all using (false) with check (false);
create policy oauth_no_client_access_access on public.oauth_access_tokens for all using (false) with check (false);
create policy oauth_no_client_access_refresh on public.oauth_refresh_tokens for all using (false) with check (false);
