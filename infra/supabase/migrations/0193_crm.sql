-- ===========================================================================
-- EMBUDO COMERCIAL, RIESGO DE PERDER CLIENTES Y ENCUESTAS DE SATISFACCIÓN
-- ===========================================================================
-- Cortex ya sabía cotizar (0182), cobrar (0159/0165) y quién es cada cliente
-- (0075). Lo que no sabía es lo que pasa ANTES de la cotización y DESPUÉS de
-- la factura: qué negocios vienen, en qué etapa va cada uno, a quién hay que
-- llamar hoy, qué cliente se está enfriando y si los clientes están contentos.
--
--   1. `crm_pipelines` — el embudo de la empresa: sus etapas en orden, cada una
--      con su probabilidad por defecto y, si la tiene, su PAPEL (`role`):
--      `quote_sent`, `at_risk`, `won`, `lost`. Las reglas automáticas buscan la
--      etapa por papel, no por nombre: una empresa que renombra «Ganada» a
--      «Cerrada» no rompe nada. Sin fila, el código usa el embudo de la casa
--      (packages/agent-tools/src/crm/shape.ts → DEFAULT_STAGES).
--
--   2. `crm_opportunities` — un negocio posible: cliente, valor, etapa,
--      probabilidad (null = la de la etapa), cierre esperado, responsable,
--      origen, el siguiente paso con fecha, la razón si se perdió y la
--      cotización y el pedido de Ventas que lo materializan. Las reglas
--      (crm/rules.ts) mueven la etapa solas: cotización enviada → «Cotización
--      enviada», aceptada → «Ganada» (con su pedido cuando exista), vencida
--      sin respuesta → «En riesgo».
--
--   3. `crm_activities` — llamadas, reuniones, correos, notas y tareas (con
--      fecha y hecho/no hecho), más los cambios de etapa como huella. La línea
--      de tiempo de una oportunidad mezcla esto con los correos, reuniones y
--      WhatsApp que el hub de clientes ya ata al cliente: no se copian aquí.
--
--   4. `nps_surveys` + `nps_responses` — «¿qué tan probable es que nos
--      recomiende?» de 0 a 10. La encuesta se abre sin sesión en
--      /encuesta/<token> (el token ES la credencial, como /cotizacion/<token>);
--      una respuesta por encuesta. Un detractor (0–6) deja una tarea de
--      seguimiento para el responsable del cliente.
--
--   5. `crm_client_risk` — la última lectura del riesgo de perder a cada
--      cliente (crm/churn.ts, puro) con su evidencia, y hasta qué nivel ya se
--      le CONTÓ al dueño (`told_level`): el piloto avisa de lo NUEVO, no repite
--      cada mañana lo mismo.
--
-- Tenencia: `organization_id` en todas, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts; RLS deny-all + service_role.
-- Idempotente.

-- ---------------------------------------------------------------------------
-- 1. El embudo
-- ---------------------------------------------------------------------------
create table if not exists public.crm_pipelines (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  text        not null references public.ba_organization(id) on delete cascade,
  name             text        not null default 'Embudo comercial'
                               check (length(btrim(name)) between 1 and 120),
  is_default       boolean     not null default true,
  -- [{ "key": "nuevo", "label": "Nuevo", "probability": 10, "role": null }, …]
  -- en orden. La forma la valida el código al guardar (crm/shape.ts).
  stages           jsonb       not null,
  created_by       uuid        references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint crm_pipelines_stages_array check (
    jsonb_typeof(stages) = 'array' and jsonb_array_length(stages) between 2 and 20
  )
);

-- Un embudo por defecto por empresa.
create unique index if not exists crm_pipelines_one_default_idx
  on public.crm_pipelines (organization_id) where is_default;

comment on table public.crm_pipelines is
  'Embudo comercial de la empresa: etapas en orden con probabilidad y papel (quote_sent, at_risk, won, lost). Ver packages/agent-tools/src/crm/.';

