-- Avisos: hechos con hora, no trabajo pendiente.
--
-- ---------------------------------------------------------------------------
-- LO QUE FALTABA
-- ---------------------------------------------------------------------------
-- Cortex trabaja de noche y por su cuenta: una rutina corre a las seis, un
-- trámite entra al RUNT y baja un certificado, un encargo se atasca y pregunta
-- algo, una acción aprobada sale por correo. Hasta esta migración nada de eso
-- dejaba rastro que una persona pudiera mirar después. Si estabas delante de la
-- pantalla te enterabas; si no, no.
--
-- La campana de la barra superior era un enlace a /approvals, y antes de eso un
-- botón sin destino con el punto de «no leído» pintado en todas las cargas — un
-- aviso que siempre está encendido es la manera más rápida de enseñarle a
-- alguien a no mirarlo nunca.
--
-- ---------------------------------------------------------------------------
-- ESTO NO ES UNA QUINTA COLA, Y LA DISTINCIÓN ES LA TABLA ENTERA
-- ---------------------------------------------------------------------------
-- Ya hay cuatro colas de trabajo pendiente (mcp_pending_actions, commitments,
-- actions, errands) y una pantalla que las reúne. Una cola es ESTADO: algo
-- sigue ahí hasta que alguien actúa, y si no lo miras hoy sigue esperándote
-- mañana. Un aviso es un HECHO PUNTUAL con hora: pasó, se lee una vez y se
-- archiva. Su valor es enterarte, no actuar.
--
-- De ahí salen tres decisiones de esquema que parecen ausencias:
--
--   * NO HAY `state`, `assignee` NI `resolved_at`. Un aviso no se resuelve, se
--     lee. Lo único que cambia después de escribirlo es `read_at`.
--   * NO HAY `expires_at`. Un vencimiento que sigue vencido pertenece a la cola
--     de compromisos; aquí sólo cabe «se venció ayer y nadie hizo nada», y eso
--     es verdad para siempre porque ya pasó.
--   * `href` SÓLO PUEDE SER UNA RUTA INTERNA (ver el CHECK). Un aviso lleva a
--     donde ocurrió la cosa dentro del producto. Si pudiera llevar a cualquier
--     URL, esta tabla sería el único sitio del producto donde algo escrito por
--     una integración acaba siendo un enlace en el que alguien confía y hace
--     clic. No hace falta esa capacidad, así que no existe.
--
-- ---------------------------------------------------------------------------
-- POR QUÉ `kind` ES UN CHECK Y NO TEXTO LIBRE
-- ---------------------------------------------------------------------------
-- Mismo argumento que `errands.kind` en la 0089: un producto que avisa de todo
-- se silencia el primer día. Con un CHECK, añadir una clase de aviso cuesta una
-- migración y una discusión; con texto libre cuesta una línea, y en seis meses
-- hay cuarenta clases y nadie mira la campana. La fricción es el mecanismo.
--
-- La regla que decide qué entra, escrita aquí porque es de producto y no de
-- código: UN AVISO ES EL CANAL DE ÚLTIMA INSTANCIA. Si el hecho ya viajó por un
-- canal que la persona mira —un correo, un DM de Chat, un mensaje en la
-- conversación donde lo pidió— no se duplica aquí. Las dos excepciones son los
-- fracasos y las cosas que piden algo de la persona, donde llegar dos veces
-- cuesta mucho menos que no llegar. La implementación está en
-- apps/web/lib/notifications/producers.ts y cada productor cita esta regla.
--
-- ---------------------------------------------------------------------------
-- ATENCIÓN AL ESCRIBIR: LA LECCIÓN DE LA 0064 → 0095
-- ---------------------------------------------------------------------------
-- Esta tabla nace con `organization_id` y `user_id` NOT NULL desde la primera
-- línea, y con UNA SOLA función de escritura en toda la aplicación
-- (`notify()`, en apps/web/lib/notifications/notify.ts) que los pone los dos.
-- Eso es deliberado: la 0064 le añadió `organization_id NOT NULL` a
-- `user_memories` sin volver sobre `user_memory_remember()` de la 0051, y
-- durante semanas el producto no pudo guardar ni una memoria mientras la
-- lectura seguía funcionando perfectamente. Si alguna vez se le añade una
-- columna obligatoria a esta tabla, `notify()` es el único sitio que hay que
-- revisar — y ese «único» es la mitad del valor del diseño.

-- ===========================================================================
-- 1. La tabla
-- ===========================================================================

