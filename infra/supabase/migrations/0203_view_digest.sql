-- ===========================================================================
-- RESUMEN PERIÓDICO DE UNA VISTA
-- ===========================================================================
-- Caso: la gerencia no abre la vista todos los días, pero quiere enterarse de
-- las cifras, de lo que entró desde ayer y de las novedades. En los ajustes de
-- la vista se elige «Enviar un resumen» diario o semanal, a una hora, a
-- miembros del equipo. La configuración vive en el spec de la vista
-- (`spec.digest`: cadence, hour, weekday?, recipients); esto sólo agrega lo que
-- el spec no puede guardar sin que cada envío sea una versión nueva:
--
--   · custom_views.digest_last_sent_at — el momento del último envío (o
--     reclamo). Hace dos cosas: es el «desde cuándo» de las filas nuevas y es
--     la cerradura de idempotencia: el despachador reclama la franja con un
--     UPDATE condicionado a que ningún envío posterior a la franja exista, así
--     que un reintento o dos vueltas del reloj mandan UN solo correo.
--
-- Aditiva e idempotente. Las políticas de RLS de custom_views (0156) cubren la
-- columna nueva; no hacen falta políticas ni grants.

alter table public.custom_views
  add column if not exists digest_last_sent_at timestamptz;

comment on column public.custom_views.digest_last_sent_at is
  'Último envío (o reclamo) del resumen periódico de la vista (spec.digest). Marca el «desde cuándo» de las filas nuevas y evita envíos dobles.';