-- ---------------------------------------------------------------------------
-- 2. Las oportunidades
-- ---------------------------------------------------------------------------
create table if not exists public.crm_opportunities (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  pipeline_id       uuid        references public.crm_pipelines(id) on delete set null,
  -- El cliente del hub (0075). El nombre se copia: un prospecto todavía no es
  -- cliente, y la oportunidad dice a quién se le estaba vendiendo.
  client_id         uuid        references public.clients(id) on delete set null,
  client_name       text        not null check (length(btrim(client_name)) between 1 and 200),
  title             text        not null check (length(btrim(title)) between 1 and 200),
  value             numeric(18,2) not null default 0 check (value >= 0 and value < 1e15),
  currency          text        not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  stage             text        not null check (stage ~ '^[a-z0-9_]{1,40}$'),
  -- null = la probabilidad por defecto de la etapa.
  probability       integer     check (probability is null or probability between 0 and 100),
  expected_close    date,
  owner_user_id     uuid        references public.users(id) on delete set null,
  source            text        not null default 'otro'
                                check (source in ('prospect', 'inbound', 'referral', 'whatsapp', 'email', 'otro')),
  -- De qué prospecto salió (0105, /prospects), cuando salió de uno.
  prospect_ref      text        check (prospect_ref is null or length(prospect_ref) <= 200),
  next_step         text        check (next_step is null or length(next_step) <= 500),
  next_step_due     date,
  lost_reason_kind  text        check (lost_reason_kind is null or lost_reason_kind in (
                                  'precio', 'competencia', 'sin_presupuesto', 'sin_respuesta',
                                  'tiempo', 'producto', 'otro')),
  lost_reason       text        check (lost_reason is null or length(lost_reason) <= 1000),
  -- Lo que la materializa en Ventas (0182).
  quote_id          uuid        references public.sales_documents(id) on delete set null,
  order_id          uuid        references public.sales_documents(id) on delete set null,
  notes             text        check (notes is null or length(notes) <= 4000),
  stage_changed_at  timestamptz not null default now(),
  -- La última actividad registrada (o el último cambio): mide lo «quieto».
  last_activity_at  timestamptz not null default now(),
  won_at            timestamptz,
  lost_at           timestamptz,
  created_by        uuid        references public.users(id) on delete set null,
  updated_by        uuid        references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists crm_opportunities_org_stage_idx
  on public.crm_opportunities (organization_id, stage, expected_close);

create index if not exists crm_opportunities_client_idx
  on public.crm_opportunities (organization_id, client_id, created_at desc)
  where client_id is not null;

create index if not exists crm_opportunities_owner_idx
  on public.crm_opportunities (organization_id, owner_user_id)
  where owner_user_id is not null;

-- Una cotización materializa UN negocio: dos oportunidades con la misma
-- cotización contarían dos veces la misma plata en el pronóstico.
create unique index if not exists crm_opportunities_one_per_quote_idx
  on public.crm_opportunities (organization_id, quote_id) where quote_id is not null;

comment on table public.crm_opportunities is
  'Negocios posibles por etapa, con valor, probabilidad, cierre esperado, responsable y su cotización/pedido de Ventas. Ver packages/agent-tools/src/crm/.';

-- ---------------------------------------------------------------------------
-- 3. Las actividades
-- ---------------------------------------------------------------------------
create table if not exists public.crm_activities (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  opportunity_id    uuid        references public.crm_opportunities(id) on delete cascade,
  client_id         uuid        references public.clients(id) on delete set null,
  -- `stage`: la huella de un cambio de etapa (a mano o por una regla).
  kind              text        not null check (kind in ('call', 'meeting', 'email', 'note', 'task', 'stage')),
  title             text        not null check (length(btrim(title)) between 1 and 300),
  body              text        check (body is null or length(body) <= 4000),
  due_on            date,
  done_at           timestamptz,
  -- A quién le toca (una tarea) o quién la hizo (una llamada).
  owner_user_id     uuid        references public.users(id) on delete set null,
  -- De dónde salió: una persona, una regla, una encuesta, el piloto, el chat.
  origin            text        not null default 'manual'
                                check (origin in ('manual', 'rule', 'nps', 'autopilot', 'agent')),
  created_by        uuid        references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint crm_activities_has_subject check (opportunity_id is not null or client_id is not null)
);

create index if not exists crm_activities_opp_idx
  on public.crm_activities (opportunity_id, created_at desc) where opportunity_id is not null;

create index if not exists crm_activities_client_idx
  on public.crm_activities (organization_id, client_id, created_at desc) where client_id is not null;

-- «Mis tareas de hoy»: lo abierto con fecha, por responsable.
create index if not exists crm_activities_open_tasks_idx
  on public.crm_activities (organization_id, owner_user_id, due_on)
  where kind = 'task' and done_at is null;

-- ---------------------------------------------------------------------------
-- 4. Encuestas de satisfacción (NPS)
-- ---------------------------------------------------------------------------
create table if not exists public.nps_surveys (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  client_id         uuid        references public.clients(id) on delete set null,
  client_name       text        not null check (length(btrim(client_name)) between 1 and 200),
  contact_name      text        check (contact_name is null or length(contact_name) <= 200),
  contact_email     text        check (contact_email is null or length(contact_email) <= 320),
  -- El enlace público. 24 bytes al azar en base64url.
  token             text        not null unique check (token ~ '^[A-Za-z0-9_-]{32,64}$'),
  -- Por dónde salió: un correo desde Gmail/Outlook, o un enlace que alguien
  -- copió y mandó por su cuenta.
  channel           text        not null default 'link' check (channel in ('email', 'link')),
  status            text        not null default 'pendiente'
                                check (status in ('pendiente', 'enviada', 'respondida', 'anulada')),
  sent_at           timestamptz,
  opened_at         timestamptz,
  responded_at      timestamptz,
  expires_on        date,
  created_by        uuid        references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists nps_surveys_org_created_idx
  on public.nps_surveys (organization_id, created_at desc);

create index if not exists nps_surveys_client_idx
  on public.nps_surveys (organization_id, client_id, created_at desc) where client_id is not null;

create table if not exists public.nps_responses (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  -- Una respuesta por encuesta: contestar dos veces no cuenta dos.
  survey_id         uuid        not null unique references public.nps_surveys(id) on delete cascade,
  client_id         uuid        references public.clients(id) on delete set null,
  score             integer     not null check (score between 0 and 10),
  comment           text        check (comment is null or length(comment) <= 2000),
  respondent_name   text        check (respondent_name is null or length(respondent_name) <= 200),
  -- La tarea de seguimiento que dejó un detractor.
  follow_up_id      uuid        references public.crm_activities(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index if not exists nps_responses_org_created_idx
  on public.nps_responses (organization_id, created_at desc);

create index if not exists nps_responses_client_idx
  on public.nps_responses (organization_id, client_id, created_at desc) where client_id is not null;

-- ---------------------------------------------------------------------------
-- 5. El riesgo de perder a cada cliente
-- ---------------------------------------------------------------------------
create table if not exists public.crm_client_risk (
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  client_id         uuid        not null references public.clients(id) on delete cascade,
  level             text        not null check (level in ('alto', 'medio', 'bajo')),
  score             integer     not null check (score between 0 and 100),
  -- Las frases que lo justifican, como las escribió crm/churn.ts.
  evidence          jsonb       not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  suggested_action  text        check (suggested_action is null or length(suggested_action) <= 500),
  computed_at       timestamptz not null default now(),
  -- Hasta qué nivel ya se le contó al dueño (el piloto avisa sólo lo nuevo).
  told_level        text        check (told_level is null or told_level in ('alto', 'medio', 'bajo')),
  told_at           timestamptz,
  primary key (organization_id, client_id)
);

-- ---------------------------------------------------------------------------
-- 6. updated_at
-- ---------------------------------------------------------------------------
drop trigger if exists crm_pipelines_touch_updated_at on public.crm_pipelines;
create trigger crm_pipelines_touch_updated_at
  before update on public.crm_pipelines
  for each row execute function public.touch_updated_at();

drop trigger if exists crm_opportunities_touch_updated_at on public.crm_opportunities;
create trigger crm_opportunities_touch_updated_at
  before update on public.crm_opportunities
  for each row execute function public.touch_updated_at();

drop trigger if exists crm_activities_touch_updated_at on public.crm_activities;
create trigger crm_activities_touch_updated_at
  before update on public.crm_activities
  for each row execute function public.touch_updated_at();

drop trigger if exists nps_surveys_touch_updated_at on public.nps_surveys;
create trigger nps_surveys_touch_updated_at
  before update on public.nps_surveys
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 7. Acceso: sólo el servidor
-- ---------------------------------------------------------------------------
alter table public.crm_pipelines     enable row level security;
alter table public.crm_opportunities enable row level security;
alter table public.crm_activities    enable row level security;
alter table public.nps_surveys       enable row level security;
alter table public.nps_responses     enable row level security;
alter table public.crm_client_risk   enable row level security;

revoke all on table public.crm_pipelines     from public, anon, authenticated;
revoke all on table public.crm_opportunities from public, anon, authenticated;
revoke all on table public.crm_activities    from public, anon, authenticated;
revoke all on table public.nps_surveys       from public, anon, authenticated;
revoke all on table public.nps_responses     from public, anon, authenticated;
revoke all on table public.crm_client_risk   from public, anon, authenticated;

grant select, insert, update, delete on table public.crm_pipelines     to service_role;
grant select, insert, update, delete on table public.crm_opportunities to service_role;
grant select, insert, update, delete on table public.crm_activities    to service_role;
grant select, insert, update, delete on table public.nps_surveys       to service_role;
grant select, insert, update, delete on table public.nps_responses     to service_role;
grant select, insert, update, delete on table public.crm_client_risk   to service_role;
