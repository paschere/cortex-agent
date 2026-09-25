-- ===========================================================================
-- UNA FUENTE QUE LLENA UNA TABLA SOLA
-- ===========================================================================
-- «Hay una hoja (o una API de vuelos): crea una tabla, una vista, y cada vez
-- que llegue un avión que aparezca y se actualice.» Hasta aquí eso no tenía
-- camino: la fuente conectada del Feed es PRIVADA de quien la conectó (0150),
-- no se refresca sola salvo que una activación la use, y una vista sobre ella
-- sólo la ve su dueño.
--
-- `tracker_syncs` une una fuente conectada con una tabla de la empresa: cada
-- `interval_minutes` se vuelve a leer la fuente, cada fila se identifica por
-- sus columnas CLAVE (vuelo + fecha, número de factura) y se agrega si es
-- nueva o se actualiza si cambió. Las filas que desaparecen de la fuente NO se
-- borran: un vuelo que salió del tablero del aeropuerto sigue siendo un vuelo
-- que llegó.
--
-- QUIÉN. Sólo el dueño de la fuente crea la sincronización y la sincronización
-- corre con SU identidad (`created_by`): copiar filas de su Feed privado a una
-- tabla que ve el equipo es una decisión suya, la misma que publicar una
-- activación. Si pierde el acceso, la fuente deja de leerse y la
-- sincronización queda en error, no en silencio.
--
-- LA CLAVE vive en `tracker_rows.external_key`, única por tabla. Es lo que
-- hace que correr dos veces no duplique nada.
--
-- Y una clase de aviso nueva, `table_sync`: «3 vuelos nuevos, 2 cambiaron».
--
-- Tenencia: `organization_id` en cada fila, `tenant()` en tenancy/tables.ts.

alter table public.tracker_rows
  add column if not exists external_key text
  check (external_key is null or char_length(external_key) between 1 and 400);

create unique index if not exists tracker_rows_external_key_idx
  on public.tracker_rows (tracker_id, external_key)
  where external_key is not null;

create table public.tracker_syncs (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     text not null,
  source_id           uuid not null references public.feed_sources (id) on delete cascade,
  sheet_index         smallint not null default 0 check (sheet_index between 0 and 19),
  tracker_id          uuid not null references public.trackers (id) on delete cascade,
  -- { campo_de_la_tabla: "encabezado de la fuente" }
  mapping             jsonb not null check (jsonb_typeof(mapping) = 'object'),
  -- Campos de la tabla que forman la identidad de una fila.
  key_fields          text[] not null check (cardinality(key_fields) between 1 and 5),
  interval_minutes    integer not null default 15 check (interval_minutes between 5 and 1440),
  notify              boolean not null default true,
  enabled             boolean not null default true,
  created_by          uuid not null,
  next_run_at         timestamptz not null default now(),
  last_run_at         timestamptz,
  last_status         text check (last_status is null or last_status in ('ok', 'error')),
  last_error          text check (last_error is null or char_length(last_error) <= 500),
  last_inserted       integer not null default 0,
  last_updated        integer not null default 0,
  last_skipped        integer not null default 0,
  created_at          timestamptz not null default now(),
  constraint tracker_syncs_one_per_pair unique (organization_id, source_id, sheet_index, tracker_id)
);

create index tracker_syncs_due_idx on public.tracker_syncs (next_run_at) where enabled;

comment on table public.tracker_syncs is
  'Una fuente conectada del Feed que llena una tabla de la empresa cada cierto tiempo: agrega filas nuevas y actualiza las que cambiaron, identificadas por sus campos clave. Corre con la identidad de quien la creó, que es el dueño de la fuente.';

alter table public.tracker_syncs enable row level security;
revoke all on table public.tracker_syncs from public, anon, authenticated;
grant select, insert, update, delete on table public.tracker_syncs to service_role;

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'flow_finished','flow_failed','flow_needs_person','routine_finished','routine_failed',
  'errand_asked','errand_finished','action_sent','action_failed','report_ready','mail_worth_seeing',
  'management_attention','receivables_overdue','view_activity','table_sync'
));
