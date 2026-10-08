-- 0218 — La entrevista guiada también propone tablas, vistas, aplicaciones y
-- automatizaciones.
--
-- Los cinco tipos de 0094 eran una lista cerrada en la base de datos a
-- propósito. Sigue siéndolo: sólo crece con los cuatro que el motor general ya
-- sabe construir como BORRADOR (tabla, vista interna, aplicación sin publicar,
-- automatización en pausa). Y aparece un estado nuevo, `handoff`: lo que no se
-- puede crear sin una fuente externa o sin que el diseñador cuadre con las
-- tablas reales se entrega al chat con el pedido ya escrito, sin crear nada.

alter table public.guided_setup_items
  drop constraint if exists guided_setup_items_kind_check;
alter table public.guided_setup_items
  add constraint guided_setup_items_kind_check
  check (kind in (
    'commitment','routine','flow','client','space',
    'table','view','app','automation'
  ));

alter table public.guided_setup_items
  drop constraint if exists guided_setup_items_status_check;
alter table public.guided_setup_items
  add constraint guided_setup_items_status_check
  check (status in ('proposed','created','merged','skipped','failed','undone','handoff'));
