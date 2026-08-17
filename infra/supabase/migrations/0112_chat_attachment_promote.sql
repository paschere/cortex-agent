-- ARREPENTIRSE DE «SÓLO ESTE CHAT», SIN VOLVER A SUBIR EL ARCHIVO.
--
-- ===========================================================================
-- QUÉ FALTABA
-- ===========================================================================
-- La 0088 le dio a un archivo soltado en el chat dos destinos y ninguna puerta
-- entre ellos. La decisión se toma en el momento de soltarlo, con la pregunta
-- delante, y esa parte está bien: es el único instante en que la persona sabe
-- de verdad qué es ese archivo. Lo que no está bien es que sea IRREVERSIBLE en
-- la dirección barata.
--
-- Las dos direcciones no cuestan lo mismo y por eso sólo se abre una:
--
--   'memory' → 'turn'  NO SE PUEDE Y NO SE ABRE AQUÍ. Un documento indexado ya
--                      contestó preguntas de otra gente; despublicarlo no
--                      alcanza a las respuestas que ya se dieron. Eso es
--                      exactamente el argumento del encabezado de la 0088.
--
--   'turn' → 'memory'  Es un archivo que hoy no puede leer nadie más y que se
--                      borra solo en una semana. Subirlo al cerebro no le quita
--                      nada a nadie, y hoy la única forma de conseguirlo es
--                      volver a arrastrar el mismo archivo y contestar distinto
--                      — o sea, tenerlo todavía a mano, acordarse de que la
--                      pregunta existió, y pagar el segundo documento si el
--                      digestivo no coincide.
--
-- ===========================================================================
-- POR QUÉ HAY QUE GUARDAR LOS BYTES, Y NO SÓLO EL TEXTO
-- ===========================================================================
-- Hasta ahora el camino 'turn' extraía el texto en la propia petición y tiraba
-- los bytes. Prometer «guárdame ese contrato en el cerebro» y guardar el texto
-- plano que Cortex leyó NO es lo mismo que guardar el contrato: el documento
-- que queda en Brain Knowledge no se puede volver a abrir, ni descargar, ni
-- mandar, ni volver a extraer con un parser mejor el día que lo haya. Un
-- documento del que no se conserva el original es un documento de segunda, y la
-- gente no lo descubre hasta que lo necesita.
--
-- Así que el camino 'turn' guarda también el archivo, en `app_files` (0109),
-- bucket 'chat-uploads', y esta columna apunta ahí. Lo que la 0088 defendía —
-- que 'turn' no toca `kb_documents`, ni el índice, ni el medidor del plan —
-- sigue intacto: el medidor es un disparador sobre `kb_documents` y aquí no se
-- inserta ninguna fila. Preguntarle a Cortex por un PDF sigue costando cero.
--
-- Los bytes viven exactamente lo que vive la fila (`purge_at`, una semana) y se
-- borran con ella: `chat_surface_purge()` se reescribe abajo para que no queden
-- huérfanos en `app_files`, que es el único sitio del que nada volvería a
-- acordarse.
--
-- ===========================================================================
-- POR QUÉ LA PROMOCIÓN SE ANOTA APARTE Y LA FILA SIGUE DICIENDO 'turn'
-- ===========================================================================
-- Lo tentador es cambiarle la `disposition` a 'memory' y llenar `kb_document_id`.
-- Se descarta por dos razones, y la segunda es la que decide:
--
--   1. `disposition` es lo que la persona contestó CUANDO SOLTÓ EL ARCHIVO.
--      Reescribirlo borra el hecho de que hubo dos decisiones, que es
--      justamente lo que se quería poder ver.
--
--   2. El CHECK `chat_attachments_disposition_shape` obliga a que una fila
--      'memory' tenga `extracted_text` nulo. Convertirla exigiría borrar el
--      texto — y ese texto es lo que la conversación EN CURSO está leyendo.
--      Guardar el archivo en el cerebro no puede tener como efecto que Cortex
--      deje de poder contestar sobre él en la misma conversación en la que se
--      lo pidieron, y menos aún mientras la indexación va a medias.
--
-- Idempotente de principio a fin.

-- ---------------------------------------------------------------------------
-- 1. Dónde quedaron los bytes
-- ---------------------------------------------------------------------------
alter table public.chat_attachments
  add column if not exists file_path text;

