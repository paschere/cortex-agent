-- El piloto automático: cada mañana Cortex arma el plan del día de una empresa,
-- HACE lo rutinario que tiene permitido y le deja al dueño una lista corta con
-- lo que de verdad necesita su decisión.
--
-- ---------------------------------------------------------------------------
-- LO QUE ESTA MIGRACIÓN NO HACE
-- ---------------------------------------------------------------------------
-- No le da a Cortex ningún permiso nuevo. Todo lo que el piloto ejecuta pasa
-- por `runTool` con `surface='schedule'`: la misma puerta de seguridad, los
-- mismos mandatos (0099) y la misma capa de acciones seguras (0168) que una
-- rutina. Un correo a un cliente sigue sin poder salir sin nadie mirando, y
-- nada que mueva plata se hace solo. Las tablas de aquí sólo guardan QUÉ
-- decidió la empresa (configuración) y QUÉ pasó (corridas y sus cosas).
--
-- Código: packages/agent-tools/src/autopilot (reglas puras y tienda),
-- apps/web/inngest/functions/autopilot.ts (el trabajo diario) y /piloto.

-- ===========================================================================
-- 1. La configuración por empresa
-- ===========================================================================

create table if not exists public.autopilot_settings (
  organization_id        text primary key,
  -- APAGADO hasta que alguien con autoridad sobre la empresa lo encienda.
  enabled                boolean     not null default false,
  -- Hora local (Bogotá) a la que corre, y en qué días ISO (1 = lunes).
  run_hour               smallint    not null default 7 check (run_hour between 0 and 23),
  run_days               smallint[]  not null default array[1,2,3,4,5]::smallint[]
                           check (cardinality(run_days) between 1 and 7 and run_days <@ array[1,2,3,4,5,6,7]::smallint[]),
  timezone               text        not null default 'America/Bogota'
                           check (timezone = 'America/Bogota'),
  skip_holidays          boolean     not null default true,
  -- Días sin piloto: cierres, vacaciones colectivas.
  quiet_days             date[]      not null default '{}' check (cardinality(quiet_days) <= 60),
  -- Nivel por área: { "cobro": "proponer", "conciliacion": "hacer", … }.
  -- La forma la valida autopilot/settings.ts; lo desconocido cae al valor por
  -- defecto, y `pagos` nunca pasa de «proponer».
  area_levels            jsonb       not null default '{}'::jsonb
                           check (jsonb_typeof(area_levels) = 'object'),
  -- Topes del día.
  max_external_messages  integer     not null default 5 check (max_external_messages between 0 and 50),
  max_amount_referenced  numeric(18,2) not null default 20000000 check (max_amount_referenced >= 0),
  currency               char(3)     not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  max_actions_per_run    integer     not null default 25 check (max_actions_per_run between 1 and 100),
  -- En nombre de quién actúa: quien lo encendió. Si deja de administrar la
  -- empresa, el piloto no corre hasta que otro administrador lo encienda.
  actor_user_id          uuid        references public.users (id) on delete set null,
  notify_email           boolean     not null default true,
  enabled_at             timestamptz,
  updated_by             uuid        references public.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint autopilot_settings_actor_when_on check (not enabled or actor_user_id is not null)
);

comment on table public.autopilot_settings is
  'Piloto automático por empresa: si está encendido, a qué hora y qué días corre, el nivel de cada área (avisar | proponer | hacer), los topes del día y en nombre de quién actúa. Nace apagado. Lo cambia un administrador o el dueño (autopilot.configure o /piloto).';

-- ===========================================================================
-- 2. Las corridas: una por empresa y por día
-- ===========================================================================

create table if not exists public.autopilot_runs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text        not null,
  run_on           date        not null,
  status           text        not null default 'running'
                     check (status in ('running', 'done', 'stopped', 'failed')),
  actor_user_id    uuid        references public.users (id) on delete set null,
  done_count       integer     not null default 0 check (done_count >= 0),
  asked_count      integer     not null default 0 check (asked_count >= 0),
  told_count       integer     not null default 0 check (told_count >= 0),
  failed_count     integer     not null default 0 check (failed_count >= 0),
  skipped_count    integer     not null default 0 check (skipped_count >= 0),
  -- «Hoy hice 6 cosas; necesito tu decisión en 3.» Escrita por reglas.
  summary          text        check (summary is null or length(summary) <= 600),
  source_errors    jsonb       not null default '[]'::jsonb check (jsonb_typeof(source_errors) = 'array'),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  notified_at      timestamptz,
  -- UNA corrida por día: el índice decide, el trabajo no tiene que acordarse.
  constraint autopilot_runs_once_a_day unique (organization_id, run_on)
);

create index if not exists autopilot_runs_org_day_idx
  on public.autopilot_runs (organization_id, run_on desc);

