-- ===========================================================================
-- EL BUZÓN DE GMAIL COMO MEMORIA: la carga histórica y el puntero diario
-- ===========================================================================
--
-- Cortex ya sabía LEER correo (las herramientas `gmail.*` desde el principio) y
-- ya sabía GUARDAR correo en el cerebro — pero sólo el de Outlook, y sólo hilo
-- por hilo, a mano (migración 0078). Faltaban las dos cosas que convierten un
-- buzón en memoria de verdad:
--
--   1. LA CARGA INICIAL. Conectar una cuenta y traerse el histórico entero de
--      una vez, para que el cerebro sepa quién es esta persona, con quién
--      habla, cómo escribe y qué prometió — desde el primer día y no desde el
--      primer correo nuevo.
--   2. EL PUNTERO. Volver cada mañana y leer SÓLO lo que llegó desde ayer, sin
--      releer el buzón entero ni depender de que nadie apague nada.
--
-- ---------------------------------------------------------------------------
-- LA REGLA DE PRIVACIDAD, QUE AQUÍ CAMBIA Y POR QUÉ
-- ---------------------------------------------------------------------------
-- La 0078 dijo, para Outlook: sólo se archivan hilos donde hay alguien de
-- FUERA de la empresa, porque el correo interno es correspondencia privada de
-- un empleado y meterla en un espacio compartido es publicarla. Esa regla sigue
-- viva y no se toca: NADA interno llega jamás a un espacio global.
--
-- Lo que se añade es el otro lado de la misma moneda. El espacio PERSONAL de
-- alguien (kb_collections con scope='user', que sólo esa persona puede leer —
-- ver kb/spaces.ts y la 0049) no es un sitio compartido: es su cuaderno. Ahí sí
-- entra su buzón entero, interno incluido, porque es exactamente la información
-- que esa persona ya tiene y que quiere que Cortex tenga para trabajar por
-- ella. La regla queda entonces en una frase:
--
--     al espacio personal del dueño del buzón entra todo;
--     a un espacio compartido, sólo lo que tiene a alguien de fuera.
--
-- Esa frase la hace cumplir `gmail/ingest-thread.ts`, en un solo sitio, y
-- `assertCanWriteToSpace` sigue siendo quien decide si la persona puede
-- siquiera escribir en el espacio que eligió.
--
-- ---------------------------------------------------------------------------
-- POR QUÉ DOS TABLAS Y NO UNA
-- ---------------------------------------------------------------------------
-- `gmail_thread_ingests` es el LIBRO: una fila por hilo archivado, que es lo
-- que hace que archivar dos veces sea gratis. `gmail_sync_state` es el
-- MARCAPÁGINAS: una fila por buzón conectado, que es lo que hace que el barrido
-- de mañana no vuelva a empezar por el principio. Son dos hechos con vidas
-- distintas — un hilo se archiva una vez y no se vuelve a tocar; el puntero se
-- reescribe cada mañana — y meterlos en la misma tabla obligaría a escribir la
-- fila del buzón entero cada vez que cambia un hilo.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Gmail como procedencia de un documento
-- ---------------------------------------------------------------------------
-- Mismo movimiento que la 0078 hizo con 'outlook'. OJO al leer esto: Postgres
-- no deja USAR un valor de enum en la misma transacción en que se añade (es lo
-- que explica la 0081). Aquí no se usa en SQL en ningún punto de este archivo
-- — sólo lo escribe el código de la aplicación, en otra transacción — así que
-- vive sin problema junto a las tablas.
alter type document_source add value if not exists 'gmail';

