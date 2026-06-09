-- OAuth 2.1 foundation for the remote MCP connector.
--
-- This MCP server acts as an OAuth 2.1 RESOURCE SERVER (it validates bearer
-- tokens whose audience == the canonical MCP endpoint URI) and as a minimal
-- AUTHORIZATION SERVER (it issues codes/tokens via authorization_code + PKCE,
-- supports Dynamic Client Registration per RFC 7591, and refresh tokens).
--
-- Security model:
--   - We never store plaintext authorization codes, access tokens, or refresh
--     tokens. Only their SHA-256 hex digests (token_hash / code_hash) are
--     persisted. The plaintext is returned to the client once and forgotten.
--   - Public PKCE clients (e.g. Claude via DCR with
--     token_endpoint_auth_method='none') have a NULL client_secret_hash.
--   - PKCE (S256) is enforced in application code via code_challenge /
--     code_challenge_method captured on the authorization code row.
--
-- RLS note (see also 0011_better_auth.sql § 3, 0014_mcp_tokens.sql,
-- 0019_user_mcp_servers.sql):
--   SSO is handled by better-auth, not Supabase Auth, so auth.uid() returns
--   NULL for every request. The policies below are therefore INERT DEAD CODE
--   that always evaluate false for anon/non-service callers — they lock the
--   tables down so ONLY the service-role client (which bypasses RLS) can read
--   or write them. Never touch these tables with an anon/non-service client.

-- ----------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------

-- Registered OAuth clients (DCR-created or manually whitelisted).
create table if not exists public.oauth_clients (
  id                         uuid        primary key default gen_random_uuid(),
  client_id                  text        unique,
  client_secret_hash         text,                 -- NULL for public PKCE clients
  client_name                text,
  redirect_uris              text[],
  grant_types                text[],
  token_endpoint_auth_method text,
  created_at                 timestamptz default now()
);

-- Short-lived authorization codes (authorization_code grant, PKCE-bound).
create table if not exists public.oauth_authorization_codes (
  code_hash             text        primary key,
  client_id             text,
  user_id               uuid        references public.users(id) on delete cascade,
  redirect_uri          text,
  code_challenge        text,
  code_challenge_method text,
  scope                 text,
  expires_at            timestamptz,
  created_at            timestamptz default now()
);

-- Issued access tokens (bearer; audience == canonical MCP resource URI).
create table if not exists public.oauth_access_tokens (
  token_hash text        primary key,
  client_id  text,
  user_id    uuid        references public.users(id) on delete cascade,
  scope      text,
  expires_at timestamptz,
  created_at timestamptz default now()
);

-- Issued refresh tokens (rotated for public clients per OAuth 2.1).
create table if not exists public.oauth_refresh_tokens (
  token_hash text        primary key,
  client_id  text,
  user_id    uuid        references public.users(id) on delete cascade,
  scope      text,
  expires_at timestamptz,                  -- NULL = non-expiring
  created_at timestamptz default now()
);

-- ----------------------------------------------------------------------
-- Indexes (hot paths: lookup by user, cleanup of expired rows)
-- ----------------------------------------------------------------------
create index if not exists oauth_authorization_codes_user_idx    on public.oauth_authorization_codes(user_id);
create index if not exists oauth_authorization_codes_expires_idx on public.oauth_authorization_codes(expires_at);
create index if not exists oauth_access_tokens_user_idx          on public.oauth_access_tokens(user_id);
create index if not exists oauth_access_tokens_expires_idx       on public.oauth_access_tokens(expires_at);
create index if not exists oauth_refresh_tokens_user_idx         on public.oauth_refresh_tokens(user_id);
create index if not exists oauth_refresh_tokens_expires_idx      on public.oauth_refresh_tokens(expires_at);

-- ----------------------------------------------------------------------
-- RLS (presently inert — service-role only; see header comment above)
-- ----------------------------------------------------------------------
alter table public.oauth_clients             enable row level security;
alter table public.oauth_authorization_codes enable row level security;
alter table public.oauth_access_tokens       enable row level security;
alter table public.oauth_refresh_tokens      enable row level security;

-- Owners (auth.uid()) may read their own token/code rows. Inert under
-- better-auth: auth.uid() is NULL, so these always evaluate false, leaving
-- the tables accessible only via the service-role client.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'oauth_clients' and policyname = 'service_role_only') then
    create policy "service_role_only" on public.oauth_clients
      for select using (false);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'oauth_authorization_codes' and policyname = 'owner_select') then
    create policy "owner_select" on public.oauth_authorization_codes
      for select using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'oauth_access_tokens' and policyname = 'owner_select') then
    create policy "owner_select" on public.oauth_access_tokens
      for select using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'oauth_refresh_tokens' and policyname = 'owner_select') then
    create policy "owner_select" on public.oauth_refresh_tokens
      for select using (auth.uid() = user_id);
  end if;
end $$;
