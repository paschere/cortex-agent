-- ===========================================================================
-- REGLA DE DUPLICADOS POR TABLA
-- ===========================================================================
-- Caso: el mismo código (guía, pedido, factura, serial…) registrado dos veces
-- con datos distintos —otra fecha, otra ubicación— casi siempre es un error de
-- digitación que hay que corregir antes de seguir (despachar, pagar, contar).
-- Cortex marca TODAS las filas del conflicto con un estado («Duplicado») y lo
-- quita solo cuando el conflicto se resuelve.
--
--   · trackers.duplicates — la regla, en JSON:
--       { "key": "numero_guia", "distinctBy": "fecha",
--         "flagField": "estado", "flagValue": "Duplicada" }
--     La forma y que los campos existan se validan en código
--     (trackers/duplicates.ts), no aquí: cambiar la regla no es una migración.
--     Null = la tabla no tiene regla (todas las que ya existen).
--   · tracker_rows.duplicate_flagged — true cuando la marca de la fila la puso
--     la regla. Sirve para una sola cosa: al resolverse el conflicto, la regla
--     sólo desmarca lo que ella marcó; un «Duplicada» escrito a mano no se toca.
--
-- Aditiva e idempotente. Las políticas de RLS de las dos tablas (0115) cubren
-- las columnas nuevas: no hacen falta políticas ni grants nuevos.

alter table public.trackers
  add column if not exists duplicates jsonb;

alter table public.trackers
  drop constraint if exists trackers_duplicates_object;
alter table public.trackers
  add constraint trackers_duplicates_object
  check (duplicates is null or jsonb_typeof(duplicates) = 'object');

alter table public.tracker_rows
  add column if not exists duplicate_flagged boolean not null default false;

comment on column public.trackers.duplicates is
  'Regla de duplicados: { key, distinctBy?, flagField, flagValue }. Se aplica en trackers/duplicates.ts después de cada escritura de filas.';
comment on column public.tracker_rows.duplicate_flagged is
  'true si la marca de duplicado de esta fila la puso la regla de la tabla (y por tanto la regla puede quitarla).';
