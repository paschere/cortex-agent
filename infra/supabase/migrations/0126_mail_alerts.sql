-- ===========================================================================
-- AVISAR EN EL MOMENTO, Y SÓLO DE LO QUE LO MERECE
-- ===========================================================================
--
-- LO QUE HABÍA. El barrido del correo corría UNA VEZ AL DÍA, a las 6:10, y no
-- avisaba de nada salvo de haber perdido el permiso para leer el buzón. Esa
-- regla de silencio era correcta y sigue escrita en `gmail-learn.ts`: nada que
-- sea una COLA se avisa, porque una cola sigue siendo verdad mañana y tiene su
-- pantalla con su contador.
--
-- Lo que faltaba es el otro caso, el que no es una cola: algo llegó al buzón
-- que cambia el día de alguien, y enterarse ocho horas después es enterarse
-- tarde. Un cliente que escribe por un compromiso con fecha de mañana no es una
-- fila en una lista: es una interrupción justificada.
--
-- ---------------------------------------------------------------------------
-- SON DOS DECISIONES, Y LA SEGUNDA ES LA QUE DECIDE SI ESTO SIRVE
-- ---------------------------------------------------------------------------
-- CADA CUÁNTO SE MIRA es lo fácil: el cron pasa de diario a cada diez minutos
-- (`services/jobs/src/manifest.ts`). Para una persona, diez minutos y «al
-- instante» son lo mismo.
--
-- QUÉ MERECE INTERRUMPIR es lo difícil, y es donde se decide si la campana se
-- usa o se apaga a la semana. La regla vive entera en `mail/alerts.ts`, es una
-- función pura, y se puede leer sin levantar un buzón. Lo que esta migración
-- aporta son los tres frenos que ninguna función pura puede poner sola:
--
--   EL TECHO. Cinco por defecto, contados sobre `mail_alerts` en una ventana
--   MÓVIL de 24 horas y no desde la medianoche de nadie. Un techo por día
--   natural se puede agotar a las 23:50 y volver a llenarse a las 00:10 — diez
--   interrupciones en veinte minutos, cumpliendo la regla. La misma cifra y la
--   misma razón que las propuestas de respuesta: una cola que nadie puede
--   enfrentar es una cola que nadie vacía.
--
--   UNA VEZ POR HILO. El índice único. Un hilo que ya interrumpió a alguien no
--   vuelve a interrumpirle porque llegue otra respuesta dentro: la segunda vez
--   ya no es noticia, es seguimiento, y para eso está el resumen.
--
--   LAS HORAS. Nadie quiere un aviso a las 3 a.m. Se guardan una franja y la
--   zona horaria de la persona, que ya estaba en `user_preferences`.
--
-- ---------------------------------------------------------------------------
-- POR QUÉ SE ANOTA TAMBIÉN LO QUE SE MIRÓ Y NO SE AVISÓ
-- ---------------------------------------------------------------------------
-- No se anota. Y es a propósito: `mail_alerts` sólo tiene filas de avisos
-- MANDADOS. Un registro de todo lo descartado sería una tabla que crece con
-- cada correo del mundo para responder una pregunta que nadie hace. Lo que sí
-- queda escrito es el MOTIVO de cada aviso que salió — que es la pregunta que
-- sí se hace, en voz alta, la primera vez que la campana suena por algo que no
-- lo merecía.
--
-- APAGADO POR DEFECTO. La 0043 lo dice y aquí pesa el doble: esto interrumpe.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. La preferencia
-- ---------------------------------------------------------------------------
alter table public.user_preferences
  add column if not exists mail_alerts_enabled boolean not null default false,
  add column if not exists mail_alerts_max_per_day integer not null default 5,
  -- La franja en la que se puede interrumpir, en la zona horaria que ya tiene
  -- esta misma fila. Dos columnas y no un texto: una franja que hay que
  -- interpretar es una franja que se interpreta distinto en dos sitios.
  add column if not exists mail_alerts_from time not null default '07:00',
  add column if not exists mail_alerts_to time not null default '21:00';

