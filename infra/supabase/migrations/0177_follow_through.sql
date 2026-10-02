-- ===========================================================================
-- PERSEGUIR LO PENDIENTE Y APRENDER DE LO QUE SE RECOMIENDA
-- ===========================================================================
-- Dos mitades que se tocan:
--
--   A. PERSIGUE PENDIENTES. Lo que se queda parado en «te espera tu
--      aprobación» o vencido en el registro de trabajo deja de depender de que
--      alguien abra la pantalla: a quien tiene que decidir le llega UN
--      recordatorio (no uno por cosa), a los cinco días se le pregunta
--      «¿lo descarto?» en vez de dejar que expire callado, y cada responsable
--      recibe UN resumen diario de lo suyo vencido («Tienes 3 vencidos: …»).
--      Todo eso se reclama primero en `follow_through_notices`, con índice
--      único, y sólo quien gana la reclamación avisa: correr el barrido diez
--      veces avisa una.
--
--   B. APRENDER DE LO QUE RECOMIENDA. Cada recomendación que Cortex hace (la
--      revisión semanal, las señales del equipo, las alertas de la caja, el
--      pulso, Gerencia) queda en `recommendations` con su sujeto (un cliente,
--      una persona, un ítem), la acción sugerida y el efecto que se espera.
--      Después se mira si se siguió (con evidencia: el cobro que salió, la
--      reasignación que se hizo) y qué pasó (el pago que entró, los vencidos
--      que bajaron), sin afirmar nunca más causalidad que «después de…». La
--      tasa de acierto por tipo, por empresa, ordena las recomendaciones
--      siguientes — acotada, y sin esconder jamás una alerta crítica.
--
-- Cero llamadas al modelo en todo esto: reglas, cifras y plantillas.
-- Tenencia: `organization_id` en las dos tablas, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. Sólo service_role.

-- ---------------------------------------------------------------------------
-- 1. El libro de recordatorios (A)
-- ---------------------------------------------------------------------------
create table if not exists public.follow_through_notices (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  text        not null references public.ba_organization(id) on delete cascade,
  -- A quién se le avisó. Siempre alguien del directorio de la empresa.
  user_id          uuid        not null references public.users(id) on delete cascade,
  --   approval_reminder  «tienes N borradores esperando tu visto bueno»
  --   approval_discard   «llevan N días: ¿los descarto?»
  --   work_digest        «tienes N vencidos: …», una vez al día
  kind             text        not null check (kind in ('approval_reminder', 'approval_discard', 'work_digest')),
  -- La identidad de lo que se avisó: el día para el resumen, el id de la
  -- propuesta para el «¿lo descarto?». Con kind y user es única.
  ref              text        not null check (length(btrim(ref)) between 1 and 200),
  -- El día de Bogotá en que salió.
  sent_on          date        not null,
  -- Cuántas cosas nombraba el aviso, para auditar sin releer el texto.
  item_count       integer     not null default 0 check (item_count >= 0),
  delivered        boolean     not null default false,
  created_at       timestamptz not null default now(),
  constraint follow_through_notices_once unique (organization_id, user_id, kind, ref)
);

create index if not exists follow_through_notices_org_day_idx
  on public.follow_through_notices (organization_id, sent_on desc);

comment on table public.follow_through_notices is
  'Recordatorios de lo pendiente ya reclamados: un resumen diario de vencidos por persona, un recordatorio de aprobaciones paradas y el «¿lo descarto?» de las viejas. Se reclama (índice único) antes de avisar; quien pierde no avisa. Ver packages/agent-tools/src/follow-through.';

-- Interruptor por empresa del resumen diario de vencidos. Encendido: es lo
-- mismo que ya hace el seguimiento de Gerencia (encendido si falta), en UN
-- solo aviso al día por persona, en días hábiles y dentro de su franja.
alter table public.work_settings
  add column if not exists overdue_digest boolean not null default true;

comment on column public.work_settings.overdue_digest is
  'Si cada responsable recibe cada mañana hábil UN resumen de lo suyo vencido en el registro de trabajo («Tienes 3 vencidos: …»). Lo apaga un administrador en Equipo → Qué se mide.';