comment on table public.autopilot_runs is
  'Cada corrida diaria del piloto automático: cuántas cosas hizo, preguntó, contó, fallaron u omitió, y el mensaje que recibió el dueño. Única por (empresa, día): un reintento retoma la misma corrida.';

-- ===========================================================================
-- 3. Las cosas de cada corrida
-- ===========================================================================

create table if not exists public.autopilot_items (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      text        not null,
  run_id               uuid        not null references public.autopilot_runs (id) on delete cascade,
  -- La identidad de la COSA (la factura, el pago, el compromiso), no del día.
  dedupe_key           text        not null check (length(btrim(dedupe_key)) between 3 and 300),
  area                 text        not null check (area in (
                         'cobro', 'pagos', 'conciliacion', 'equipo', 'procesos',
                         'vencimientos', 'gerencia', 'finanzas')),
  title                text        not null check (length(btrim(title)) between 1 and 300),
  -- La evidencia, con cifras. Escrita por reglas, nunca por un modelo.
  why                  text        not null check (length(btrim(why)) between 1 and 1200),
  risk                 text        not null check (risk in ('low', 'medium', 'high')),
  effect               text        check (effect in ('internal_write', 'internal_notice', 'external_message', 'money')),
  decision             text        not null check (decision in ('do', 'ask', 'tell')),
  decision_reason      text        not null check (length(decision_reason) <= 600),
  -- Por qué se pudo hacer solo: un mandato o la regla de lo rutinario.
  authority            text        check (authority in ('mandate', 'routine')),
  mandate_id           uuid        references public.mandates (id) on delete set null,
  tool_id              text        check (tool_id is null or length(tool_id) between 3 and 120),
  tool_input           jsonb,
  amount               numeric(18,2),
  currency             char(3),
  counterparty         text        check (counterparty is null or length(counterparty) <= 200),
  href                 text        check (href is null or (href like '/%' and length(href) <= 400)),
  undo                 jsonb,
  status               text        not null default 'planned' check (status in (
                         'planned', 'done', 'failed', 'skipped', 'asked', 'told', 'dismissed')),
  result_summary       text        check (result_summary is null or length(result_summary) <= 1000),
  -- Lo que dejó la verificación de la capa de acciones seguras (0168).
  verification         text        check (verification in ('verified', 'not_verified', 'unverifiable')),
  verification_detail  text        check (verification_detail is null or length(verification_detail) <= 500),
  error                text        check (error is null or length(error) <= 1000),
  -- La propuesta en la cola de aprobaciones de siempre, para lo que sale de la
  -- empresa (un correo de cobro): se aprueba allí, con su huella.
  action_id            uuid        references public.actions (id) on delete set null,
  decided_by           uuid        references public.users (id) on delete set null,
  decided_at           timestamptz,
  executed_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint autopilot_items_once_per_run unique (run_id, dedupe_key),
  constraint autopilot_items_money_pair check ((amount is null) or (currency is not null)),
  constraint autopilot_items_action_needs_tool check (decision = 'tell' or tool_id is not null),
  constraint autopilot_items_decided_complete check ((decided_at is null) = (decided_by is null))
);

create index if not exists autopilot_items_run_idx
  on public.autopilot_items (run_id, created_at);
-- «¿Esto ya se decidió otro día?»: la historia por cosa.
create index if not exists autopilot_items_org_key_idx
  on public.autopilot_items (organization_id, dedupe_key, created_at desc);
-- Lo que espera decisión.
create index if not exists autopilot_items_org_asked_idx
  on public.autopilot_items (organization_id, created_at desc)
  where status = 'asked';

comment on table public.autopilot_items is
  'Cada cosa de una corrida del piloto: qué vio (why), qué propuso (tool_id + tool_input), qué decidió (do | ask | tell) y por qué, y qué pasó (status, resumen, verificación). Lo que espera decisión se aprueba desde /piloto; un correo a un cliente, desde la cola de aprobaciones (action_id).';

-- ===========================================================================
-- 4. Acceso: sólo el servicio. La app filtra por empresa (getOrgScopedClient).
-- ===========================================================================

alter table public.autopilot_settings enable row level security;
alter table public.autopilot_runs     enable row level security;
alter table public.autopilot_items    enable row level security;

revoke all on table public.autopilot_settings from public, anon, authenticated;
revoke all on table public.autopilot_runs     from public, anon, authenticated;
revoke all on table public.autopilot_items    from public, anon, authenticated;

grant select, insert, update, delete on table public.autopilot_settings to service_role;
grant select, insert, update, delete on table public.autopilot_runs     to service_role;
grant select, insert, update, delete on table public.autopilot_items    to service_role;

-- La campana: el resumen al dueño usa la clase `management_attention` que ya
-- existe (0174), con su tono. A propósito no se redefine aquí
-- `notifications_kind_check`: otra migración del mismo despliegue (0177) la
-- reescribe, y dos copias de esa lista se pisan.
