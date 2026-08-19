-- Tablas que esta empresa se inventa.
--
-- PARA QUÉ ES ESTO. Clientes, vencimientos, cartera y vehículos ya tienen
-- módulo. Lo que no cabe ahí —remates, números de contenedor, placas de un
-- cliente, un tablero de facturas ajenas a Siigo— se inventaba en una hoja o
-- se le pedía a Cortex que lo recordara, y al día siguiente no estaba.
--
-- DOS TABLAS, NO N. El esquema lo pone cada espacio en JSON. Inventar una
-- tabla Postgres por empresa convertiría el catálogo de migraciones en el
-- organigrama de cada cliente. `trackers` es la definición (nombre, campos);
-- `tracker_rows` son las filas (values jsonb). El agente las crea, las llena
-- y las consulta. Quien las lee en el chat ve una tabla, no un JSON.
--
-- LO QUE DELIBERADAMENTE NO HAY. No hay vistas materializadas, ni tipos
-- Postgres por campo, ni un constructor de formularios en la UI. El formulario
-- es la conversación. Un campo nuevo es una llamada a `trackers.define`.

create table public.trackers (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  slug              text not null,
  name              text not null,
  description       text not null default '',
  fields            jsonb not null default '[]'::jsonb,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint trackers_slug_shape
    check (slug ~ '^[a-z][a-z0-9_]{1,47}$'),
  constraint trackers_name_len
    check (char_length(name) between 1 and 80),
  constraint trackers_description_len
    check (char_length(description) <= 500),
  constraint trackers_fields_array
    check (jsonb_typeof(fields) = 'array'),
  constraint trackers_org_slug unique (organization_id, slug)
);

create index if not exists trackers_org_updated_idx
  on public.trackers (organization_id, updated_at desc);

comment on table public.trackers is
  'La definición de una tabla que este espacio se inventó: un slug, un nombre y los campos en JSON. No sustituye clientes, vencimientos ni cartera.';

create table public.tracker_rows (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  tracker_id        uuid not null references public.trackers (id) on delete cascade,
  label             text not null,
  values            jsonb not null default '{}'::jsonb,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint tracker_rows_label_len
    check (char_length(label) between 1 and 200),
  constraint tracker_rows_values_object
    check (jsonb_typeof(values) = 'object')
);

create index if not exists tracker_rows_org_tracker_updated_idx
  on public.tracker_rows (organization_id, tracker_id, updated_at desc);

create index if not exists tracker_rows_values_gin
  on public.tracker_rows using gin (values jsonb_path_ops);

comment on table public.tracker_rows is
  'Una fila de una tabla inventada. `values` sigue el esquema de `trackers.fields`; `label` es cómo se nombra en voz alta.';

alter table public.trackers      enable row level security;
alter table public.tracker_rows  enable row level security;

revoke all on table public.trackers     from public, anon, authenticated;
revoke all on table public.tracker_rows from public, anon, authenticated;

grant select, insert, update, delete on table public.trackers     to service_role;
grant select, insert, update, delete on table public.tracker_rows to service_role;