create table if not exists public.notifications (
  id               uuid primary key default gen_random_uuid(),

  -- El espacio de trabajo. TEXT y no uuid porque los ids de better-auth lo son,
  -- igual que en todas las tablas desde la 0064. Un aviso pertenece a la empresa
  -- dentro de la cual ocurrió el hecho, y toda lectura se filtra por esto.
  organization_id  text not null
                     references public.ba_organization(id) on delete cascade,

  -- El destinatario, y NO es nullable a propósito. Un aviso sin destinatario no
  -- es un aviso, es una fila. Que se borre con la persona también es correcto:
  -- lo que quedó hecho vive en la tabla del trámite, del encargo o de la
  -- rutina; esto era sólo el recado.
  user_id          uuid not null references public.users(id) on delete cascade,

  -- Qué clase de hecho. Ampliarlo es una migración, a propósito (ver la nota).
  kind             text not null check (kind in (
                     -- Trámites web (0087). El caso que da nombre al producto:
                     -- «el trámite del RUNT terminó y te dejó el certificado».
                     'flow_finished',
                     'flow_failed',
                     -- El trámite se paró a pedir algo que sólo una persona
                     -- puede dar: un captcha, una clave, una verificación.
                     'flow_needs_person',
                     -- Rutinas (scheduled_jobs). Sólo el fracaso, y el éxito
                     -- únicamente cuando la rutina no tiene otro canal.
                     'routine_finished',
                     'routine_failed',
                     -- Encargos (0089).
                     'errand_asked',
                     'errand_finished',
                     -- Acciones (0077): lo que salió con la firma de alguien.
                     'action_sent',
                     'action_failed'
                   )),

  -- El color, y sólo el color. Se guarda en vez de derivarse de `kind` para que
  -- una clase pueda ser buena o mala según el desenlace sin partirse en dos.
  tone             text not null default 'info'
                     check (tone in ('info', 'good', 'warning', 'bad')),

  -- Qué pasó, de qué. Una frase para una persona, escrita con reglas: NINGÚN
  -- productor llama a un modelo para redactar esto. Un aviso generado sería
  -- distinto en cada corrida para el mismo hecho, costaría una llamada por
  -- suceso y nadie podría comprobar que dice la verdad.
  title            text not null check (length(btrim(title)) between 1 and 160),
  -- El detalle: qué puede hacer, o por qué falló. Corto por diseño — esto se
  -- lee en una lista, y lo largo está al otro lado del enlace.
  body             text check (body is null or length(btrim(body)) between 1 and 600),

  -- A dónde ir. Ruta interna del producto y nada más; ver la cabecera.
  href             text check (
                     href is null
                     or (href like '/%' and href not like '//%' and length(href) between 2 and 400)
                   ),

  -- De dónde salió. Sirve para dos cosas concretas y para nada más: agrupar
  -- repeticiones del mismo suceso, y poder responder «¿de esta corrida ya se
  -- avisó?» sin adivinarlo por el texto.
  source_kind      text check (source_kind in ('flow_run', 'routine_run', 'errand', 'action')),
  -- TEXT y no uuid: la corrida de un trámite, la de una rutina, un encargo y una
  -- acción tienen ids uuid hoy, pero el origen es una referencia débil por
  -- diseño — un aviso sobrevive al borrado de aquello de lo que habla, porque
  -- el hecho ocurrió igual.
  source_id        text check (source_id is null or length(btrim(source_id)) between 1 and 200),

  -- ── El agrupado ────────────────────────────────────────────────────────
  -- Qué cuenta como «lo mismo otra vez». Lo escribe `notify()`; por defecto es
  -- kind + origen, así que un trámite que falla cuatro veces esta mañana es una
  -- fila con `occurrences = 4` y no cuatro campanadas.
  --
  -- El agrupado SÓLO COLAPSA MIENTRAS NO SE HA LEÍDO (ver el índice único
  -- parcial abajo). En cuanto alguien lee el aviso, la siguiente vez que pase
  -- lo mismo es una noticia nueva y merece su propia fila. Lo contrario —
  -- reabrir una fila ya leída — convierte la bandeja en algo que cambia debajo
  -- de quien la está mirando.
  group_key        text not null check (length(btrim(group_key)) between 1 and 200),
  occurrences      integer not null default 1 check (occurrences >= 1),

  -- Cuándo pasó (la última vez, si se agrupó) y cuándo se escribió la fila. Son
  -- dos cosas distintas y la bandeja ordena por la primera.
  occurred_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),

  -- Null = no leído. Es todo el ciclo de vida que tiene esta tabla.
  read_at          timestamptz,

  -- El origen es entero o no está. Un `source_kind` sin id no agrupa nada y un
  -- id sin clase no se puede resolver a una pantalla.
  constraint notifications_source_is_whole check ((source_kind is null) = (source_id is null))
);

