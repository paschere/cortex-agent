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

-- ======================================================================
-- mcp_tokens — merged in from what used to be a SECOND file numbered 0014
-- (0014_mcp_tokens.sql).
--
-- Supabase keys supabase_migrations.schema_migrations by the numeric prefix,
-- so two files sharing "0014" made the second INSERT violate the primary key:
-- `supabase db reset` / `db start` aborted partway through, and the schema
-- could not be built from scratch at all. Existing databases were unaffected
-- only because they had been migrated incrementally, never rebuilt.
--
-- The two sets of tables are independent (OAuth 2.1 client/token storage vs.
-- per-user MCP bearer tokens), and nothing between here and 0019 references
-- either, so folding one into the other is order-safe and renumbers nothing.
-- ======================================================================

-- mcp_tokens: per-user bearer tokens for MCP access to the cortex-agent tool layer
-- (e.g. from Claude Desktop via the HTTP+SSE MCP transport).
--
-- Security model:
--   - Only the SHA-256 hex digest of the token is stored here (token_hash).
--     The plaintext bearer token is shown once at issuance and never stored.
--   - `prefix` holds the first 8 chars of the plaintext (e.g. "zda_1a2b")
--     purely for display in the UI so the user can identify tokens.
--   - Tokens are revoked by setting `revoked_at`; rows are never hard-deleted.
--
-- RLS note (see also 0011_better_auth.sql § 3):
--   The policies below key off `auth.uid()`, which returns NULL for every
--   request in this project because SSO is handled by better-auth (not
--   Supabase Auth).  They are presently INERT DEAD CODE — they exist for
--   documentation purposes and possible future enforcement if we introduce a
--   `SET LOCAL app.user_id` pattern or switch back to Supabase Auth.
--   ALL real access MUST go through the service-role client, which bypasses
--   RLS entirely.  Never use an anon-key or non-service Postgres client to
--   touch this table.

create table public.mcp_tokens (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references public.users(id) on delete cascade,
  agent_id     uuid        references public.agents(id) on delete set null,  -- which agent's tool list this token can access
  name         text        not null,              -- user-given label, e.g. "My Claude Desktop"
  token_hash   text        not null unique,       -- SHA-256 hex digest of the bearer token; NEVER store plaintext
  prefix       text        not null,              -- first 8 chars of the plaintext token, e.g. "zda_1a2b"
  last_used_at timestamptz,
  revoked_at   timestamptz,
  expires_at   timestamptz,                       -- NULL = non-expiring
  created_at   timestamptz not null default now()
);

-- Efficient lookup by user + revocation state (hot path: token validation)
create index mcp_tokens_user_revoked_idx on public.mcp_tokens(user_id, revoked_at);

-- ----------------------------------------------------------------------
-- RLS (presently inert — see header comment above)
-- ----------------------------------------------------------------------
alter table public.mcp_tokens enable row level security;

-- Owners may read their own tokens (to list them in the UI)
create policy mcp_tokens_owner_select on public.mcp_tokens
  for select using (user_id = auth.uid());

-- Owners may create tokens for themselves
create policy mcp_tokens_owner_insert on public.mcp_tokens
  for insert with check (user_id = auth.uid());

-- Owners may update their own tokens (e.g. rename, revoke via revoked_at)
-- No DELETE policy: revocation is done by setting revoked_at, never by row deletion.
create policy mcp_tokens_owner_update on public.mcp_tokens
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