comment on column public.chat_attachments.file_path is
  'Ruta en app_files (bucket ''chat-uploads'') del archivo tal como se subió, sólo en el camino ''turn''. Existe para que ''guárdalo en la memoria'' guarde el ARCHIVO y no la transcripción que Cortex leyó de él. Nula cuando la fila es anterior a la 0112 o cuando guardar los bytes falló: en ese caso todavía se puede promover el texto, y quien lo haga tiene que decirlo.';

-- Una fila 'memory' no tiene bytes propios: su archivo ya vive en 'kb-uploads'
-- apuntado por el documento. Escrito con `is null or` a mano, y no dejando que
-- `null` decida, por la misma razón que las guardas de la 0106: un CHECK que
-- devuelve NULL pasa, y el día que alguien le añada un `and` a esta expresión
-- el caso vacío dejaría de estar contestado.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_attachments_file_only_on_turn'
  ) then
    alter table public.chat_attachments
      add constraint chat_attachments_file_only_on_turn
      check (file_path is null or disposition = 'turn');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. El rastro de la promoción
-- ---------------------------------------------------------------------------
alter table public.chat_attachments
  add column if not exists promoted_document_id uuid
    references public.kb_documents(id) on delete set null,
  add column if not exists promoted_space_id uuid
    references public.kb_collections(id) on delete set null,
  add column if not exists promoted_at timestamptz;

comment on column public.chat_attachments.promoted_document_id is
  'El documento de Brain Knowledge que salió de este adjunto, cuando alguien se arrepintió del ''sólo este chat''. Es lo que hace que promover dos veces devuelva el mismo documento en vez de indexar una segunda copia y cobrarle al espacio de trabajo dos documentos por un archivo.';
comment on column public.chat_attachments.promoted_space_id is
  'En qué espacio quedó. Se anota aquí además de en el documento para poder decir dónde aterrizó sin un join, igual que hace space_id en el camino ''memory''.';
comment on column public.chat_attachments.promoted_at is
  'Cuándo se promovió. Las tres columnas van juntas o ninguna: media promoción anotada es peor que ninguna, porque se lee como completa.';

-- O las tres o ninguna. `num_nonnulls` cuenta NULLs de verdad, así que este
-- CHECK tiene respuesta también para la fila recién insertada, que es el caso
-- que un `x is not null = y is not null` encadenado contesta por accidente.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_attachments_promotion_complete'
  ) then
    alter table public.chat_attachments
      add constraint chat_attachments_promotion_complete
      check (
        num_nonnulls(promoted_document_id, promoted_space_id, promoted_at) in (0, 3)
      );
  end if;
end
$$;

-- La pregunta que hace la herramienta antes de tocar nada: «este adjunto, ¿ya
-- está en el cerebro?». Parcial porque la inmensa mayoría de los adjuntos nunca
-- se promueven y ninguno de ellos se busca jamás por aquí.
create index if not exists chat_attachments_promoted_idx
  on public.chat_attachments (promoted_document_id)
  where promoted_document_id is not null;

-- ---------------------------------------------------------------------------
-- 3. La retención, que ahora también tiene bytes que barrer
-- ---------------------------------------------------------------------------
-- Misma función y misma cadencia que la 0088; lo único nuevo es que antes de
-- borrar las filas se borran sus archivos. El orden importa y no es negociable:
-- si se borrara la fila primero, la ruta se perdería y el archivo quedaría en
-- `app_files` para siempre sin que nada supiera que existió.
--
-- El documento promovido NO se toca. Ya es un documento ordinario de Brain
-- Knowledge, con su propia copia en 'kb-uploads' y su propia vida; que expire
-- el recibo del chat no puede borrar lo que la persona pidió guardar.
create or replace function public.chat_surface_purge()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_charts bigint;
  v_files  bigint;
begin
  -- A chart somebody kept is not scratch any more, whatever its purge_at says.
  delete from public.chat_charts
   where purge_at < now()
     and saved_report_id is null;
  get diagnostics v_charts = row_count;

  -- Los bytes de los adjuntos que se van, antes que las filas que los nombran.
  delete from public.app_files f
   using public.chat_attachments a
   where a.purge_at < now()
     and a.file_path is not null
     and f.bucket = 'chat-uploads'
     and f.path = a.file_path;

  -- Las 'memory' son un recibo de un documento que vive en otra parte, así que
  -- dejarlas expirar no pierde nada; el documento no se toca. Las 'turn' SON el
  -- texto, y que expiren es el objetivo.
  delete from public.chat_attachments
   where purge_at < now();
  get diagnostics v_files = row_count;

  return v_charts + v_files;
end;
$$;
