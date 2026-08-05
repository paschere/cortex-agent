-- custom_tools: the tools a company writes for itself, without writing code.
--
-- WHY THIS EXISTS. Cortex ships ~15 tool families and can proxy an external MCP
-- server (0019). Neither covers the case that actually decides whether a
-- customer can use the product: "this is the HTTP API of OUR ERP, and this is
-- how you ask it for the status of a shipment". We are never going to integrate
-- that ERP, and the customer cannot wait for us to. A row in this table IS the
-- integration: name, description, input fields, and the request to build from
-- them. The agent picks it up on the next turn with no deploy.
--
-- HOW IT REACHES THE MODEL. Rows are turned into ordinary `ToolDef`s at request
-- time (packages/agent-tools/src/custom-tools/tool-def.ts) with the id
-- `custom.<slug>`, and executed through `runTool` like every other tool — same
-- audit trail, same confirmation gate, same rate limiter, same risk
-- classification. There is no side door. The `custom.` prefix is reserved: no
-- registry family may claim it (asserted in custom-tools/__tests__).
--
-- THE DANGEROUS PART, STATED PLAINLY. A row here makes our server issue an HTTP
-- request to a URL a user chose. That is SSRF with our network position and our
-- egress credentials: `http://169.254.169.254/latest/meta-data/` is a cloud
-- credential dump, and `http://10.0.x.y/` is whatever else lives in our VPC.
-- Three consequences are baked into this schema:
--
--   1. Only an org admin may write these rows. The API enforces it
--      (`role === 'org_admin'`); `created_by` records who, because whoever
--      creates one of these can read anything our network can reach.
--   2. `allow_insecure_http` and `follow_redirects` default to false and are
--      opt-in per tool, so the safe posture is the one you get by not thinking
--      about it. The destination is re-checked at call time against a resolved
--      IP, not against the URL string — see custom-tools/guard.ts.
--   3. `requires_confirmation` defaults to true and the API forces it true for
--      any write method. An admin can turn it off, deliberately, per tool.
--
-- SECRETS. `auth_secret_encrypted` holds the bearer token / API key / basic
-- password under `encryptToken()` (AES-256-GCM, packages/core/src/crypto.ts),
-- exactly like `user_mcp_servers.auth_value_encrypted`. It is never selected
-- into an API response, never rendered in the tester's request preview, and
-- never reaches an audit row: `audit_events` stores a hash of the tool INPUT,
-- which is the user's field values, and the secret is not one of them.
--
-- TENANCY. `organization_id` + the scoped client, coherent with 0064: the
-- application never holds a raw handle for this table, and
-- `createOrgScopedClient` pins the workspace onto every read and stamps it onto
-- every write (custom_tools is registered as `tenant()` in
-- packages/agent-tools/src/tenancy/tables.ts). The RLS below is the same
-- posture 0065 took for tool_embeddings — deny everyone, grant service_role —
-- rather than another `auth.uid()` policy, which 0064 § header explains has
-- been inert in this schema since better-auth landed in 0011. When the RLS
-- rewrite 0064 describes happens, this table needs a policy and nothing else:
-- the column it keys off is already here.
--
-- Idempotent throughout.