-- ---------------------------------------------------------------------------
-- 2. EL LIBRO: qué hilo de Gmail es qué documento
-- ---------------------------------------------------------------------------
-- Espejo deliberado de `microsoft_mail_ingests` (0078 § 2), hasta en los
-- nombres de las columnas: un hilo de Gmail y una conversación de Outlook son
-- el mismo objeto, y todo lo que se construya para leer uno debe servir para el
-- otro sin traducir nada.
create table if not exists public.gmail_thread_ingests (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      text not null references public.ba_organization(id) on delete cascade,
  -- El dueño del buzón. NO es opcional aquí, a diferencia de Outlook: la
  -- unicidad depende de él (ver el índice más abajo) y un archivo del buzón de
  -- alguien sin ese alguien no se puede ni leer ni borrar con sentido.
  user_id              uuid not null references public.users(id) on delete cascade,
  -- El `threadId` de Gmail. Estable mientras el hilo crece, que es justo lo que
  -- lo hace la clave de idempotencia correcta.
  thread_id            text not null,
  -- El Message-ID de RFC 5322 del primer mensaje: el único identificador que
  -- sobrevive a salirse de Google. El mismo hilo reencontrado en otro sistema
  -- de correo es el mismo hilo.
  internet_message_id  text,
  subject              text,
  space_id             uuid references public.kb_collections(id) on delete set null,
  document_id          uuid references public.kb_documents(id) on delete set null,
  -- El dominio de fuera con el que es esta correspondencia, cuando hay
  -- exactamente uno corporativo. Null para un hilo entre varias empresas, para
  -- uno que sólo tiene buzones gratuitos, y para el correo interno.
  counterpart_domain   text,
  -- El cliente al que pertenece esta correspondencia, cuando el dominio de la
  -- contraparte estaba registrado a nombre de uno (`client_domains`, 0075). Es
  -- null muchisimo mas a menudo de lo que no: un vinculo que no se gano es peor
  -- que ninguno.
  client_id            uuid references public.clients(id) on delete set null,
  -- true cuando NADIE de fuera de la empresa está en el hilo. Se guarda en vez
  -- de deducirse, porque la lista de dominios internos puede cambiar y lo que
  -- importa auditar es qué se creyó EN EL MOMENTO de archivar.
  internal_only        boolean not null default false,
  message_count        integer not null default 0,
  first_message_at     timestamptz,
  last_message_at      timestamptz,
  -- Hash del texto ensamblado. Igual quiere decir que nada cambió, que quiere
  -- decir que no se vuelve a pagar un solo embedding.
  sha256               text,
  status               text not null default 'ready'
    check (status in ('ready', 'failed')),
  -- Una frase sobre la que alguien pueda actuar, nunca una traza de pila.
  error                text,
  ingested_at          timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- LA UNICIDAD LLEVA EL USUARIO DENTRO, y ésa es la única diferencia de fondo
-- con la tabla de Outlook. Un `threadId` de Gmail lo asigna cada buzón por su
-- cuenta: dos cuentas del mismo espacio de trabajo pueden usar el mismo id para
-- hilos que no tienen nada que ver. Sin el `user_id` en la clave, el segundo
-- buzón conectado empezaría a pisar los documentos del primero, y el síntoma
-- sería un documento cuyo contenido cambia solo.
create unique index if not exists gmail_thread_ingests_owner_thread_idx
  on public.gmail_thread_ingests (organization_id, user_id, thread_id);

create index if not exists gmail_thread_ingests_org_recent_idx
  on public.gmail_thread_ingests (organization_id, last_message_at desc);

create index if not exists gmail_thread_ingests_client_idx
  on public.gmail_thread_ingests (organization_id, client_id)
  where client_id is not null;

comment on table public.gmail_thread_ingests is
  'Una fila por hilo de Gmail doblado dentro de Brain Knowledge. Unica en (organizacion, usuario, hilo) porque el threadId de Gmail solo es unico dentro de un buzon; sha256 es lo que impide re-embeber un hilo que no cambio. A diferencia de Outlook, aqui SI hay filas de correo interno: solo cuando el destino es el espacio personal del dueno del buzon.';

-- ---------------------------------------------------------------------------
-- 3. EL MARCAPÁGINAS: por dónde iba este buzón
-- ---------------------------------------------------------------------------
-- Una fila por buzón conectado. La clave primaria es el usuario porque una
-- persona tiene una cuenta de Google conectada, no varias: el token vive en
-- `integrations` por (usuario, proveedor) y este puntero es el estado de ESA
-- conexión.
--
-- LLEVA DOS PUNTEROS Y NO UNO, porque la carga histórica y el barrido diario
-- avanzan en direcciones opuestas y a velocidades distintas:
--
--   `backfill_cursor`  el pageToken de Gmail mientras se baja el histórico.
--                      Va hacia ATRÁS en el tiempo y sólo existe hasta que
--                      termina. Null y `backfill_done_at` puesto = terminó.
--   `history_id`       el marcador incremental de Gmail. Va hacia ADELANTE,
--                      una vez por barrido, para siempre.
--
-- POR QUÉ `history_id` Y NO UNA FECHA. La History API contesta «qué cambió
-- desde este punto», que es la pregunta exacta del barrido: un correo que llegó
-- ayer y se leyó hoy sale una sola vez, y uno que llegó con fecha vieja (los
-- hay: reenvíos, importaciones, relojes mal puestos) no se pierde por caer
-- fuera de la ventana. El precio es que Google lo caduca a los pocos días de no
-- usarlo, y entonces contesta 404; el barrido tiene que saber volver a una
-- consulta por fecha usando `last_synced_at`, y por eso esa columna existe
-- aunque el puntero bueno sea el otro.
create table if not exists public.gmail_sync_state (
  user_id           uuid primary key references public.users(id) on delete cascade,
  organization_id   text not null references public.ba_organization(id) on delete cascade,
  -- La dirección del buzón, tal como la reporta Google. Se guarda para que una
  -- pantalla pueda decir DE QUÉ cuenta está hablando sin ir a pedirla.
  email_address     text,
  -- Dónde aterriza lo que se archiva. Normalmente el espacio personal del
  -- dueño; se guarda para que el barrido de mañana no tenga que volver a
  -- decidirlo y para que un cambio de destino sea un acto explícito.
  space_id          uuid references public.kb_collections(id) on delete set null,
  -- Cuánto histórico pidió esta persona. Cuatro valores y no un número libre:
  -- cada uno es una decisión de cuánto gastar en embeddings, y una lista corta
  -- es lo que permite que la pantalla la ofrezca como cuatro botones.
  backfill_window   text not null default '12m'
    check (backfill_window in ('1m', '90d', '6m', '12m')),
  backfill_cursor   text,
  -- Cuántos hilos lleva bajados la carga histórica. Es para poder DECIRLO
  -- («van 1.240 de tu último año»), que en una carga que dura horas es la
  -- diferencia entre una espera y un silencio.
  backfill_threads  integer not null default 0,
  backfill_started_at timestamptz,
  backfill_done_at  timestamptz,
  history_id        text,
  last_synced_at    timestamptz,
  -- El último fallo, en una frase. Se limpia en cuanto un barrido sale bien.
  last_error        text,
  -- El interruptor. Puesto por la persona («deja de leer mi correo») o por el
  -- propio barrido tras fallar de forma que reintentar no va a arreglar (un
  -- permiso revocado). Un buzón pausado no se toca hasta que alguien lo diga.
  paused            boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists gmail_sync_state_org_idx
  on public.gmail_sync_state (organization_id);

-- El barrido pregunta «a quién le toca», y le toca a quien no está pausado.
create index if not exists gmail_sync_state_due_idx
  on public.gmail_sync_state (last_synced_at)
  where paused = false;

comment on table public.gmail_sync_state is
  'Una fila por buzon de Gmail conectado: hasta donde llego la carga historica (backfill_cursor) y por donde va el barrido diario (history_id). history_id es el puntero bueno --Gmail contesta que cambio desde el--, pero Google lo caduca tras varios dias sin usarlo y devuelve 404; last_synced_at existe para que el barrido pueda caer a una consulta por fecha cuando eso pasa.';

-- ---------------------------------------------------------------------------
-- 4. El disparador de `updated_at`
-- ---------------------------------------------------------------------------
-- La función ya existe desde la 0075; aquí sólo se cuelga de las dos tablas
-- nuevas, igual que hizo la 0078 con las suyas.
drop trigger if exists gmail_thread_ingests_touch on public.gmail_thread_ingests;
create trigger gmail_thread_ingests_touch
  before update on public.gmail_thread_ingests
  for each row execute function public.touch_updated_at();

drop trigger if exists gmail_sync_state_touch on public.gmail_sync_state;
create trigger gmail_sync_state_touch
  before update on public.gmail_sync_state
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Cerrado por defecto
-- ---------------------------------------------------------------------------
-- SIN POLÍTICAS Y A PROPÓSITO, como en la 0119 y las que la siguieron: con RLS
-- activo y ninguna política, la tabla sólo es alcanzable por el rol de servicio
-- —que es por donde entra todo el producto, con el handle ya clavado al espacio
-- de trabajo (`createOrgScopedClient`)— y no por una llave anónima que se
-- filtre en un bundle. Para dos tablas cuyo contenido es el buzón de alguien,
-- «cerrado salvo que se abra» es la única postura defendible.
alter table public.gmail_thread_ingests enable row level security;
alter table public.gmail_sync_state enable row level security;
