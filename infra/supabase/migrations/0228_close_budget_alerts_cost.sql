-- ===========================================================================
-- 0228 · CIERRE ASISTIDO, ALERTAS DE PRESUPUESTO Y COSTO DE CORTEX
-- ===========================================================================
-- Tres cosas que comparten una migración porque ninguna toca lo de las otras:
--
--   1. CIERRE DEL MES. La lista guiada (0192) gana tres revisiones nuevas
--      —libro vs. extracto por cuenta, facturas emitidas vs. programa contable
--      y movimientos inusuales—. Sus claves viven en `close_tasks.key`, que ya
--      acepta cualquier clave `[a-z][a-z0-9_]{1,40}`: no hay nada que migrar.
--      (Un mes cerrado no gana tareas nuevas: el código muestra la lista tal
--      como quedó en su foto.)
--
--   2. ALERTAS DE PRESUPUESTO. El umbral de aviso y de «se pasó» por empresa
--      (90 % / 110 % por defecto) y el registro de qué aviso ya salió, para no
--      repetirlo: uno por (presupuesto, categoría, mes, nivel).
--
--   3. COSTO DE CORTEX. `model_usage`: una fila por turno de chat o por tanda
--      de una tarea en segundo plano, con el modelo y los cuatro números que
--      deciden el precio (entrada sin caché, lectura de caché, escritura de
--      caché, salida). `turn_latencies` ya traía eso para el chat, pero
--      caduca a los 90 días y no sabe de tareas; esta tabla no caduca y es lo
--      que alimenta «$ 1.240 · 12.400 tokens» en la conversación, el costo por
--      tarea y /admin/usage. Se rellena con el historial de `turn_latencies`.
--      Además, la tasa USD→COP con la que se muestran los pesos.
--
-- Tenencia: `organization_id` en las tres tablas nuevas (`tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts). Sólo service_role. Idempotente.

-- ---------------------------------------------------------------------------
-- 1. Notificaciones: la clase `budget_alert`
-- ---------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'flow_finished','flow_failed','flow_needs_person','routine_finished','routine_failed',
  'errand_asked','errand_finished','action_sent','action_failed','report_ready','mail_worth_seeing',
  'management_attention','receivables_overdue','view_activity','table_sync','work_assigned',
  'approval_waiting','work_overdue','briefing',
  'task_finished','task_needs_you','task_failed',
  'budget_alert'
));

-- ---------------------------------------------------------------------------
-- 2. Alertas de presupuesto
-- ---------------------------------------------------------------------------
create table if not exists public.budget_alert_settings (
  organization_id text primary key references public.ba_organization(id) on delete cascade,
  enabled         boolean not null default true,
  -- Avisa desde este % del presupuesto del mes; «se pasó» desde el otro.
  warn_pct        integer not null default 90 check (warn_pct between 50 and 200),
  over_pct        integer not null default 110 check (over_pct between 80 and 300),
  updated_by      uuid references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint budget_alert_settings_order check (over_pct > warn_pct)
);

comment on table public.budget_alert_settings is
  'Umbrales de alerta del presupuesto por empresa (0228): aviso desde warn_pct % del presupuesto del mes y «se pasó» desde over_pct %. Sin fila, 90 % y 110 %. Los cambia quien administra.';

create table if not exists public.budget_alert_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  budget_id       uuid not null references public.budgets(id) on delete cascade,
  category        text not null check (char_length(category) between 1 and 80),
  month           integer not null check (month between 1 and 12),
  level           text not null check (level in ('aviso', 'excedido')),
  ratio           numeric(10,4) not null check (ratio >= 0),
  actual          numeric(18,2) not null,
  budgeted        numeric(18,2) not null,
  created_at      timestamptz not null default now(),
  constraint budget_alert_events_once unique (organization_id, budget_id, category, month, level)
);

comment on table public.budget_alert_events is
  'Qué alerta de presupuesto ya se avisó (0228): una por presupuesto, categoría, mes y nivel. El índice único decide si hay que avisar; pasar de «cerca» a «se pasó» avisa otra vez.';

create index if not exists budget_alert_events_org_idx
  on public.budget_alert_events (organization_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Costo de Cortex
-- ---------------------------------------------------------------------------
create table if not exists public.model_usage (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    text not null references public.ba_organization(id) on delete cascade,
  user_id            uuid references public.users(id) on delete set null,
  -- Se queda aunque se borre la conversación: el gasto ya ocurrió.
  conversation_id    uuid references public.conversations(id) on delete set null,
  task_id            uuid references public.background_tasks(id) on delete set null,
  message_id         uuid references public.messages(id) on delete set null,
  -- 'web', 'google-chat', 'mcp', 'task'…: de dónde vino.
  surface            text not null default 'web',
  source             text not null default 'chat' check (source in ('chat', 'task', 'errand', 'other')),
  model              text not null check (char_length(model) between 1 and 120),
  steps              integer not null default 1 check (steps >= 1),
  -- Entrada que NO vino del caché (1x), lectura (0,1x), escritura (1,25x), salida.
  input_tokens       bigint not null default 0 check (input_tokens >= 0),
  cache_read_tokens  bigint not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens bigint not null default 0 check (cache_write_tokens >= 0),
  output_tokens      bigint not null default 0 check (output_tokens >= 0),
  -- De qué fila de turn_latencies se copió (sólo el relleno histórico).
  turn_latency_id    uuid unique references public.turn_latencies(id) on delete set null,
  occurred_at        timestamptz not null default now()
);

comment on table public.model_usage is
  'Consumo del modelo (0228): una fila por turno de chat o tanda de tarea, con el modelo y la entrada sin caché, lectura y escritura de caché y la salida. Enteros, sin texto, sin caducidad. El precio se calcula al leer (apps/web/lib/model-pricing.ts) porque la tarifa depende de la fecha.';

create index if not exists model_usage_org_time_idx
  on public.model_usage (organization_id, occurred_at desc);
create index if not exists model_usage_conversation_idx
  on public.model_usage (conversation_id) where conversation_id is not null;
create index if not exists model_usage_task_idx
  on public.model_usage (task_id) where task_id is not null;
create index if not exists model_usage_user_idx
  on public.model_usage (organization_id, user_id, occurred_at desc);

-- Relleno con lo que `turn_latencies` todavía recuerda (90 días). Sólo si la
-- tabla está vacía: así volver a correr la migración no duplica lo que el
-- código ya escribe en vivo.
insert into public.model_usage (
  organization_id, user_id, conversation_id, message_id, surface, source, model, steps,
  input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, turn_latency_id, occurred_at
)
select
  t.organization_id,
  t.user_id,
  t.conversation_id,
  t.message_id,
  t.surface,
  'chat',
  t.model,
  greatest(coalesce(t.steps, 1), 1),
  case
    when jsonb_typeof(t.cache) = 'array' and jsonb_array_length(t.cache) > 0 then
      coalesce((select sum(coalesce((e->>'promptTokens')::bigint, 0)) from jsonb_array_elements(t.cache) e), 0)
    else coalesce(t.prompt_tokens, 0)
  end,
  case when jsonb_typeof(t.cache) = 'array' then
    coalesce((select sum(coalesce((e->>'read')::bigint, 0)) from jsonb_array_elements(t.cache) e), 0)
  else 0 end,
  case when jsonb_typeof(t.cache) = 'array' then
    coalesce((select sum(coalesce((e->>'written')::bigint, 0)) from jsonb_array_elements(t.cache) e), 0)
  else 0 end,
  coalesce(t.completion_tokens, 0),
  t.id,
  t.created_at
from public.turn_latencies t
where not exists (select 1 from public.model_usage)
  and (coalesce(t.prompt_tokens, 0) + coalesce(t.completion_tokens, 0)) > 0;

-- La tasa con la que se muestran los pesos (USD→COP), por empresa. Nula = la
-- que trae el código por defecto.
alter table public.ledger_settings
  add column if not exists usd_cop_rate numeric(10,2)
  check (usd_cop_rate is null or (usd_cop_rate >= 500 and usd_cop_rate <= 20000));

comment on column public.ledger_settings.usd_cop_rate is
  'Pesos por dólar con que se muestra el costo de Cortex (0228). Nula = la tasa por defecto del código.';

-- ---------------------------------------------------------------------------
-- 4. Acceso: sólo el servidor
-- ---------------------------------------------------------------------------
alter table public.budget_alert_settings enable row level security;
alter table public.budget_alert_events   enable row level security;
alter table public.model_usage           enable row level security;

revoke all on table public.budget_alert_settings from public, anon, authenticated;
revoke all on table public.budget_alert_events   from public, anon, authenticated;
revoke all on table public.model_usage           from public, anon, authenticated;

grant select, insert, update, delete on table public.budget_alert_settings to service_role;
grant select, insert, update, delete on table public.budget_alert_events   to service_role;
grant select, insert, update, delete on table public.model_usage           to service_role;
