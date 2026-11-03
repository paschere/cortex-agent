-- ===========================================================================
-- APPS CON CÓDIGO, FASE 2: FUNCIONES DE SERVIDOR, SECRETOS, REGISTRO DE
-- CORRIDAS Y WEBHOOKS
-- ===========================================================================
-- Ver docs/plans/apps-con-codigo.md («Fase 2»). Una función es un archivo
-- server/<nombre>.ts del proyecto de código; al compilar se empaqueta (node,
-- con sus paquetes npm dentro) y se corre en Vercel Sandbox con el rol de
-- quien la dispara.
--
--   · custom_app_code_builds.functions — {nombre: js} de la compilación.
--   · custom_app_code_secrets          — secretos de la app (cifrados con la
--                                        misma llave que los de custom-tools).
--                                        Nunca vuelven al navegador: sólo se
--                                        inyectan en ctx.secrets.
--   · custom_app_code_runs             — registro de corridas (se poda a las
--                                        últimas 500 por app, en código).
--   · custom_app_code_hooks            — webhooks de entrada: token guardado
--                                        con hash, rol con que corre.
--
-- Tenencia y RLS como 0243: `organization_id` + tenant() en tenancy/tables.ts,
-- sólo service_role.

alter table public.custom_app_code_builds
  add column if not exists functions jsonb not null default '{}'::jsonb;
alter table public.custom_app_code_builds
  drop constraint if exists custom_app_code_builds_functions_check;
alter table public.custom_app_code_builds
  add constraint custom_app_code_builds_functions_check check (jsonb_typeof(functions) = 'object');

comment on column public.custom_app_code_builds.functions is
  '{ "<nombre>": "<js CommonJS>" }: las funciones de servidor (server/<nombre>.ts) compiladas con sus paquetes.';

create table if not exists public.custom_app_code_secrets (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  app_id           uuid not null references public.custom_apps (id) on delete cascade,
  -- MAYÚSCULAS_Y_GUIONES_BAJOS (se valida en código: ^[A-Z][A-Z0-9_]{1,63}$).
  name             text not null,
  -- encryptToken() de @cortex/core (AES-256-GCM con TOKEN_ENCRYPTION_KEY).
  value_encrypted  text not null,
  updated_by       uuid,
  updated_at       timestamptz not null default now(),
  created_at       timestamptz not null default now()
);
create unique index if not exists custom_app_code_secrets_app_name_idx
  on public.custom_app_code_secrets (app_id, name);
create index if not exists custom_app_code_secrets_org_idx
  on public.custom_app_code_secrets (organization_id, app_id);

create table if not exists public.custom_app_code_runs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  app_id           uuid not null references public.custom_apps (id) on delete cascade,
  function_name    text not null,
  trigger          text not null check (trigger in ('screen', 'rule', 'schedule', 'webhook', 'chat')),
  -- Quién la disparó: id de la persona (o de la regla/webhook) y su rol.
  actor            text,
  role_key         text,
  build_number     integer,
  status           text not null check (status in ('ok', 'error', 'timeout')),
  duration_ms      integer not null default 0,
  -- Salida de console.* de la función, recortada a 20 KB.
  log              text not null default '',
  error            text,
  created_at       timestamptz not null default now()
);
create index if not exists custom_app_code_runs_app_idx
  on public.custom_app_code_runs (app_id, created_at desc);
create index if not exists custom_app_code_runs_org_idx
  on public.custom_app_code_runs (organization_id, created_at desc);

create table if not exists public.custom_app_code_hooks (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  app_id           uuid not null references public.custom_apps (id) on delete cascade,
  -- El webhook se llama como la función que dispara.
  name             text not null,
  -- El rol de la app con que corre (nunca el administrador).
  role_key         text not null,
  -- sha256 del token (el token sólo se muestra al crearlo).
  token_hash       text not null,
  -- Miembro de Cortex a nombre de quien se anotan las escrituras.
  created_by       uuid not null,
  created_at       timestamptz not null default now(),
  last_used_at     timestamptz
);
create unique index if not exists custom_app_code_hooks_app_name_idx
  on public.custom_app_code_hooks (app_id, name);

comment on table public.custom_app_code_secrets is
  'Secretos de las funciones de servidor de una app. Cifrados; nunca se devuelven al navegador.';
comment on table public.custom_app_code_runs is
  'Registro de corridas de funciones de servidor (últimas 500 por app).';
comment on table public.custom_app_code_hooks is
  'Webhooks de entrada que disparan una función de servidor, con el rol con que corre.';

alter table public.custom_app_code_secrets enable row level security;
alter table public.custom_app_code_runs enable row level security;
alter table public.custom_app_code_hooks enable row level security;

revoke all on table public.custom_app_code_secrets from public, anon, authenticated;
revoke all on table public.custom_app_code_runs from public, anon, authenticated;
revoke all on table public.custom_app_code_hooks from public, anon, authenticated;

grant select, insert, update, delete on table public.custom_app_code_secrets to service_role;
grant select, insert, update, delete on table public.custom_app_code_runs to service_role;
grant select, insert, update, delete on table public.custom_app_code_hooks to service_role;
