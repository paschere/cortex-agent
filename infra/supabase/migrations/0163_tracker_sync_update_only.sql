-- ===========================================================================
-- UNA FUENTE QUE ACTUALIZA FILAS QUE YA EXISTEN, SIN AGREGAR NINGUNA
-- ===========================================================================
-- La 0161 llena una tabla: agrega lo nuevo y actualiza lo que cambió. Para la
-- carga aérea hace falta lo contrario: la tabla «Guías» ya tiene sus filas
-- (llegan del Drive del socio), y la API de vuelos sólo tiene que ESCRIBIR EN
-- ELLAS el estado del vuelo cuando cruzan por vuelo + fecha — sin meter en la
-- tabla los cientos de vuelos del aeropuerto que no traen carga de nadie.
--
-- `mode = 'update_only'`: las columnas clave se comparan contra los VALORES de
-- las filas (no contra external_key, que en «Guías» es el número de guía), y
-- un vuelo actualiza todas las guías que lo comparten. Nunca inserta.

alter table public.tracker_syncs
  add column if not exists mode text not null default 'upsert'
  check (mode in ('upsert', 'update_only'));

comment on column public.tracker_syncs.mode is
  'upsert (0161): agrega y actualiza por external_key. update_only: sólo escribe en filas existentes que coinciden por los valores de key_fields; nunca agrega.';
