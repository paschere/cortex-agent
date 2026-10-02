-- ===========================================================================
-- EL REGISTRO DE TRABAJO: TODO LO QUE ALGUIEN TIENE QUE HACER O HIZO
-- ===========================================================================
-- Un solo registro de trabajo asignado, con su responsable, cuándo se abrió,
-- cuándo vence y cuándo se cerró. Se llena desde lo que ya existe en Cortex
-- (asuntos de Gerencia, compromisos y vencimientos, filas de tablas con
-- responsable, aprobaciones que esperan a alguien) y desde cualquier fuente
-- que Cortex lea: el chat («registra que Laura despachó 12 guías hoy»), una
-- hoja, un grupo de WhatsApp de operación. El contrato está en
-- packages/agent-tools/src/work/types.ts; la ingesta en work/sync.ts.
--
-- MIDE TRABAJO, NO PERSONAS (Ley 1581 de habeas data y la confianza del
-- equipo). Por eso estas tablas guardan el TÍTULO del trabajo, sus fechas y su
-- resultado medible, y nunca el contenido de un chat o de un correo: una
-- aprobación entra como «Espera de decisión: Enviar el correo redactado», sin
-- destinatario ni asunto. Cada persona puede ver todo lo que se mide de ella;
-- sólo quien administra la empresa ve a todo el equipo (salvo que la empresa
-- abra la visibilidad en `work_settings.team_visibility`). La empresa decide
-- qué tipos de trabajo se miden (`work_settings.measured_types`): lo que no se
-- mide ni siquiera se guarda.
--
-- TRES TABLAS:
--
--   work_items        Un ítem de trabajo. Su identidad EN la fuente
--                     (source_kind, source_system, source_ref) es única por
--                     empresa: re-ingerir lo mismo actualiza la fila, nunca la
--                     duplica. Así la sincronización y `work.record` pueden
--                     repetirse sin miedo.
--   work_people_meta  Por persona: equipo, cargo y días fuera (vacaciones,
--                     incapacidad) que no cuentan en contra. Los edita un
--                     administrador; la persona edita SUS días fuera. La regla
--                     está en work/store.ts (`updateWorkPerson`).
--   work_settings     Por empresa: qué se mide, qué fuentes entran, cómo una
--                     tabla inventada se vuelve trabajo (qué campo es el
--                     responsable, el estado, el vencimiento, la cantidad), la
--                     visibilidad, y por dónde va la sincronización.
--
-- Tenencia: `organization_id` en las tres, `tenant()` en tenancy/tables.ts.
-- Sólo service_role: las toca el servidor, nunca un navegador.
--
-- Y una clase de aviso nueva, `work_assigned`: a quien le reasignan trabajo
-- se le avisa en la campana (apps/web/inngest/functions/work-sync.ts).

create table if not exists public.work_items (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  -- Responsable. Nulo = sin asignar (o un nombre de la fuente que no es nadie
  -- del equipo con cuenta: queda en `assignee_label`).
  assignee_id       uuid references public.users (id) on delete set null,
  assignee_label    text check (assignee_label is null or length(assignee_label) <= 160),
  -- Para comparar peras con peras: 'despacho', 'cobro', 'caso', 'decisión'…
  work_type         text not null check (length(btrim(work_type)) between 1 and 60),
  title             text not null check (length(btrim(title)) between 1 and 300),
  status            text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  opened_at         timestamptz not null,
  -- El vencimiento es un DÍA (due_on) o un INSTANTE (due_at), nunca los dos.
  due_on            date,
  due_at            timestamptz,
  done_at           timestamptz,
  -- Último movimiento visible en la fuente (métricas: «sin moverse»).
  last_activity_at  timestamptz,
  -- Resultado medible opcional: guías despachadas, plata cobrada…
  quantity          numeric check (quantity is null or quantity >= 0),
  unit              text check (unit is null or length(unit) <= 30),
  team              text check (team is null or length(team) <= 80),
  source_kind       text not null check (source_kind in (
                      'management_case', 'commitment', 'tracker_row', 'receivable',
                      'approval', 'request', 'routine', 'manual', 'chat', 'sheet', 'whatsapp')),
  -- '' cuando la fuente no tiene sistema: un nulo haría distinta cada fila
  -- para el índice único y la ingesta dejaría de ser idempotente.
  source_system     text not null default '' check (length(source_system) <= 80),
  source_ref        text not null check (length(btrim(source_ref)) between 1 and 200),
  recorded_by       uuid references public.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint work_items_one_due check (due_on is null or due_at is null),
  constraint work_items_done_has_time check (status <> 'done' or done_at is not null),
  constraint work_items_source_once unique (organization_id, source_kind, source_system, source_ref)
);

