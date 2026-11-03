-- ===========================================================================
-- APPS CON CÓDIGO: UN PROYECTO DE CÓDIGO POR APP, SUS COMPILACIONES Y LA
-- PANTALLA «code»
-- ===========================================================================
-- Un segundo motor al lado del de bloques (ver docs/plans/apps-con-codigo.md):
-- una app puede mezclar pantallas de bloques y pantallas con código. Comparten
-- usuarios, roles, permisos y tablas; el código del navegador nunca habla con
-- la base, pasa por el SDK y el servidor aplica el rol (apps/permissions.ts).
--
--   · custom_app_code          — el proyecto: los archivos del BORRADOR
--                                ({ruta: contenido}) y cuál compilación está
--                                publicada. Una app tiene como mucho uno.
--   · custom_app_code_builds   — cada compilación: copia exacta de los
--                                archivos, el bundle por pantalla y el log.
--                                Se guardan las últimas 30; la publicada no
--                                se borra nunca (lo hace el código, no aquí).
--   · custom_app_screens       — `kind` ('view' | 'code') y `code_entry`
--                                (p.ej. screens/torre.tsx). Una pantalla de
--                                código sigue teniendo su `view_id` (vista
--                                mínima de relleno): roles, orden, ícono y
--                                menú no cambian.
--
-- Tenencia: `organization_id` en cada fila y `tenant()` en tenancy/tables.ts.
-- RLS como 0208: sólo service_role, con el cliente acotado (`getOrgScopedClient`).

create table if not exists public.custom_app_code (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     text not null,
  app_id              uuid not null references public.custom_apps (id) on delete cascade,
  -- { "screens/torre.tsx": "…código…" }. Límites (200 archivos, 512 KB c/u,
  -- 4 MB en total) y forma de las rutas se validan en código (code/files.ts).
  files               jsonb not null default '{}'::jsonb check (jsonb_typeof(files) = 'object'),
  -- Versión del SDK (@cortex/app-sdk) con la que se compila.
  sdk_version         text not null default '1',
  -- Compilación que ven los usuarios; null = nada publicado. Sin FK a
  -- propósito: las builds dependen de este proyecto (code_id) y una FK en el
  -- otro sentido sería circular; el código garantiza que exista y sea 'ok'.
  published_build_id  uuid,
  updated_by          uuid,
  updated_at          timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

create unique index if not exists custom_app_code_app_idx
  on public.custom_app_code (app_id);
create index if not exists custom_app_code_org_idx
  on public.custom_app_code (organization_id, updated_at desc);

create table if not exists public.custom_app_code_builds (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     text not null,
  code_id             uuid not null references public.custom_app_code (id) on delete cascade,
  -- 1, 2, 3… por proyecto.
  number              integer not null check (number >= 1),
  -- Copia exacta de lo compilado.
  files               jsonb not null default '{}'::jsonb check (jsonb_typeof(files) = 'object'),
  -- { "<slug de pantalla>": { "js": "…", "css": "…" } }
  bundles             jsonb not null default '{}'::jsonb check (jsonb_typeof(bundles) = 'object'),
  status              text not null check (status in ('ok', 'error')),
  log                 text not null default '',
  created_by          uuid,
  created_at          timestamptz not null default now()
);

create unique index if not exists custom_app_code_builds_number_idx
  on public.custom_app_code_builds (code_id, number);
create index if not exists custom_app_code_builds_org_code_idx
  on public.custom_app_code_builds (organization_id, code_id, number desc);

alter table public.custom_app_screens
  add column if not exists kind text not null default 'view';
alter table public.custom_app_screens
  drop constraint if exists custom_app_screens_kind_check;
alter table public.custom_app_screens
  add constraint custom_app_screens_kind_check check (kind in ('view', 'code'));
alter table public.custom_app_screens
  add column if not exists code_entry text;

comment on table public.custom_app_code is
  'Proyecto de código de una app (a lo más uno): archivos del borrador y la compilación publicada. Ver docs/plans/apps-con-codigo.md.';
comment on table public.custom_app_code_builds is
  'Una compilación del proyecto de código: archivos exactos, bundle por pantalla, estado y log. Se conservan las últimas 30 y la publicada.';
comment on column public.custom_app_screens.kind is
  'view = pantalla de bloques (su spec en custom_views); code = pantalla con código (code_entry), con una vista mínima de relleno.';
comment on column public.custom_app_screens.code_entry is
  'kind = code: ruta del archivo de entrada en custom_app_code.files (p.ej. screens/torre.tsx).';

alter table public.custom_app_code enable row level security;
alter table public.custom_app_code_builds enable row level security;

revoke all on table public.custom_app_code from public, anon, authenticated;
revoke all on table public.custom_app_code_builds from public, anon, authenticated;

grant select, insert, update, delete on table public.custom_app_code to service_role;
grant select, insert, update, delete on table public.custom_app_code_builds to service_role;
