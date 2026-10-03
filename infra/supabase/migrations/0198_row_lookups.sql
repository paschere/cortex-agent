-- ===========================================================================
-- CONSULTA POR FILA: QUÉ SE PREGUNTA A UNA API, FILA POR FILA
-- ===========================================================================
-- La 0161/0163 lee una fuente UNA vez por corrida (una API que responde con una
-- lista) y la cruza con las filas. Eso sirve para un tablero de aeropuerto,
-- pero no para «dime cómo va el vuelo AV9 de HOY, cada 5 minutos mientras esté
-- por llegar, y deja de preguntar cuando aterrice»: ahí lo que se consulta es
-- UNA URL POR FILA (https://api.ejemplo.com/vuelos/{vuelo}/{fecha:YYYY-MM-DD}),
-- sólo para las filas que importan y con un tope de consultas, porque cada una
-- cuesta plata o cuota.
--
--   1. `row_lookups` — una consulta configurada para una tabla: la URL con los
--      campos de la fila, la credencial (una herramienta propia, 0067: la llave
--      sigue cifrada ahí y nunca se copia), qué campos de la respuesta van a qué
--      columnas, EL FILTRO de qué filas se consultan (los mismos operadores que
--      las vistas de la grilla), cada cuánto (intervalo base y, opcional, una
--      regla «cerca de» que lo acorta cerca de una hora), y los topes: por día
--      (obligatorio) y por corrida. Lleva el contador del día (hora de Bogotá).
--
--   2. `row_lookup_state` — por consulta y por fila: cuándo toca preguntar de
--      nuevo, el último resultado y cuántos fallos seguidos. Tabla propia y no un
--      jsonb en `tracker_rows`: esa es la tabla caliente de las tablas de la
--      empresa y una tabla puede tener varias consultas.
--
-- Una fila que ya no cumple el filtro (estado = aterrizado) deja de consultarse
-- sola: la regla de parada ES el filtro.
--
-- Tenencia: `organization_id` en las dos, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. RLS encendido sin políticas
-- (deny-all) y sólo service_role. Idempotente.

create table if not exists public.row_lookups (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        text not null,
  tracker_id             uuid not null references public.trackers (id) on delete cascade,
  name                   text not null check (char_length(name) between 1 and 80),
  -- https://api.ejemplo.com/vuelos/{vuelo}/{fecha:YYYY-MM-DD}
  url_template           text not null check (char_length(url_template) between 8 and 1000),
  -- La herramienta propia (0067) que guarda la llave; null = API sin llave.
  credential_tool_id     uuid references public.custom_tools (id) on delete set null,
  -- Su nombre al crear: si la herramienta se borra, la consulta avisa en vez de
  -- seguir llamando a la API sin llave.
  credential_name        text check (credential_name is null or char_length(credential_name) <= 120),
  -- [{ path: "arrival.estimated", field: "hora_estimada", translate?: {…} }]
  mapping                jsonb not null check (jsonb_typeof(mapping) = 'array'),
  -- { match: "all" | "any", filters: [{ key, op, value? }] } (GridFilter)
  filter                 jsonb not null default '{"match":"all","filters":[]}'::jsonb
                           check (jsonb_typeof(filter) = 'object'),
  base_interval_minutes  integer not null default 30 check (base_interval_minutes between 5 and 1440),
  -- { field, beforeMinutes, afterMinutes, everyMinutes, outside: "base" | "skip" } o null
  near                   jsonb check (near is null or jsonb_typeof(near) = 'object'),
  daily_cap              integer not null default 1000 check (daily_cap between 1 and 100000),
  per_run_cap            integer not null default 100 check (per_run_cap between 1 and 1000),
  enabled                boolean not null default true,
  created_by             uuid not null,
  next_run_at            timestamptz not null default now(),
  last_run_at            timestamptz,
  last_status            text check (last_status is null or last_status in ('ok', 'error', 'capped')),
  last_error             text check (last_error is null or char_length(last_error) <= 500),
  last_calls             integer not null default 0,
  last_updated           integer not null default 0,
  -- Consultas hechas en `calls_day` (día de Bogotá); al cambiar el día, vuelve a cero.
  calls_today            integer not null default 0,
  calls_day              date,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint row_lookups_name_per_table unique (organization_id, tracker_id, name)
);

create index if not exists row_lookups_due_idx on public.row_lookups (next_run_at) where enabled;
create index if not exists row_lookups_tracker_idx on public.row_lookups (organization_id, tracker_id);

comment on table public.row_lookups is
  'Una consulta a una API por fila de una tabla de la empresa: URL con los campos de la fila, credencial (herramienta propia), mapeo respuesta → columnas, filtro de qué filas, intervalo adaptativo y topes de consultas por día y por corrida.';
comment on column public.row_lookups.credential_tool_id is
  'La herramienta propia (custom_tools) que guarda la llave cifrada. Sólo se le toman el método GET, los encabezados y la autenticación; el servidor de la URL debe ser el mismo que el de la herramienta.';
comment on column public.row_lookups.calls_day is
  'Día (hora de Bogotá) al que pertenece calls_today.';

create table if not exists public.row_lookup_state (
  organization_id  text not null,
  lookup_id        uuid not null references public.row_lookups (id) on delete cascade,
  row_id           uuid not null references public.tracker_rows (id) on delete cascade,
  next_at          timestamptz not null default now(),
  last_at          timestamptz,
  last_status      text check (last_status is null or last_status in ('ok', 'error', 'no_data')),
  last_error       text check (last_error is null or char_length(last_error) <= 300),
  fail_count       integer not null default 0,
  primary key (lookup_id, row_id)
);

create index if not exists row_lookup_state_due_idx on public.row_lookup_state (lookup_id, next_at);

comment on table public.row_lookup_state is
  'Por consulta y por fila: cuándo toca volver a preguntar, el último resultado y los fallos seguidos (para espaciar los reintentos).';

alter table public.row_lookups enable row level security;
alter table public.row_lookup_state enable row level security;
revoke all on table public.row_lookups from public, anon, authenticated;
revoke all on table public.row_lookup_state from public, anon, authenticated;
grant select, insert, update, delete on table public.row_lookups to service_role;
grant select, insert, update, delete on table public.row_lookup_state to service_role;

-- El aviso de «llegaste al tope del día» y de «la llave falló» usa la clase
-- `table_sync` ya existente (0161): no hace falta una nueva.
