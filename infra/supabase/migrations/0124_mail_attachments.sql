-- ===========================================================================
-- LO QUE VENÍA ADJUNTO: los archivos del correo entran al cerebro
-- ===========================================================================
--
-- QUÉ FALTABA. Desde la 0078 (Outlook) y la 0121 (Gmail), Cortex archiva el
-- TEXTO de un hilo: quién escribió, cuándo, y qué decía el cuerpo. Y ahí se
-- paraba. El contrato en PDF que ese correo traía pegado —el que contiene la
-- cláusula, la tarifa, el plazo y la firma— no entraba. Quedaba archivada la
-- frase «te adjunto el contrato» y no el contrato.
--
-- Es el hueco más caro de los que quedaban, porque en una empresa el documento
-- que decide algo casi nunca está en el cuerpo del correo: está colgando de él.
-- Preguntarle a Cortex «¿qué plazo de pago acordamos con Acme?» devolvía la
-- correspondencia sobre el plazo y no el plazo.
--
-- ---------------------------------------------------------------------------
-- UN ADJUNTO ES UN DOCUMENTO, NO UN TROZO DEL HILO
-- ---------------------------------------------------------------------------
-- Se podría haber pegado el texto del PDF al final del documento del hilo. No
-- se hace, y la razón es la recuperación: un hilo es una conversación con
-- autores y horas, troceada con `chunkTranscript`, y un contrato es prosa
-- estructurada que se trocea con `chunkText`. Mezclarlos produce trozos donde
-- media cláusula viene precedida de «Ana dijo a las 10:42», que es una cita
-- falsa — Ana no dijo la cláusula, la mandó.
--
-- Así que cada adjunto es su propio `kb_documents`, con su título, su fecha (la
-- del correo que lo trajo) y sus propios trozos; exactamente igual que si
-- alguien lo hubiera subido a mano. Lo que lo ata al hilo es
-- `parent_document_id`, que es lo que permite contestar «esto salió del correo
-- de tal día» sin tener que adivinarlo por el nombre del archivo.
--
-- `on delete set null` y no una cascada: si alguien borra el hilo, el contrato
-- se queda. Es al revés de lo que sugiere la palabra «padre», y es lo correcto
-- — el adjunto es lo valioso, el correo era el sobre.
--
-- ---------------------------------------------------------------------------
-- POR QUÉ HAY LIBRO, Y POR QUÉ APUNTA TAMBIÉN LO QUE NO SE GUARDÓ
-- ---------------------------------------------------------------------------
-- `mail_attachment_ingests` es el mismo libro que `gmail_thread_ingests` es
-- para los hilos, con una diferencia que importa: aquí se anota TAMBIÉN lo que
-- se decidió NO guardar, con el motivo.
--
-- Sin eso, el barrido de cada mañana volvería a descargarse el mismo vídeo de
-- 30 MB, volvería a decidir que no sabe abrirlo, y volvería a tirarlo — todos
-- los días, para siempre, pagando el ancho de banda cada vez. Con la fila de
-- 'skipped' la segunda mañana cuesta una consulta.
--
-- Y tiene un segundo uso, más humano: cuando alguien pregunte «¿por qué no está
-- la propuesta que me mandaron?», la respuesta está escrita — «pesaba 60 MB», o
-- «era un .zip», o «venía firmado con S/MIME» — en vez de tener que reproducir
-- el barrido para averiguarlo.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. De qué documento salió este documento
-- ---------------------------------------------------------------------------
alter table public.kb_documents
  add column if not exists parent_document_id uuid
    references public.kb_documents(id) on delete set null;

comment on column public.kb_documents.parent_document_id is
  'El documento del que salió éste: el hilo de correo cuyo adjunto es (migración 0124). Null en casi todos. `set null` y no cascada a propósito — si se borra el hilo, el adjunto se queda, porque el adjunto era lo valioso y el correo era el sobre.';

create index if not exists kb_documents_parent_idx
  on public.kb_documents (parent_document_id)
  where parent_document_id is not null;

-- ---------------------------------------------------------------------------
-- 2. El libro de adjuntos
-- ---------------------------------------------------------------------------
create table if not exists public.mail_attachment_ingests (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  -- El dueño del buzón, igual que en `gmail_thread_ingests` y por lo mismo: el
  -- id del adjunto lo asigna cada buzón por su cuenta, así que sin el usuario
  -- dentro dos cuentas de la misma empresa se pisarían las filas.
  user_id          uuid not null references public.users(id) on delete cascade,
  provider         text not null check (provider in ('gmail', 'outlook')),
  thread_id        text not null,
  message_id       text not null,
  -- El id que el proveedor le da al adjunto. En Gmail es el `attachmentId` de
  -- la parte MIME; en Graph, el id del recurso. Cuando no hay ninguno se usa el
  -- sha del contenido, que es peor identificador pero nunca falta.
  attachment_key   text not null,
  filename         text,
  mime             text,
  size_bytes       integer,
  -- Del CONTENIDO, no de la fila. Es lo que hace que el mismo PDF reenviado
  -- tres veces sea un documento y no tres.
  sha256           text not null,
  space_id         uuid references public.kb_collections(id) on delete set null,
  document_id      uuid references public.kb_documents(id) on delete set null,
  status           text not null check (status in ('ready', 'skipped', 'failed')),
  -- Una frase que se le pueda leer a una persona. 'skipped' SIEMPRE trae una.
  reason           text,
  ingested_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.mail_attachment_ingests is
  'Un adjunto de correo visto una vez: si se archivó, en qué documento, y si no, por qué. Anota también lo descartado — sin eso el barrido diario volvería a descargarse el mismo archivo enorme cada mañana para volver a tirarlo.';

-- La identidad de un adjunto es dónde venía colgado. El mensaje va dentro
-- porque el mismo archivo reenviado dentro del hilo es otra aparición, y quien
-- pregunte «¿de qué correo salió?» espera el correo correcto.
create unique index if not exists mail_attachment_ingests_key_idx
  on public.mail_attachment_ingests
     (organization_id, user_id, provider, thread_id, message_id, attachment_key);

-- Y el de-duplicado por contenido: el mismo PDF que ya está en ese espacio no
-- se vuelve a indexar aunque llegue por otro hilo, de otro remitente, otro día.
create index if not exists mail_attachment_ingests_sha_idx
  on public.mail_attachment_ingests (organization_id, space_id, sha256);

create index if not exists mail_attachment_ingests_owner_idx
  on public.mail_attachment_ingests (organization_id, user_id, provider);

create index if not exists mail_attachment_ingests_document_idx
  on public.mail_attachment_ingests (document_id)
  where document_id is not null;

alter table public.mail_attachment_ingests enable row level security;
-- Sin políticas: sólo la llave de servicio, como el resto del esquema.
