-- Stable event identity prevents a retry from reviving even a read notification.
alter table public.notifications add column dedupe_key text;
create unique index notifications_event_once on public.notifications(organization_id,user_id,dedupe_key);
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'flow_finished','flow_failed','flow_needs_person','routine_finished','routine_failed',
  'errand_asked','errand_finished','action_sent','action_failed','report_ready','mail_worth_seeing',
  'management_attention'
));
