-- ===========================================================================
-- APLICACIONES, FASE 3: AUTOMATIZACIONES Y NOTIFICACIONES PUSH
-- ===========================================================================
-- Una app registra, aprueba y mira tableros; la fase 3 hace que SOLA avise y
-- mueva cosas: «si entra un duplicado, avisa al supervisor», «si le rechazan,
-- avisa al operario», «cuando se apruebe, pasa a Despachada», «resumen diario
-- a gerencia». Ver docs/plans/aplicaciones.md y docs/features/apps.md.
--
-- DECIDIDO (2026-10-06): los avisos van SÓLO por correo y notificaciones push
-- (Web Push). No hay WhatsApp saliente.
--
--   · custom_app_automations      — la regla: Cuando (trigger) / Si
--                                   (conditions) / Entonces (actions), todo en
--                                   JSON validado en código
--                                   (packages/agent-tools/src/apps/automations/spec.ts):
--                                   cambiar una regla no es una migración.
--                                   `tracker_id` y `trigger_kind` son copias
--                                   del JSON para que «¿hay reglas activas
--                                   que miren esta tabla?» sea una consulta
--                                   barata con índice en cada escritura.
--   · custom_app_automation_runs  — una fila por (regla × suceso). Hace tres
--                                   cosas a la vez: IDEMPOTENCIA (la clave
--                                   `idempotency_key` es ÚNICA: un reintento o
--                                   dos escritores del mismo cambio dejan UNA
--                                   corrida), COLA DURABLE (el suceso se guarda
--                                   en `event` y `status = 'queued'`; si encolar
--                                   el trabajo falla, el barrido de cada minuto
--                                   lo recoge) e HISTORIAL (qué pasó, errores,
--                                   resultado de cada acción).
--   · push_subscriptions          — suscripciones Web Push (VAPID) de un usuario
--                                   externo de una app o de un miembro de
--                                   Cortex. Único por `endpoint`: si otra
--                                   persona entra en el mismo teléfono, la
--                                   suscripción cambia de dueño en vez de
--                                   duplicarse (un teléfono compartido no
--                                   recibe los avisos de quien salió).
--
-- Tenencia: `organization_id` en cada fila y `tenant()` en tenancy/tables.ts.
-- RLS como 0208/0209: sólo service_role, con el cliente acotado
-- (`getOrgScopedClient`).

create table if not exists public.custom_app_automations (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     text not null,
  app_id              uuid not null references public.custom_apps (id) on delete cascade,
  name                text not null,
  enabled             boolean not null default true,
  -- { type: 'row_created' | 'row_updated' | 'row_flagged_duplicate' |
  --   'form_submitted' | 'approval_decided' | 'schedule' | 'button', … }
  trigger             jsonb not null check (jsonb_typeof(trigger) = 'object'),
  -- [ filtro de vista… , { type: 'changed', field, from?, to? } ]
  conditions          jsonb not null default '[]'::jsonb check (jsonb_typeof(conditions) = 'array'),
  actions             jsonb not null check (jsonb_typeof(actions) = 'array'),
  -- Copias de trigger.tracker y trigger.type, para la consulta barata.
  tracker_id          uuid,
  trigger_kind        text not null,
  -- Última franja de un disparador `schedule` ya reclamada (una corrida por franja).
  schedule_last_slot  timestamptz,
  last_run_at         timestamptz,
  last_status         text,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint custom_app_automations_name_len check (char_length(btrim(name)) between 1 and 120),
  constraint custom_app_automations_kind check (
    trigger_kind in ('row_created', 'row_updated', 'row_flagged_duplicate',
                     'form_submitted', 'approval_decided', 'schedule', 'button')
  )
);

-- «¿Hay reglas activas que miren esta tabla?»: una escritura de fila pregunta
-- esto cada vez, así que va por índice parcial y sólo mira las encendidas.
create index if not exists custom_app_automations_watch_idx
  on public.custom_app_automations (organization_id, tracker_id)
  where enabled and tracker_id is not null;
create index if not exists custom_app_automations_app_idx
  on public.custom_app_automations (organization_id, app_id, created_at);
create index if not exists custom_app_automations_schedule_idx
  on public.custom_app_automations (trigger_kind)
  where enabled and trigger_kind = 'schedule';

