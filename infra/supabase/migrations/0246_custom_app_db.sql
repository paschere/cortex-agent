-- ===========================================================================
-- APPS CON CÓDIGO, FASE 3: BASE DE DATOS PROPIA POR APP
-- ===========================================================================
-- Ver docs/plans/apps-con-codigo.md («Fase 3»). Cada app puede tener su propio
-- esquema Postgres `app_<12 hex del id>` con un rol del mismo nombre que lo
-- posee y no ve nada más. El esquema y el rol NO se crean aquí: los crea Cortex
-- la primera vez que corre las migraciones de la app (necesita que la conexión
-- de Cortex —SUPABASE_DB_URL— pueda crear roles; en Railway es superusuario).
-- Aquí sólo queda el registro:
--
--   · custom_app_db             — la app tiene esquema (y cuál). Lo mira el
--                                 borrado de la app para saber si hay algo que
--                                 tirar en Postgres, y `db.query` para decir
--                                 «todavía no tiene base» sin tocar Postgres.
--   · custom_app_db_migrations  — qué archivos de db/migrations se aplicaron,
--                                 con su suma de comprobación: un archivo ya
--                                 aplicado que cambia es un error.
--
-- Tenencia y RLS como 0243/0244: `organization_id` + tenant() en
-- tenancy/tables.ts, sólo service_role.

create table if not exists public.custom_app_db (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  app_id           uuid not null references public.custom_apps (id) on delete cascade,
  -- app_<primeros 12 hex del id de la app>; único para que dos apps nunca compartan esquema.
  schema_name      text not null check (schema_name ~ '^app_[0-9a-f]{12}$'),
  created_at       timestamptz not null default now()
);
create unique index if not exists custom_app_db_app_idx on public.custom_app_db (app_id);
create unique index if not exists custom_app_db_schema_idx on public.custom_app_db (schema_name);
create index if not exists custom_app_db_org_idx on public.custom_app_db (organization_id);

create table if not exists public.custom_app_db_migrations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  app_id           uuid not null references public.custom_apps (id) on delete cascade,
  -- Nombre del archivo sin carpeta: 0001_crear_tablas.sql
  name             text not null,
  -- sha256 (hex) del contenido, con saltos de línea normalizados.
  checksum         text not null,
  applied_at       timestamptz not null default now(),
  applied_by       uuid
);
create unique index if not exists custom_app_db_migrations_app_name_idx
  on public.custom_app_db_migrations (app_id, name);
create index if not exists custom_app_db_migrations_org_idx
  on public.custom_app_db_migrations (organization_id, app_id);

comment on table public.custom_app_db is
  'Apps con base propia: el esquema Postgres app_<12 hex> que Cortex creó para la app.';
comment on table public.custom_app_db_migrations is
  'Migraciones SQL (db/migrations/NNNN_*.sql del código de la app) ya aplicadas a su base propia, con checksum.';

alter table public.custom_app_db enable row level security;
alter table public.custom_app_db_migrations enable row level security;

revoke all on table public.custom_app_db from public, anon, authenticated;
revoke all on table public.custom_app_db_migrations from public, anon, authenticated;

grant select, insert, update, delete on table public.custom_app_db to service_role;
grant select, insert, update, delete on table public.custom_app_db_migrations to service_role;