alter table public.user_preferences
  drop constraint if exists user_preferences_mail_alerts_cap_check;
alter table public.user_preferences
  add constraint user_preferences_mail_alerts_cap_check
  check (mail_alerts_max_per_day between 0 and 20);

comment on column public.user_preferences.mail_alerts_enabled is
  'Si esta persona quiere que Cortex la interrumpa cuando llegue al buzón algo que lo merece (migración 0126). Apagado por defecto: esto no es un resumen que se lee cuando se puede, es una interrupción.';
comment on column public.user_preferences.mail_alerts_max_per_day is
  'Cuántos avisos de correo como mucho en una ventana móvil de 24 horas, contados sobre mail_alerts. Móvil y no por día natural: un techo que se reinicia a medianoche permite diez interrupciones en veinte minutos cumpliendo la regla. 0 equivale a apagarlo.';
comment on column public.user_preferences.mail_alerts_from is
  'Desde qué hora se puede interrumpir, en la zona horaria de esta fila. Fuera de la franja el correo espera al resumen de la mañana; no se pierde, sólo no suena.';

-- ---------------------------------------------------------------------------
-- 2. El libro de avisos
-- ---------------------------------------------------------------------------
create table if not exists public.mail_alerts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  provider         text not null check (provider in ('gmail', 'outlook')),
  thread_id        text not null,
  -- Por qué se interrumpió, en una palabra que se pueda agrupar: 'client'
  -- (toca a un cliente registrado), 'commitment' (hay un compromiso con fecha
  -- con esa contraparte), 'waiting' (alguien de fuera espera respuesta).
  reason           text not null check (reason in ('client', 'commitment', 'waiting')),
  -- Y por qué en una frase, tal cual se le dijo a la persona. Se guarda en vez
  -- de reconstruirse porque la pregunta que se hace después —«¿por qué me
  -- avisó de esto?»— es sobre lo que se dijo entonces, no sobre lo que la
  -- regla diría hoy.
  detail           text,
  subject          text,
  notified_at      timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

comment on table public.mail_alerts is
  'Un aviso de correo que se mandó: a quién, por qué hilo y por qué motivo. Es lo que hace que un hilo no interrumpa dos veces y lo que cuenta contra el techo diario. No guarda lo descartado — eso sería una tabla que crece con cada correo del mundo para contestar una pregunta que nadie hace.';

-- Un hilo interrumpe una vez. La segunda ya no es noticia, es seguimiento.
create unique index if not exists mail_alerts_thread_idx
  on public.mail_alerts (organization_id, user_id, provider, thread_id);

-- El techo: «cuántos van en las últimas 24 h» es la única consulta caliente.
create index if not exists mail_alerts_recent_idx
  on public.mail_alerts (organization_id, user_id, notified_at desc);

alter table public.mail_alerts enable row level security;
-- Sin políticas: sólo la llave de servicio, como el resto del esquema.

-- ---------------------------------------------------------------------------
-- 3. La clase de aviso
-- ---------------------------------------------------------------------------
-- El CHECK y `NOTIFICATION_KINDS` en apps/web/lib/notifications-shape.ts tienen
-- que decir lo mismo; `notifications/notify.test.ts` recorre las migraciones en
-- orden y compara con la última que lo define, así que esta lista es ahora la
-- vigente y tiene que estar completa.
alter table public.notifications
  drop constraint if exists notifications_kind_check;

alter table public.notifications
  add constraint notifications_kind_check
  check (kind in (
    'flow_finished',
    'flow_failed',
    'flow_needs_person',
    'routine_finished',
    'routine_failed',
    'errand_asked',
    'errand_finished',
    'action_sent',
    'action_failed',
    'report_ready',
    -- Llegó al buzón algo que no puede esperar al resumen de mañana: toca a un
    -- cliente, a un compromiso con fecha, o alguien de fuera está esperando.
    -- Es la única clase que NO habla de un desenlace de Cortex sino de un hecho
    -- del mundo, y por eso es la única que un techo diario y una franja horaria
    -- tienen que poder callar. Ver la migración 0126.
    'mail_worth_seeing'
  ));
