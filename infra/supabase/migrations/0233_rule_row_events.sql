-- ===========================================================================
-- HISTORIAL DE UNA FILA: LO QUE UNA REGLA CAMBIÓ EN ELLA
-- ===========================================================================
-- Una regla de una app puede escribir en OTRA fila (cambiar filas relacionadas,
-- acumular en el padre, poner un campo). Ese cambio no pasa por ninguna pantalla,
-- así que no tenía vista ni bloque: ahora deja un evento por escritura, con el
-- nombre de la regla y el motivo, para que aparezca en el Historial de la fila
-- («Regla: Total del vuelo») y se pueda deshacer con los permisos de quien lo pide.
--
-- Sólo se afloja lo que lo impedía: un evento de regla no tiene vista ni bloque.
-- Los eventos de pantallas siguen exigiéndolos (check de abajo).

alter table public.custom_view_events alter column view_id drop not null;
alter table public.custom_view_events alter column block_id drop not null;

alter table public.custom_view_events
  add column if not exists rule_name text check (rule_name is null or char_length(rule_name) between 1 and 120),
  add column if not exists reason    text check (reason is null or char_length(reason) between 1 and 300);

alter table public.custom_view_events
  drop constraint if exists custom_view_events_kind_check;
alter table public.custom_view_events
  add constraint custom_view_events_kind_check check (kind in ('edit', 'move', 'action', 'rule'));

alter table public.custom_view_events
  drop constraint if exists custom_view_events_origin_check;
alter table public.custom_view_events
  add constraint custom_view_events_origin_check check (
    (kind = 'rule' and rule_name is not null) or (kind <> 'rule' and view_id is not null and block_id is not null)
  );

create index if not exists custom_view_events_row_idx
  on public.custom_view_events (tracker_row_id, created_at desc)
  where tracker_row_id is not null;

comment on column public.custom_view_events.rule_name is
  'kind = rule: nombre de la regla de la app que escribió la fila.';
comment on column public.custom_view_events.reason is
  'kind = rule: por qué (qué fila cambió y disparó la regla).';
