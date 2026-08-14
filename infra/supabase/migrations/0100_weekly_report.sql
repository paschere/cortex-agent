-- El parte semanal: el informe que llega solo, sin que nadie lo pida.
--
-- ---------------------------------------------------------------------------
-- LO QUE FALTABA
-- ---------------------------------------------------------------------------
-- Cortex ya vigila (0069), ya propone (0077), ya lee documentos (0076), ya sabe
-- de cartera (0098) y ya sabe dibujar un informe con la fuente de cada cifra
-- (0079). Lo único que no hacía era RENDIR CUENTAS: los tres informes que
-- existen sólo se generan cuando un humano los pide, y el digest de correo es
-- una preferencia personal apagada por defecto que ni siquiera devuelve texto.
--
-- El producto se vende como un gerente para una empresa. Un gerente que nunca
-- reporta no lo es. Esto es el cuarto informe y el primero que se manda solo.
--
-- ---------------------------------------------------------------------------
-- LA ÚNICA FUNCIÓN QUE ESCRIBE LO NUEVO
-- ---------------------------------------------------------------------------
--   reports.period_start          claimWeeklyReport()
--                                 packages/agent-tools/src/reports/store.ts
--   notifications.kind/source     notify()
--                                 apps/web/lib/notifications/notify.ts
--   user_preferences.weekly_...   la ruta PATCH /api/settings/preferences
--
-- `saveReport()` sigue siendo el escritor de los informes que pide una persona,
-- y NUNCA escribe `period_start`: ésa es exactamente la diferencia entre «este
-- informe lo pedí yo» y «éste es EL parte de esa semana». Ver la sección 1.
--
-- ---------------------------------------------------------------------------
-- POR QUÉ EL ÍNDICE ÚNICO NO ES OPCIONAL
-- ---------------------------------------------------------------------------
-- Inngest reintenta pasos, los despliegues reinician funciones a medias y un
-- cron que dispara dos veces es un lunes normal. Un parte que llega dos veces
-- no es un fallo cosmético: es la lección de que a Cortex se le puede ignorar.
-- La primera vez que alguien recibe el mismo informe duplicado deja de leer los
-- dos, y a partir de ahí el producto entero es ruido.
--
-- Así que «¿ya mandamos el de esta semana?» NO lo decide el código. Lo decide
-- un índice único parcial, igual que `commitment_notices_once_idx` (0069) y
-- `actions_open_per_origin_idx` (0077): el proceso RECLAMA la semana con una
-- inserción y sólo si gana la inserción manda el correo. Correrlo diez veces
-- seguidas produce una fila y un correo.
--
-- Reclamar primero y enviar después, y no al revés, porque los dos fallos no
-- cuestan lo mismo: reclamar y no poder enviar deja el parte guardado en
-- /reports y un aviso en la campana diciendo que el correo no salió; enviar y
-- no poder reclamar manda el mismo parte cada vez que el cron reintente.
--
-- Idempotente de arriba abajo.

-- ===========================================================================
-- 1. La semana que un informe reclama
-- ===========================================================================
-- NULLABLE, y el índice es PARCIAL sobre eso. Las dos mitades son la misma
-- decisión:
--
--   period_start IS NULL   un informe que pidió una persona. Puede haber
--                          quince del mismo tipo el mismo día y todos son
--                          legítimos: cada uno es una pregunta que alguien
--                          hizo.
--   period_start NOT NULL  EL parte de esa semana para ese espacio de trabajo.
--                          Hay uno, y la base lo garantiza.
--
-- Un `not null` con default aquí habría obligado a inventarle una semana a cada
-- informe manual, y entonces dos personas generando el informe de vencimientos
-- el mismo martes chocarían contra un índice que no tiene nada que ver con
-- ellas.
--
-- `date` y no `timestamptz`: la semana que se reporta es un tramo del
-- calendario colombiano (lunes a domingo), no un instante. Guardarla como
-- instante reintroduce el error de zona horaria que la 0069 evita con
-- `due_on date` — un parte reclamado a las 19:00 de un domingo en Bogotá
-- pertenecería a la semana siguiente en UTC, silenciosamente.

alter table public.reports
  add column if not exists period_start date;

comment on column public.reports.period_start is
  'El lunes de la semana que este informe reporta, y sólo para los informes que se mandan solos. Null en todo informe que pidió una persona. Cuando NO es null, el índice único parcial de abajo garantiza que hay exactamente uno por espacio de trabajo, tipo y semana: es el mecanismo entero de «esto no se manda dos veces».';

-- El trinquete. Parcial para que los miles de informes pedidos a mano no cuesten
-- nada y no puedan colisionar entre ellos.
create unique index if not exists reports_period_once_idx
  on public.reports (organization_id, kind, period_start)
  where period_start is not null;

