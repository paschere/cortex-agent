-- 0222 · TAREAS EN SEGUNDO PLANO («Tareas», como Manus).
--
-- Una tarea es un pedido del chat que corre en el servidor (el worker de
-- trabajos de Railway llama a la app), no en la pestaña del navegador: se puede
-- cerrar el computador y seguir. Usa la MISMA maquinaria del turno del chat
-- (mismas herramientas, permisos, confirmaciones y auditoría), guarda su avance
-- en la conversación (la fila del asistente se escribe paso a paso) y su estado
-- aquí.
--
-- Estados: queued (en cola) → working (trabajando) → needs_you (te necesita:
-- una acción parada esperando tu visto bueno) → done (lista) | failed (falló) |
-- cancelled (cancelada). El tope total lo pone `deadline_at` (20 minutos desde
-- que empezó a trabajar).

create table if not exists public.background_tasks (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     text not null references public.ba_organization(id) on delete cascade,
  user_id             uuid not null references public.users(id) on delete cascade,
  -- La conversación donde nació y donde se ve su avance. Si se borra, la tarea
  -- queda (con su resultado) pero sin hilo que mostrar.
  conversation_id     uuid references public.conversations(id) on delete set null,
  title               text not null check (length(btrim(title)) between 1 and 200),
  prompt              text not null check (length(btrim(prompt)) between 1 and 8000),
  -- 'new' = pedido desde cero; 'continue' = un turno del chat que se movió a
  -- segundo plano a la mitad (lo ya hecho está en la conversación).
  mode                text not null default 'new' check (mode in ('new', 'continue')),
  status              text not null default 'queued'
                      check (status in ('queued', 'working', 'needs_you', 'done', 'failed', 'cancelled')),
  -- Cuántas tandas (invocaciones del trabajo) lleva. Cada tanda cabe en una
  -- llamada de la app; una tarea larga encadena varias.
  segment             integer not null default 0 check (segment >= 0),
  steps_count         integer not null default 0 check (steps_count >= 0),
  tokens_in           bigint not null default 0,
  tokens_out          bigint not null default 0,
  -- Acciones paradas que esperan a la persona: [{ id, toolId, summary, decision?, ok?, note? }]
  pending_approvals   jsonb not null default '[]'::jsonb,
  result              text check (result is null or length(result) <= 60000),
  error               text check (error is null or length(error) <= 4000),
  retry_of            uuid references public.background_tasks(id) on delete set null,
  cancel_requested_at timestamptz,
  queued_at           timestamptz not null default now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  -- started_at + 20 min: pasado esto la tarea cierra con lo que lleve.
  deadline_at         timestamptz,
  heartbeat_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.background_tasks is
  'Tareas en segundo plano (0222): un pedido del chat que corre en el worker de trabajos. Estado aquí; avance (pasos, resultados) en la fila del asistente de la conversación.';

create index if not exists background_tasks_owner_idx
  on public.background_tasks (organization_id, user_id, created_at desc);
create index if not exists background_tasks_org_idx
  on public.background_tasks (organization_id, created_at desc);
create index if not exists background_tasks_active_idx
  on public.background_tasks (status, heartbeat_at)
  where status in ('queued', 'working', 'needs_you');
create index if not exists background_tasks_conversation_idx
  on public.background_tasks (conversation_id) where conversation_id is not null;

alter table public.background_tasks enable row level security;
drop policy if exists background_tasks_service_only on public.background_tasks;
create policy background_tasks_service_only on public.background_tasks
  for all to service_role using (true) with check (true);

-- Avisos: terminó, te necesita, falló. `task` es un origen más.
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'flow_finished','flow_failed','flow_needs_person','routine_finished','routine_failed',
  'errand_asked','errand_finished','action_sent','action_failed','report_ready','mail_worth_seeing',
  'management_attention','receivables_overdue','view_activity','table_sync','work_assigned',
  'approval_waiting','work_overdue','briefing',
  'task_finished','task_needs_you','task_failed'
));

alter table public.notifications drop constraint if exists notifications_source_kind_check;
alter table public.notifications add constraint notifications_source_kind_check
  check (source_kind in ('flow_run', 'routine_run', 'errand', 'action', 'report', 'task'));
