-- ===========================================================================
-- LA CARTERA AVISA SOLA
-- ===========================================================================
-- Hasta aquí la cartera (0098) sólo contestaba cuando alguien preguntaba. Los
-- vencimientos (0069) y las metas avisaban solos; las facturas vencidas no, y
-- una factura a 60 días que nadie mira es plata que se está yendo.
--
-- El vigilante de cartera avisa UNA vez por escalón de mora de cada factura:
-- al vencer, a los 30, a los 60 y a los 90 días (ver OVERDUE_STAGES en
-- packages/agent-tools/src/payments/risk.ts). Esta tabla es lo que hace que
-- «una vez» sea cierto: el índice único decide, no el código. Un cron que corre
-- dos veces, o una Inngest que reintenta, manda un solo correo.
--
-- Tenencia: `organization_id` en cada fila, `tenant()` en tenancy/tables.ts.

create table public.receivable_notices (
  id                uuid primary key default gen_random_uuid(),
  organization_id   text not null,
  extraction_id     uuid not null references public.document_extractions (id) on delete cascade,
  stage             smallint not null check (stage in (1, 30, 60, 90)),
  sent_on           date not null,
  created_at        timestamptz not null default now(),
  constraint receivable_notices_once unique (organization_id, extraction_id, stage)
);

create index receivable_notices_org_sent_idx
  on public.receivable_notices (organization_id, sent_on desc);

comment on table public.receivable_notices is
  'Qué escalón de mora (1, 30, 60, 90 días) de qué factura por cobrar ya se avisó. El índice único es lo que garantiza un aviso por escalón.';

alter table public.receivable_notices enable row level security;
revoke all on table public.receivable_notices from public, anon, authenticated;
grant select, insert, update, delete on table public.receivable_notices to service_role;

-- La campana también la dice: el correo puede perderse en un buzón lleno.
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'flow_finished','flow_failed','flow_needs_person','routine_finished','routine_failed',
  'errand_asked','errand_finished','action_sent','action_failed','report_ready','mail_worth_seeing',
  'management_attention','receivables_overdue'
));
