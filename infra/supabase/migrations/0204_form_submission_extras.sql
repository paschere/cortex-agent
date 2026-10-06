-- ===========================================================================
-- FORMULARIOS DE VISTA: SIN INTERNET, CORREGIR LO ENVIADO
-- ===========================================================================
-- Caso: el operario llena el formulario en la bodega o en la calle, sin señal;
-- el teléfono guarda el registro y lo envía al volver. Y si se equivoca, puede
-- «Corregir» unos minutos después. Esto agrega a `custom_view_submissions` lo
-- que esas dos cosas necesitan (la aprobación y los pasos viven en el spec):
--
--   · client_id  — id que el NAVEGADOR inventa por envío. Un reintento (la
--     respuesta se perdió, la cola volvió a mandar) trae el mismo id y el
--     servidor devuelve la fila de la primera vez en vez de escribir otra. El
--     índice único (view_id, client_id) lo hace cierto aun con dos reintentos
--     a la vez.
--   · edit_token — la credencial de quien envió SIN sesión para corregir lo
--     suyo dentro de la ventana (`editWindowMinutes` del formulario). Corta, al
--     azar, sólo sirve para este envío; el servidor además valida vista,
--     bloque y la ventana. La tabla sólo la lee service_role.
--
-- Aditiva e idempotente. Las políticas de RLS de la 0156 (todo cerrado salvo
-- service_role) cubren las columnas nuevas: no hacen falta políticas ni grants.

alter table public.custom_view_submissions
  add column if not exists client_id text
    check (client_id is null or char_length(client_id) between 8 and 64),
  add column if not exists edit_token text
    check (edit_token is null or char_length(edit_token) between 16 and 64);

create unique index if not exists custom_view_submissions_client_id_idx
  on public.custom_view_submissions (view_id, client_id)
  where client_id is not null;

comment on column public.custom_view_submissions.client_id is
  'Id de cliente del envío (idempotencia: un reintento no escribe otra fila). Lo inventa el navegador.';
comment on column public.custom_view_submissions.edit_token is
  'Token para corregir el envío sin sesión dentro de la ventana del formulario. Sólo lo lee service_role.';

alter table public.custom_view_submissions enable row level security;
revoke all on table public.custom_view_submissions from public, anon, authenticated;
grant select, insert, update, delete on table public.custom_view_submissions to service_role;