-- ===========================================================================
-- 2. Un quinto valor en el CHECK de kind
-- ===========================================================================
-- La 0079 escribió «Three, and only three. A fourth is a code change plus a
-- migration, which is the correct amount of friction», y la 0088 pagó esa
-- fricción por 'chart'. Ésta la paga por 'weekly', y merece decirse en qué
-- lista entra y en cuál no:
--
--   GENERATED_REPORT_KINDS   los tres que el constructor computa a partir de un
--                            tipo y unos parámetros. Son lo que ofrece el
--                            selector de /reports y lo que reports.generate deja
--                            pedir al modelo.
--   REPORT_KINDS             todo lo que una fila guardada puede ser.
--
-- 'weekly' entra SÓLO en la segunda, igual que 'chart' y por una razón parecida:
-- no es una receta que alguien elige, es lo que pasó en una semana concreta. Un
-- botón «generar el parte» en el selector produciría un informe que compite con
-- el que el lunes reclamó esa misma semana, y el segundo perdería contra el
-- índice de arriba o —peor— la ganaría y dejaría el correo sin mandar.
--
-- Se reescribe entero en vez de ensancharlo porque un check en línea no tiene
-- nombre que alterar; el drop es `if exists` para que una segunda pasada no
-- encuentre nada que hacer.

alter table public.reports
  drop constraint if exists reports_kind_check;

alter table public.reports
  add constraint reports_kind_check
  check (kind in ('expiries', 'fleet', 'client_activity', 'chart', 'weekly'));

comment on column public.reports.kind is
  'Qué informe es. Los tres primeros son recetas que el constructor computa a partir de parámetros; ''chart'' es un gráfico rescatado de una conversación; ''weekly'' es el parte que sale solo cada lunes y que reclama su semana en period_start. Ver la 0088 sección 1 y la 0100 sección 2.';

-- ===========================================================================
-- 3. El aviso, que sólo existe cuando el correo no llegó
-- ===========================================================================
-- La 0096 dejó escrita la regla y hay que respetarla aquí: UN AVISO ES EL CANAL
-- DE ÚLTIMA INSTANCIA. Si el parte ya viajó por correo, la campana no lo repite
-- — sería exactamente «la campana es donde vuelvo a leer lo que ya leí», que es
-- como muere un centro de avisos.
--
-- Así que 'report_ready' se escribe en un solo caso: el parte está guardado y el
-- correo NO salió. Ahí el aviso no duplica nada, es el único rastro de que la
-- semana fue reportada, y por eso su tono por defecto es 'warning' y no 'good':
-- lo que cuenta no es que el informe exista, es que no llegó a su destinatario.
--
-- El CHECK y `NOTIFICATION_KINDS` en apps/web/lib/notifications-shape.ts tienen
-- que decir lo mismo, y `notifications/notify.test.ts` compara las dos listas
-- leyendo este SQL — así que añadir una clase en TypeScript sin migrarla falla
-- en CI. Ese test lee la 0096; abajo se reescribe el CHECK de forma que la
-- lista completa siga estando en un solo sitio legible.

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
    -- El parte semanal quedó guardado pero el correo no salió. Ver arriba.
    'report_ready'
  ));

alter table public.notifications
  drop constraint if exists notifications_source_kind_check;

alter table public.notifications
  add constraint notifications_source_kind_check
  check (source_kind in ('flow_run', 'routine_run', 'errand', 'action', 'report'));

comment on column public.notifications.kind is
  'De qué clase es el aviso. Todas salen de un DESENLACE, nunca de una cola: lo que sigue siendo verdad mañana vive en una pantalla con su contador, no en la campana. ''report_ready'' es la única que habla de algo que salió bien, y sólo se escribe cuando el correo que debía llevarlo falló.';

-- ===========================================================================
-- 4. La preferencia, y por qué ésta SÍ viene encendida
-- ===========================================================================
-- La 0043 dice, con razón, «nothing here defaults to on», y el digest diario
-- sigue apagado por defecto. La diferencia no es de gusto:
--
--   EL DIGEST      hace que Cortex LEA EL BUZÓN DE UNA PERSONA. Es una
--                  capacidad sobre correo ajeno y tiene que concederla su
--                  dueño, deliberadamente, desde la pantalla.
--   EL PARTE       es la empresa rindiéndole cuentas a quien responde por ella,
--                  con datos que ya están en la base y que ese destinatario ya
--                  puede abrir en la aplicación. No lee nada de nadie.
--
-- Encendido por defecto y apagable en un clic. Apagado por defecto significaría
-- que el producto no reporta nunca a nadie hasta que alguien descubra una
-- casilla, que es la forma más cara posible de no tener la funcionalidad.
--
-- Y llega SÓLO a `users.role = 'org_admin'`: el producto ya decidió que el
-- admin es quien responde cuando nadie más responde (ver `orgAdmins()` en
-- inngest/functions/commitments-watch.ts). Inventar un organigrama para esto
-- sería inventar una tabla que nadie mantiene.

alter table public.user_preferences
  add column if not exists weekly_report_enabled boolean not null default true;

comment on column public.user_preferences.weekly_report_enabled is
  'Si esta persona recibe el parte semanal por correo. Encendida por defecto, al contrario que el digest de la 0043: aquél hace que Cortex lea un buzón ajeno y tiene que concederse; éste es la empresa rindiendo cuentas con datos que el destinatario ya puede abrir. Sólo se consulta para quienes son org_admin.';
