-- ===========================================================================
-- UNA CARPETA DE DRIVE QUE LLENA UNA TABLA
-- ===========================================================================
-- «El agente de carga de afuera nos deja cada guía en una carpeta de Drive: un
-- PDF o un Excel por guía. Que cada archivo nuevo sea una fila en la tabla
-- Guías, y nosotros sólo asignamos el dolly.» Hasta aquí eso no tenía camino:
-- la sincronización de Drive (drive-sync) lleva los archivos a Brain Knowledge,
-- que sirve para PREGUNTAR, no para tener una fila con número de guía, vuelo,
-- piezas y peso que el equipo pueda filtrar y asignar.
--
-- `drive_folder_syncs` une una carpeta de Drive con una tabla de la empresa:
-- cada `interval_minutes` se lista la carpeta con la identidad de quien la
-- conectó (`created_by`), cada archivo nuevo —o con una revisión nueva— se lee
-- (PDF, Word, Excel, Hoja de cálculo de Google) y el modelo saca los campos de
-- `extract_fields`. Una fila por guía; un archivo que trae varias guías da
-- varias filas. La identidad de la fila son sus campos CLAVE (el número de
-- guía), en `tracker_rows.external_key` (0161), así que leer dos veces el mismo
-- archivo —o recibir la misma guía corregida en otro archivo— actualiza, no
-- duplica.
--
-- LO QUE NO SE INVENTA. El documento es dato, nunca instrucción. Cada valor
-- viene con la frase del documento donde está escrito; si la frase no está en
-- el archivo, o el valor no está en la frase, el valor NO se guarda. Un campo
-- dudoso, o una guía sin número, igual crea la fila, pero marcada «Por
-- revisar» (si la tabla tiene ese campo) y anotada en el libro de archivos con
-- el motivo. Un archivo que no se pudo leer queda en error, visible.
--
-- EL LIBRO DE ARCHIVOS. `drive_folder_sync_files` es una fila por archivo y
-- sincronización: qué revisión se leyó, qué filas produjo, qué se sacó y con
-- qué dudas. Es lo que hace que cada archivo se lea UNA vez por revisión (la
-- lectura cuesta una llamada al modelo) y lo que contesta «¿por qué esta guía
-- dice Por revisar?».
--
-- QUIÉN. Sólo quien tiene acceso a la carpeta la conecta, y la lectura corre
-- con SUS credenciales de Google: copiar documentos de su Drive a una tabla
-- que ve el equipo es decisión suya. Si pierde el acceso, la sincronización
-- queda en error, no en silencio.
--
-- Tenencia: `organization_id` en las dos tablas, `tenant()` en tenancy/tables.ts.
-- El aviso reutiliza la clase `table_sync` (0161).

create table public.drive_folder_syncs (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     text not null,
  created_by          uuid not null,
  folder_id           text not null check (char_length(folder_id) between 5 and 200),
  folder_name         text not null default '' check (char_length(folder_name) <= 200),
  tracker_id          uuid not null references public.trackers (id) on delete cascade,
  -- [{ "key": "guia", "hint": "Número de guía aérea, p. ej. 045-12345678" }]
  -- Sólo los campos que se LEEN del documento; los demás (estado, dolly) son
  -- del equipo y la sincronización no los toca después de crear la fila.
  extract_fields      jsonb not null check (
                        jsonb_typeof(extract_fields) = 'array'
                        and jsonb_array_length(extract_fields) between 1 and 20
                      ),
  -- Campos de la tabla que forman la identidad de una fila (número de guía).
  key_fields          text[] not null check (cardinality(key_fields) between 1 and 5),
  -- Valores con que nace una fila nueva: { "estado": "Pendiente" }.
  defaults            jsonb not null default '{}'::jsonb check (jsonb_typeof(defaults) = 'object'),
  -- Indicaciones de la empresa para leer sus documentos («el peso viene en
  -- libras en las guías de Miami»). Contexto, nunca reglas que el documento
  -- pueda cambiar.
  instructions        text not null default '' check (char_length(instructions) <= 1000),
  interval_minutes    integer not null default 10 check (interval_minutes between 10 and 1440),
  notify              boolean not null default true,
  enabled             boolean not null default true,
  next_run_at         timestamptz not null default now(),
  last_run_at         timestamptz,
  last_status         text check (last_status is null or last_status in ('ok', 'error')),
  last_error          text check (last_error is null or char_length(last_error) <= 500),
  last_files          integer not null default 0,
  last_inserted       integer not null default 0,
  last_updated        integer not null default 0,
  last_needs_review   integer not null default 0,
  last_failed         integer not null default 0,
  created_at          timestamptz not null default now(),
  constraint drive_folder_syncs_one_per_pair unique (organization_id, folder_id, tracker_id)
);

create index drive_folder_syncs_due_idx on public.drive_folder_syncs (next_run_at) where enabled;

comment on table public.drive_folder_syncs is
  'Una carpeta de Google Drive que llena una tabla de la empresa: cada archivo nuevo o cambiado se lee y sus campos (con la frase que los respalda) se vuelven filas, identificadas por sus campos clave. Corre con las credenciales de Google de quien la creó.';

create table public.drive_folder_sync_files (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     text not null,
  sync_id             uuid not null references public.drive_folder_syncs (id) on delete cascade,
  file_id             text not null check (char_length(file_id) between 1 and 200),
  file_name           text not null default '' check (char_length(file_name) <= 300),
  mime_type           text not null default '' check (char_length(mime_type) <= 200),
  -- md5 del archivo o, para un documento nativo de Google, su modifiedTime.
  revision            text not null default '' check (char_length(revision) <= 200),
  status              text not null check (status in ('ok', 'needs_review', 'error')),
  -- Las filas de la tabla que salieron de este archivo (una o varias guías).
  tracker_row_ids     uuid[] not null default '{}',
  -- Lo que se sacó, fila por fila: [{ "key": "...", "values": {...}, "review": [...] }]
  extracted           jsonb not null default '[]'::jsonb check (jsonb_typeof(extracted) = 'array'),
  -- Por qué quedó por revisar o en error, en español, para la persona.
  notes               text[] not null default '{}' check (cardinality(notes) <= 40),
  error               text check (error is null or char_length(error) <= 500),
  -- Un error pasajero (Drive no respondió, el modelo tardó) se reintenta en la
  -- siguiente corrida hasta tres veces; uno permanente (imagen, PDF escaneado)
  -- nace con el tope y no se vuelve a pagar hasta que el archivo cambie.
  attempts            smallint not null default 1 check (attempts between 0 and 100),
  processed_at        timestamptz not null default now(),
  constraint drive_folder_sync_files_one_per_file unique (sync_id, file_id)
);

create index drive_folder_sync_files_recent_idx
  on public.drive_folder_sync_files (organization_id, sync_id, processed_at desc);

comment on table public.drive_folder_sync_files is
  'El libro de archivos de una carpeta sincronizada: qué revisión de cada archivo se leyó, qué filas produjo, qué se sacó y con qué dudas. Garantiza que cada archivo se lee una vez por revisión.';

alter table public.drive_folder_syncs      enable row level security;
alter table public.drive_folder_sync_files enable row level security;

revoke all on table public.drive_folder_syncs      from public, anon, authenticated;
revoke all on table public.drive_folder_sync_files from public, anon, authenticated;

grant select, insert, update, delete on table public.drive_folder_syncs      to service_role;
grant select, insert, update, delete on table public.drive_folder_sync_files to service_role;