-- La bandeja: un espacio, una persona, lo más reciente primero.
create index if not exists notifications_inbox_idx
  on public.notifications (organization_id, user_id, occurred_at desc);

-- El contador de la campana. Parcial porque lo no leído es la minoría y es lo
-- único que se cuenta.
create index if not exists notifications_unread_idx
  on public.notifications (organization_id, user_id)
  where read_at is null;

-- EL AGRUPADO, COMO REGLA DE LA BASE Y NO COMO COSTUMBRE DE LA APLICACIÓN.
-- Como mucho un aviso sin leer por persona y por `group_key`. Dos productores
-- concurrentes (el cron y la pantalla, por ejemplo) no pueden dejar dos filas
-- iguales sin leer aunque hagan la comprobación a la vez: el segundo choca
-- contra este índice y `notify()` reintenta el UPDATE. Sin esto el agrupado
-- sería «casi siempre», que en una bandeja se nota.
create unique index if not exists notifications_open_group_uidx
  on public.notifications (organization_id, user_id, group_key)
  where read_at is null;

comment on table public.notifications is
  'Hechos puntuales con hora que una persona debería saber: un trámite que terminó, una rutina que no pudo correr, un encargo que preguntó algo, una acción que salió. NO es una cola de trabajo pendiente — eso son mcp_pending_actions, commitments, actions y errands, y duplicarlas aquí es exactamente lo que convertiría la campana en ruido.';
comment on column public.notifications.href is
  'Ruta interna a donde ocurrió la cosa. El CHECK prohíbe absolutas y protocol-relative: un aviso no puede ser nunca el sitio por donde entra un enlace externo en el que alguien confía.';
comment on column public.notifications.group_key is
  'Qué cuenta como el mismo suceso repetido. Colapsa sólo mientras el aviso sigue sin leer; después, lo mismo otra vez es noticia nueva.';
comment on column public.notifications.occurrences is
  'Cuántas veces pasó lo mismo desde que se escribió esta fila. 1 en casi todas.';

-- ===========================================================================
-- 2. El tope
-- ===========================================================================
-- Una bandeja sin tope es una tabla que crece para siempre y una pantalla que
-- nadie termina de leer. Doscientos avisos por persona son varios meses de un
-- espacio activo, y quien tenga más de doscientos sin mirar no tiene un problema
-- de retención.
--
-- Se poda en un trigger y no en la aplicación por la misma razón por la que el
-- índice único de arriba vive aquí: es una propiedad de la tabla, y una podada
-- que dependa de que el que escribe se acuerde es una podada que un día no pasa.
-- Se borra lo más viejo sin mirar si está leído: un aviso de hace tres meses que
-- nadie abrió tampoco lo va a abrir hoy, y el trabajo del que hablaba sigue
-- entero en su propia tabla.

create or replace function public.notifications_trim()
returns trigger
language plpgsql
as $$
begin
  -- El guardia barato primero: en la abrumadora mayoría de inserciones no hay
  -- nada que podar y esto es una cuenta sobre un índice parcial de la persona.
  if (
    select count(*) from public.notifications
    where organization_id = new.organization_id and user_id = new.user_id
  ) <= 200 then
    return null;
  end if;

  delete from public.notifications victim
  where victim.organization_id = new.organization_id
    and victim.user_id = new.user_id
    and victim.id not in (
      select keep.id from public.notifications keep
      where keep.organization_id = new.organization_id
        and keep.user_id = new.user_id
      order by keep.occurred_at desc, keep.created_at desc
      limit 200
    );

  return null;
end
$$;

comment on function public.notifications_trim() is
  'Deja como mucho 200 avisos por persona. Una bandeja acotada por la base y no por la costumbre del que escribe.';

drop trigger if exists notifications_trim_trg on public.notifications;
create trigger notifications_trim_trg
  after insert on public.notifications
  for each row execute function public.notifications_trim();

-- ===========================================================================
-- 3. Acceso
-- ===========================================================================
-- Deny-all + service_role, igual que 0065, 0067, 0069 y 0077. La frontera entre
-- inquilinos es createOrgScopedClient, no una policy colgada de auth.uid().

alter table public.notifications enable row level security;

revoke all on table public.notifications from public, anon, authenticated;

grant select, insert, update, delete on table public.notifications to service_role;