-- «Lo mío», «lo de Laura»: por persona y estado.
create index if not exists work_items_org_assignee_idx
  on public.work_items (organization_id, assignee_id, status);
-- Lo abierto y lo vencido de la empresa, por vencimiento.
create index if not exists work_items_org_open_due_idx
  on public.work_items (organization_id, due_on, due_at)
  where status = 'open';
-- Lo cerrado en un período, por tipo (las métricas).
create index if not exists work_items_org_type_done_idx
  on public.work_items (organization_id, work_type, done_at desc);

comment on table public.work_items is
  'El registro de trabajo: cada cosa que alguien del equipo tiene que hacer o hizo, con responsable, apertura, vencimiento y cierre. Mide trabajo, no personas: guarda el título y las fechas, nunca el contenido de chats o correos. Ver packages/agent-tools/src/work.';
comment on column public.work_items.source_ref is
  'La identidad del ítem EN su fuente (id del asunto, del compromiso, de la fila; o una huella de los hechos para lo dicho en el chat). Con organization_id, source_kind y source_system es única: re-ingerir lo mismo actualiza la fila, no la duplica.';
comment on column public.work_items.assignee_label is
  'El nombre tal como lo trae la fuente cuando no corresponde a nadie del equipo con cuenta (o es ambiguo). Sirve para mostrarlo y para asignarlo después; no cuenta como responsable.';

create table if not exists public.work_people_meta (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  user_id          uuid not null references public.users (id) on delete cascade,
  team             text check (team is null or length(btrim(team)) between 1 and 80),
  role_label       text check (role_label is null or length(btrim(role_label)) between 1 and 80),
  -- Días sin trabajar (vacaciones, incapacidad). No cuentan en contra.
  away_days        date[] not null default '{}' check (cardinality(away_days) <= 400),
  updated_by       uuid references public.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint work_people_meta_once unique (organization_id, user_id)
);

comment on table public.work_people_meta is
  'Por persona del equipo: equipo, cargo y días fuera para el registro de trabajo. Equipo y cargo los edita un administrador; los días fuera, un administrador o la propia persona (regla en work/store.ts).';

create table if not exists public.work_settings (
  organization_id  text primary key,
  -- Tipos de trabajo que se miden. Nulo = todos. Lo que no se mide no se guarda.
  measured_types   text[] check (measured_types is null or cardinality(measured_types) <= 60),
  -- Fuentes de Cortex que la sincronización lee.
  sources          text[] not null default array['management_case', 'commitment', 'tracker_row', 'approval']
                     check (sources <@ array['management_case', 'commitment', 'tracker_row', 'approval']),
  -- Tablas inventadas que son trabajo: [{ tracker, workType, assigneeField,
  -- statusField, doneValues, cancelledValues, dueField, quantityField, unit,
  -- titleField, teamField, doneAtField, openedAtField }, …]. La forma la valida
  -- work/shape.ts (`trackerMappingSchema`).
  tracker_mappings jsonb not null default '[]'::jsonb check (
    jsonb_typeof(tracker_mappings) = 'array' and jsonb_array_length(tracker_mappings) <= 40
  ),
  -- Quién ve el trabajo de quién, fuera de los administradores (que ven todo):
  -- self = cada quien lo suyo; team = lo de su equipo; all = todo el equipo.
  team_visibility  text not null default 'self' check (team_visibility in ('self', 'team', 'all')),
  -- Por dónde va la sincronización de cada fuente: { "commitment": iso, … }.
  sync_state       jsonb not null default '{}'::jsonb check (jsonb_typeof(sync_state) = 'object'),
  last_synced_at   timestamptz,
  updated_by       uuid references public.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.work_settings is
  'Por empresa: qué tipos de trabajo se miden, qué fuentes entran, cómo una tabla inventada se vuelve trabajo, quién ve el trabajo de quién y por dónde va la sincronización. Lo cambia un administrador (work.configure).';

alter table public.work_items        enable row level security;
alter table public.work_people_meta  enable row level security;
alter table public.work_settings     enable row level security;

revoke all on table public.work_items        from public, anon, authenticated;
revoke all on table public.work_people_meta  from public, anon, authenticated;
revoke all on table public.work_settings     from public, anon, authenticated;

grant select, insert, update, delete on table public.work_items        to service_role;
grant select, insert, update, delete on table public.work_people_meta  to service_role;
grant select, insert, update, delete on table public.work_settings     to service_role;

-- ---------------------------------------------------------------------------
-- La campana: `work_assigned` (te reasignaron trabajo).
-- ---------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'flow_finished','flow_failed','flow_needs_person','routine_finished','routine_failed',
  'errand_asked','errand_finished','action_sent','action_failed','report_ready','mail_worth_seeing',
  'management_attention','receivables_overdue','view_activity','table_sync','work_assigned'
));
