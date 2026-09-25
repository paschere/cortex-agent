-- ===========================================================================
-- LAS VISTAS YA NO SÓLO SE MIRAN: SE EDITAN Y TIENEN BOTONES
-- ===========================================================================
-- Desde la 0156 una vista podía agregar filas con un formulario. Ahora puede,
-- si quien la armó lo decide (`spec.editing`): editar una celda, arrastrar una
-- tarjeta a otra columna del tablero y usar botones por fila («Marcar
-- pagada», «Pedir revisión»). Sólo sobre tablas propias; las fuentes de la
-- plataforma siguen siendo de sólo lectura.
--
-- `custom_view_events` es el rastro: qué cambió, en qué fila, por qué vista y
-- quién — una persona del equipo o «alguien con el enlace» (actor null). Es lo
-- que contesta «¿quién movió esto a Pagada?» y lo que el código cuenta para el
-- tope por hora de cambios desde afuera.
--
-- Y una clase de aviso nueva, `view_activity`: la campana de quien creó la
-- vista cuando alguien usa un botón de «avisar» o entra una fila por un
-- formulario con alerta de campana.
--
-- Tenencia: `organization_id` en cada fila, `tenant()` en tenancy/tables.ts.

create table public.custom_view_events (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  view_id           uuid not null references public.custom_views (id) on delete cascade,
  block_id          text not null check (char_length(block_id) between 1 and 40),
  kind              text not null check (kind in ('edit', 'move', 'action')),
  action_id         text check (action_id is null or char_length(action_id) between 1 and 40),
  tracker_row_id    uuid references public.tracker_rows (id) on delete set null,
  -- { campo: { "from": valor anterior, "to": valor nuevo } }
  changes           jsonb not null default '{}'::jsonb check (jsonb_typeof(changes) = 'object'),
  actor             uuid,
  created_at        timestamptz not null default now()
);

create index custom_view_events_org_view_idx
  on public.custom_view_events (organization_id, view_id, created_at desc);

comment on table public.custom_view_events is
  'Cada edición, movimiento de tarjeta o botón usado en una vista: qué cambió, en qué fila y quién (null = alguien con el enlace).';

alter table public.custom_view_events enable row level security;
revoke all on table public.custom_view_events from public, anon, authenticated;
grant select, insert, update, delete on table public.custom_view_events to service_role;

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'flow_finished','flow_failed','flow_needs_person','routine_finished','routine_failed',
  'errand_asked','errand_finished','action_sent','action_failed','report_ready','mail_worth_seeing',
  'management_attention','receivables_overdue','view_activity'
));
