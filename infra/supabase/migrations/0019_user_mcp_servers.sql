-- user_mcp_servers + user_mcp_tools: per-user external (dynamic) MCP servers.
--
-- A user can register external MCP servers (e.g. a hosted Notion/Linear MCP
-- endpoint). We cache the manifest of tools each server exposes in
-- user_mcp_tools so the chat route can advertise them to the model without a
-- live round-trip on every request. The manifest is refreshed lazily (see
-- syncExternalServerManifest in packages/agent-tools/src/external-mcp.ts).
--
-- Security model:
--   - auth_value_encrypted holds the bearer token / api key encrypted via
--     encryptToken() (AES-256-GCM). It is NULL when auth_type='none'.
--   - key_version supports future key rotation: rows encrypted under an older
--     key can be identified and re-encrypted.
--   - trusted=true lets the agent call the server's tools without a per-call
--     confirmation prompt. Defaults to false.
--
-- RLS note (see also 0011_better_auth.sql § 3 and 0014_mcp_tokens.sql):
--   The policies below key off auth.uid(), which returns NULL for every
--   request in this project because SSO is handled by better-auth (not
--   Supabase Auth). They are presently INERT DEAD CODE — they exist for
--   documentation purposes and possible future enforcement. ALL real access
--   MUST go through the service-role client, which bypasses RLS entirely.

CREATE TABLE public.user_mcp_servers (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name                 text        NOT NULL CHECK(length(name) <= 60),
  url                  text        NOT NULL CHECK(length(url) <= 512),
  auth_type            text        NOT NULL CHECK(auth_type IN ('none','bearer','api_key')),
  auth_value_encrypted text,       -- NULL when auth_type='none'; encrypted via encryptToken()
  key_version          smallint    NOT NULL DEFAULT 1,  -- for future key rotation
  enabled              bool        NOT NULL DEFAULT true,
  trusted              bool        NOT NULL DEFAULT false, -- auto-approve tool calls without confirmation
  last_checked_at      timestamptz,
  last_error           text,
  tool_count           int         NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_mcp_servers_user_idx         ON public.user_mcp_servers(user_id);
CREATE INDEX user_mcp_servers_user_enabled_idx ON public.user_mcp_servers(user_id, enabled);

CREATE TABLE public.user_mcp_tools (
  server_id          uuid    NOT NULL REFERENCES public.user_mcp_servers(id) ON DELETE CASCADE,
  tool_name          text    NOT NULL CHECK(length(tool_name) <= 64),
  tool_description   text    CHECK(length(tool_description) <= 1000),
  input_schema_json  jsonb   NOT NULL,
  cached_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, tool_name)
);

CREATE INDEX user_mcp_tools_server_idx ON public.user_mcp_tools(server_id);

-- ----------------------------------------------------------------------
-- RLS (presently inert — see header comment above)
-- ----------------------------------------------------------------------
ALTER TABLE public.user_mcp_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_mcp_tools   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_select" ON public.user_mcp_servers
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "owner_insert" ON public.user_mcp_servers
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "owner_update" ON public.user_mcp_servers
  FOR UPDATE USING (auth.uid() = user_id);