-- ---------------------------------------------------------------------------
-- 2. Lo que Cortex recomendó y qué pasó (B)
-- ---------------------------------------------------------------------------
create table if not exists public.recommendations (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  -- De dónde salió.
  source            text        not null check (source in ('weekly_review', 'work_signals', 'forecast', 'pulse', 'management')),
  -- Qué tipo de consejo es. La tasa de acierto se lleva por este valor.
  kind              text        not null check (kind ~ '^[a-z][a-z_]{1,39}$'),
  -- Sobre qué: un cliente, una persona, un ítem, una rutina o la empresa.
  subject_kind      text        not null check (subject_kind in ('counterparty', 'person', 'item', 'routine', 'company')),
  -- La llave normalizada del sujeto (nombre sin tildes, id de persona…).
  subject_key       text        not null check (length(subject_key) between 1 and 200),
  subject_label     text        check (subject_label is null or length(subject_label) <= 200),
  -- La frase tal como se dijo, y la versión corta para «Recomendé …».
  text              text        not null check (length(btrim(text)) between 1 and 600),
  headline          text        not null check (length(btrim(headline)) between 1 and 200),
  -- { toolId, input } cuando hay una herramienta que lo haría; nulo si no.
  suggested_action  jsonb       check (suggested_action is null or jsonb_typeof(suggested_action) = 'object'),
  expected_effect   text        not null check (expected_effect in ('collect', 'reduce_overdue', 'reduce_load', 'raise_cash', 'decide', 'fix', 'setup')),
  severity          text        not null default 'info' check (severity in ('info', 'warn', 'critical')),
  -- Las cifras del momento: lo que debía, cuántos abiertos tenía… Es la línea
  -- contra la que se mide lo que pasó después.
  baseline          jsonb       not null default '{}'::jsonb check (jsonb_typeof(baseline) = 'object'),
  -- Para quién se escribió (quien leyó la revisión). Nulo: para la empresa.
  created_for       uuid        references public.users(id) on delete set null,
  -- Una por tipo, sujeto y semana: la misma recomendación repetida en la
  -- revisión del lunes y en el pulso del martes es una sola.
  dedupe_key        text        not null check (length(dedupe_key) between 1 and 300),
  -- ¿Se siguió? open = todavía no se mira; in_progress = hay algo a medias;
  -- followed / not_followed con evidencia; unmeasurable = no hay cómo verlo.
  status            text        not null default 'open' check (status in ('open', 'in_progress', 'followed', 'not_followed', 'unmeasurable')),
  followed_at       timestamptz,
  follow_evidence   jsonb       not null default '{}'::jsonb check (jsonb_typeof(follow_evidence) = 'object'),
  -- ¿Qué pasó después? good / none / worse, o pending mientras la ventana siga
  -- abierta. Nunca dice «por esto»: dice «después de esto».
  outcome           text        check (outcome is null or outcome in ('pending', 'good', 'none', 'worse')),
  outcome_evidence  jsonb       not null default '{}'::jsonb check (jsonb_typeof(outcome_evidence) = 'object'),
  evaluated_at      timestamptz,
  created_at        timestamptz not null default now(),
  constraint recommendations_once unique (organization_id, dedupe_key)
);

create index if not exists recommendations_org_created_idx
  on public.recommendations (organization_id, created_at desc);
create index if not exists recommendations_org_kind_idx
  on public.recommendations (organization_id, kind, status);

comment on table public.recommendations is
  'Cada recomendación de Cortex (revisión semanal, señales del equipo, alertas de caja, pulso, Gerencia) con su sujeto, acción sugerida y efecto esperado; si se siguió (con evidencia) y qué pasó después (medido, conservador, sin afirmar causalidad). La tasa de acierto por tipo ordena las siguientes. Ver packages/agent-tools/src/follow-through/recommendations.';

alter table public.follow_through_notices enable row level security;
alter table public.recommendations        enable row level security;

revoke all on table public.follow_through_notices from public, anon, authenticated;
revoke all on table public.recommendations        from public, anon, authenticated;

grant select, insert, update, delete on table public.follow_through_notices to service_role;
grant select, insert, update, delete on table public.recommendations        to service_role;

-- ---------------------------------------------------------------------------
-- 3. La campana: dos clases nuevas
-- ---------------------------------------------------------------------------
--   approval_waiting  Lo redactado lleva tiempo esperando tu visto bueno, o ya
--                     tanto que conviene descartarlo. UNO por persona y día.
--   work_overdue      Tu resumen diario de vencidos del registro de trabajo.
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'flow_finished','flow_failed','flow_needs_person','routine_finished','routine_failed',
  'errand_asked','errand_finished','action_sent','action_failed','report_ready','mail_worth_seeing',
  'management_attention','receivables_overdue','view_activity','table_sync','work_assigned',
  'approval_waiting','work_overdue'
));