create table if not exists public.custom_tools (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       text        not null references public.ba_organization(id) on delete cascade,

  -- Identity ---------------------------------------------------------------
  -- `slug` becomes the second half of the tool id (`custom.<slug>`), so it is
  -- constrained to what both the registry and the AI SDK tool-name grammar
  -- (^[a-zA-Z0-9_-]+$, after dots become underscores) accept.
  slug                  text        not null check (slug ~ '^[a-z][a-z0-9_]{1,47}$'),
  -- What a person sees in the panel. Spanish, free text.
  name                  text        not null check (length(name) between 1 and 80),
  -- What the MODEL reads to decide whether to call this. The single most
  -- important field in the row: a description that only says what the endpoint
  -- is ("API de guías") gets the tool ignored; one that says when to reach for
  -- it ("úsala cuando pregunten por el estado de una guía o su número de
  -- rastreo") gets it used.
  description           text        not null check (length(description) between 10 and 1000),

  -- Input ------------------------------------------------------------------
  -- { "fields": [ { name, type, required, description, enum? } ] }
  -- Converted to a zod schema at runtime by custom-tools/schema.ts. It is DATA,
  -- never code: nothing here is ever eval'd or compiled.
  input_schema          jsonb       not null default '{"fields": []}'::jsonb,

  -- The request ------------------------------------------------------------
  http_method           text        not null default 'GET'
                                    check (http_method in ('GET','POST','PUT','PATCH','DELETE')),
  -- `{{field}}` placeholders, interpolated URL-encoded. Query string included.
  url_template          text        not null check (length(url_template) between 8 and 2048),
  -- { "X-Tenant": "{{tenant}}" }. Values are templated; CR/LF is rejected at
  -- save time and stripped at render time (header injection).
  headers               jsonb       not null default '{}'::jsonb,
  body_encoding         text        not null default 'none'
                                    check (body_encoding in ('none','json','form')),
  -- Stored as a JSON *structure*, not as a string of JSON. That is the whole
  -- anti-injection design: placeholders are substituted at the value level and
  -- the result is serialised with JSON.stringify, so a field containing `"` or
  -- `}` cannot change the shape of the document. See custom-tools/template.ts.
  body_template         jsonb,

  -- Authentication ---------------------------------------------------------
  auth_type             text        not null default 'none'
                                    check (auth_type in ('none','header','bearer','basic')),
  -- Only for auth_type='header' (e.g. 'X-API-Key').
  auth_header_name      text        check (auth_header_name ~ '^[A-Za-z0-9-]{1,64}$'),
  -- Only for auth_type='basic'. The password is the encrypted secret.
  auth_username         text        check (length(auth_username) <= 200),
  auth_secret_encrypted text,
  key_version           smallint    not null default 1,

  -- The response -----------------------------------------------------------
  -- Dotted path into the JSON response, e.g. `data.guias.0.estado`. Null means
  -- "the whole body". A 200 KB payload poisons the context window, so this and
  -- response_max_chars are the difference between a usable tool and one that
  -- ruins every turn it appears in.
  response_path         text        check (length(response_path) <= 200),
  response_max_chars    int         not null default 8000
                                    check (response_max_chars between 200 and 50000),

  -- Limits and posture -----------------------------------------------------
  timeout_ms            int         not null default 10000 check (timeout_ms between 1000 and 60000),
  -- HTTPS is required unless somebody turns this off on purpose, per tool.
  allow_insecure_http   bool        not null default false,
  -- Off by default: a 302 to 169.254.169.254 is how a text-level allowlist gets
  -- walked around. When on, every hop is re-validated and credentials are
  -- dropped on a cross-origin hop.
  follow_redirects      bool        not null default false,
  -- Forced true by the API for POST/PUT/PATCH/DELETE at creation; an admin can
  -- clear it afterwards with an explicit acknowledgement.
  requires_confirmation bool        not null default true,
  rate_limit_per_minute int         not null default 20 check (rate_limit_per_minute between 1 and 120),
  enabled               bool        not null default true,

  -- Bookkeeping ------------------------------------------------------------
  created_by            uuid        references public.users(id) on delete set null,
  last_tested_at        timestamptz,
  last_error            text        check (length(last_error) <= 2000),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- A slug is how a person refers to the tool, so it has to be unique where
-- people look for it: inside their workspace. Same reasoning as pipelines in
-- 0064 § 8.
create unique index if not exists custom_tools_org_slug_idx
  on public.custom_tools (organization_id, slug);

-- The read that runs on every single chat turn: "enabled tools for this
-- workspace". Leading with organization_id because that is what the scoped
-- client always pins.
create index if not exists custom_tools_org_enabled_idx
  on public.custom_tools (organization_id, enabled);

comment on table public.custom_tools is
  'Tools an organization defined for itself from the app: an HTTP request with a name, a description the model reads, and a typed input schema. Loaded per turn and executed through runTool like any built-in family, under the id custom.<slug>. Only org admins may write rows here — whoever creates one can reach anything our network can reach.';

comment on column public.custom_tools.description is
  'Read by the MODEL, not by a person, to decide when to call this tool. Prescriptive beats descriptive.';

comment on column public.custom_tools.body_template is
  'A JSON structure whose strings may contain {{field}} placeholders. Substitution happens per value and the document is re-serialised, so an input containing quotes or braces cannot alter its shape.';

comment on column public.custom_tools.auth_secret_encrypted is
  'AES-256-GCM via encryptToken(). Never selected into an API response, never shown in the request tester, never written to audit_events.';

comment on column public.custom_tools.requires_confirmation is
  'Default true, and forced true at creation for POST/PUT/PATCH/DELETE. Turning it off means the agent may perform this write with no human in the loop.';

comment on column public.custom_tools.follow_redirects is
  'Off by default. A 302 to an internal address is the standard way around a destination check; when this is on, every hop is re-validated against its resolved IP and auth headers are dropped when the origin changes.';

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
-- Deny-all with the app reaching it through the service role, matching
-- tool_embeddings (0065) and every other machine-owned table here. The tenant
-- boundary is createOrgScopedClient (0064), not a policy keyed off auth.uid()
-- — that returns NULL on every request in this project and would be theatre.

alter table public.custom_tools enable row level security;

revoke all on table public.custom_tools from public, anon, authenticated;
grant select, insert, update, delete on table public.custom_tools to service_role;