create table if not exists public.custom_app_automation_runs (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  app_id            uuid not null references public.custom_apps (id) on delete cascade,
  automation_id     uuid not null references public.custom_app_automations (id) on delete cascade,
  -- Qué lo disparó, legible: «row:<id>», «slot:2026-10-07T12:00», «button:<id>».
  trigger_ref       text not null,
  status            text not null default 'queued'
                    check (status in ('queued', 'running', 'succeeded', 'failed', 'skipped')),
  error             text,
  -- Intentos hechos; los errores transitorios se reintentan con espera.
  attempts          integer not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz,
  -- El suceso completo (fila antes/después, quién, profundidad) para ejecutar
  -- y para reintentar sin volver a leer nada.
  event             jsonb not null default '{}'::jsonb,
  -- Cadena de automatizaciones que llevaron hasta aquí (anti-bucles).
  depth             integer not null default 0 check (depth between 0 and 8),
  -- Resultado de cada acción: [{ index, type, ok, detail }].
  result            jsonb not null default '[]'::jsonb,
  -- Cuántas veces llamó a Cortex (tope diario por app).
  ask_cortex_calls  integer not null default 0 check (ask_cortex_calls >= 0),
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz not null default now(),
  -- automatización + fila + versión del suceso. ÚNICA: es la idempotencia.
  idempotency_key   text not null,

  constraint custom_app_automation_runs_key_len check (char_length(idempotency_key) <= 300)
);

create unique index if not exists custom_app_automation_runs_key_idx
  on public.custom_app_automation_runs (idempotency_key);
create index if not exists custom_app_automation_runs_automation_idx
  on public.custom_app_automation_runs (organization_id, automation_id, created_at desc);
-- El barrido de cada minuto: lo que está en cola o espera un reintento.
create index if not exists custom_app_automation_runs_due_idx
  on public.custom_app_automation_runs (next_attempt_at)
  where status in ('queued', 'running');
-- El tope diario por app cuenta corridas de hoy.
create index if not exists custom_app_automation_runs_app_day_idx
  on public.custom_app_automation_runs (organization_id, app_id, created_at);

create table if not exists public.push_subscriptions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  -- La app desde la que se suscribió (los avisos de una app sólo van a quien
  -- se suscribió en ella); null = suscripción de un miembro en la app principal.
  app_id            uuid references public.custom_apps (id) on delete cascade,
  subject_kind      text not null check (subject_kind in ('member', 'app_user')),
  -- Miembro de Cortex (uuid de ba_user) o usuario externo de la app.
  member_id         uuid,
  app_user_id       uuid references public.custom_app_users (id) on delete cascade,
  endpoint          text not null,
  p256dh            text not null,
  auth              text not null,
  user_agent        text not null default '',
  created_at        timestamptz not null default now(),
  last_used_at      timestamptz,

  constraint push_subscriptions_subject check (
    (subject_kind = 'member' and member_id is not null and app_user_id is null)
    or (subject_kind = 'app_user' and app_user_id is not null and app_id is not null and member_id is null)
  ),
  constraint push_subscriptions_endpoint_len check (char_length(endpoint) between 20 and 2000),
  constraint push_subscriptions_ua_len check (char_length(user_agent) <= 300)
);

create unique index if not exists push_subscriptions_endpoint_idx
  on public.push_subscriptions (endpoint);
create index if not exists push_subscriptions_app_user_idx
  on public.push_subscriptions (organization_id, app_user_id)
  where app_user_id is not null;
create index if not exists push_subscriptions_member_idx
  on public.push_subscriptions (organization_id, member_id)
  where member_id is not null;

comment on table public.custom_app_automations is
  'Regla de una app: Cuando (trigger) / Si (conditions) / Entonces (actions). JSON validado en código; tracker_id y trigger_kind son copias para la consulta barata de cada escritura.';
comment on table public.custom_app_automation_runs is
  'Una corrida por (regla × suceso): cola durable, idempotencia (idempotency_key única) e historial con errores y resultado por acción.';
comment on table public.push_subscriptions is
  'Suscripciones Web Push (VAPID) de un usuario externo de una app o de un miembro de Cortex. Único por endpoint: un teléfono compartido cambia de dueño, no se duplica.';

alter table public.custom_app_automations enable row level security;
alter table public.custom_app_automation_runs enable row level security;
alter table public.push_subscriptions enable row level security;

revoke all on table public.custom_app_automations from public, anon, authenticated;
revoke all on table public.custom_app_automation_runs from public, anon, authenticated;
revoke all on table public.push_subscriptions from public, anon, authenticated;

grant select, insert, update, delete on table public.custom_app_automations to service_role;
grant select, insert, update, delete on table public.custom_app_automation_runs to service_role;
grant select, insert, update, delete on table public.push_subscriptions to service_role;
