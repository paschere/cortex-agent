-- mcp_tokens: per-user bearer tokens for MCP access to the zipdev-agent tool layer
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
