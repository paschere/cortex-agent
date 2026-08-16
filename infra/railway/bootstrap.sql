-- =============================================================================
-- EL ARRANQUE DE UN POSTGRES QUE NO ES SUPABASE, PARA UN CÓDIGO QUE CREYÓ QUE LO ERA.
-- =============================================================================
--
-- Cortex nació sobre Supabase, y sus 108 migraciones dan por sentado un mundo
-- que Supabase crea antes de la primera: los roles (`anon`, `authenticated`,
-- `service_role`), el esquema `auth` con `auth.uid()`, y el esquema `storage`
-- con sus tablas de buckets y objetos. Un Postgres de Railway no trae nada de
-- eso, así que las migraciones fallarían en la 0001 (FK a auth.users), la 0008
-- (políticas con auth.uid()) y la 0013 (insert en storage.buckets).
--
-- Este archivo crea ese mundo UNA VEZ, antes de aplicar las migraciones, y es
-- deliberadamente un calco mínimo:
--
--   * Los roles existen para que los GRANT y las políticas compilen. El
--     producto se conecta con el usuario de Railway (superusuario), igual que
--     antes se conectaba con service_role: el aislamiento multi-tenant de
--     Cortex NUNCA dependió de RLS — vive en el cliente scopeado
--     (packages/agent-tools/src/tenancy/scoped-client.ts) — y las políticas
--     quedan como defensa en profundidad para un futuro rol sin bypass.
--
--   * `auth.uid()` lee las claims que PostgREST pone en
--     `request.jwt.claims`, que es EXACTAMENTE lo que hace la versión de
--     Supabase. Con better-auth esas claims no traen usuarios finales, así que
--     las políticas que dependen de auth.uid() evalúan a null — el mismo
--     comportamiento que ya tenían en Supabase desde la migración 0011, que lo
--     documenta.
--
--   * Las tablas de `storage` existen para que las migraciones viejas corran
--     tal cual quedaron escritas. El almacenamiento REAL de archivos ya no
--     pasa por ahí: vive en tablas propias (ver la migración que introduce
--     app_files). Nadie lee estas tablas en producción.
--
-- Idempotente a propósito: correrlo dos veces no hace nada la segunda.
-- Se aplica con:  psql "$DATABASE_URL" -f infra/railway/bootstrap.sql
-- =============================================================================

-- Extensiones que las migraciones dan por existentes. En la imagen
-- postgres-ssl de Railway ambas vienen instaladas; aquí solo se activan.
create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Roles de Supabase. NOLOGIN: nadie se conecta con ellos; existen para que
-- los GRANT/POLICY de las migraciones tengan a quién nombrar, y para que
-- PostgREST pueda hacer SET ROLE según la claim `role` del JWT.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- bypassrls: el mismo poder que tiene en Supabase, donde el producto
    -- siempre operó con la llave service-role.
    create role service_role nologin bypassrls;
  end if;
end$$;

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;

-- ---------------------------------------------------------------------------
-- El esquema `auth`, calcado de lo que las migraciones usan y nada más.
-- ---------------------------------------------------------------------------
create schema if not exists auth;

-- Stub de auth.users: la 0001 le pone una FK (que la 0011 quita) y la 0009 le
-- cuelga un trigger (que la 0011 también quita). Nunca tendrá filas.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Las tres funciones que Supabase define y las políticas usan. Leen las
-- claims del JWT que PostgREST deja en la variable de sesión — la misma
-- implementación que la original, sin la parte de GoTrue que ya nadie usa.
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', 'anon')
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- El esquema `storage`, suficiente para que las migraciones 0013, 0044, 0058 y
-- 0079 corran tal cual. El almacenamiento real ya no vive aquí.
-- ---------------------------------------------------------------------------
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.buckets, storage.objects to service_role;
