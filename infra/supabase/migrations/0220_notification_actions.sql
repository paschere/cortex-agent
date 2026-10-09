-- ===========================================================================
-- CORTEX HABLA PRIMERO: «TU DÍA» Y AVISOS CON BOTONES
-- ===========================================================================
-- Dos cambios chicos sobre `public.notifications` (0096):
--
--   1. Clase nueva `briefing`: «Tu día», el resumen de las 07:00 de Bogotá.
--      Uno por persona y día (la clave de deduplicación lleva el día).
--
--   2. Columna `actions jsonb`: los botones del aviso. UNA acción referencia
--      una cosa del piloto automático por su id y su huella de contenido; NUNCA
--      una herramienta suelta. Hacerlo desde el aviso pasa por el MISMO camino
--      que «Aprobar y hacerlo» de /piloto (permisos, huella vigente, auditoría).
--      Forma:  [{ "kind": "autopilot_item", "itemId": "<uuid>",
--                 "contentHash": "<huella>", "title": "Reintentar la hoja…" }]
--
-- Sin tablas nuevas: `notifications` ya tiene `organization_id`, RLS y permisos
-- sólo para service_role. Las suscripciones Web Push de la app principal usan
-- `push_subscriptions` (0210) con `app_id` nulo y `subject_kind = 'member'`.

alter table public.notifications
  add column if not exists actions jsonb;

alter table public.notifications drop constraint if exists notifications_actions_shape;
alter table public.notifications add constraint notifications_actions_shape check (
  actions is null
  or (jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) <= 3)
);

comment on column public.notifications.actions is
  'Botones del aviso: lista (máx. 3) de { kind: autopilot_item, itemId, contentHash, title }. Referencian una cosa del piloto; nunca una herramienta. Se ejecutan por el mismo camino que /piloto.';

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'flow_finished','flow_failed','flow_needs_person','routine_finished','routine_failed',
  'errand_asked','errand_finished','action_sent','action_failed','report_ready','mail_worth_seeing',
  'management_attention','receivables_overdue','view_activity','table_sync','work_assigned',
  'approval_waiting','work_overdue','briefing'
));
