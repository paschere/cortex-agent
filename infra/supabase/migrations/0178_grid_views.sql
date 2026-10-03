-- ===========================================================================
-- VISTAS GUARDADAS DE LA GRILLA
-- ===========================================================================
-- El visualizador de datos (components/datagrid) deja filtrar, ordenar,
-- agrupar, esconder columnas y cambiar de diseño (tabla, tablero, tarjetas,
-- calendario). «Guías en novedad de esta semana» es una pregunta que alguien
-- se hace todos los lunes: guardarla con nombre evita armarla otra vez.
--
-- `grid_views` guarda esa vista (el mismo JSON que viaja en `?vista=`) por
-- empresa y por ALCANCE: qué lista mira.
--   - 'tracker:<uuid>'  una tabla de la empresa (/trackers/<slug>)
--   - 'clients'         la lista de Clientes
--   Un alcance nuevo es una cadena nueva, no una migración.
--
-- QUIÉN LA VE. `shared = false`: solo quien la creó. `shared = true`: todo el
-- espacio. Renombrarla o borrarla es de quien la creó o de un administrador
-- (lo decide `apps/web/lib/datagrid/views-store.ts`).
--
-- La vista NO guarda filas ni valores de la empresa más allá de lo que alguien
-- escribió en un filtro; las filas se leen siempre con el permiso de quien mira.
--
-- Tenencia: `organization_id` en cada fila, `tenant()` en tenancy/tables.ts.

create table if not exists public.grid_views (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  text        not null references public.ba_organization(id) on delete cascade,
  scope            text        not null check (scope ~ '^[a-z][a-z_]{1,39}(:[A-Za-z0-9_-]{1,80})?$'),
  name             text        not null check (length(btrim(name)) between 1 and 80),
  view             jsonb       not null check (jsonb_typeof(view) = 'object' and pg_column_size(view) <= 16000),
  created_by       uuid        not null references public.users(id) on delete cascade,
  shared           boolean     not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists grid_views_org_scope_idx
  on public.grid_views (organization_id, scope, updated_at desc);

comment on table public.grid_views is
  'Vistas guardadas del visualizador de datos (filtros, orden, grupos, columnas, diseño) por empresa y alcance (tracker:<id>, clients). Privadas de quien las creó salvo shared = true. Ver apps/web/lib/datagrid/views-store.ts.';

alter table public.grid_views enable row level security;
revoke all on table public.grid_views from public, anon, authenticated;
grant select, insert, update, delete on table public.grid_views to service_role;
