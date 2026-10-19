-- ===========================================================================
-- AUTOMATIZACIONES: DISPARADOR «SE BORRA UNA FILA» (row_deleted)
-- ===========================================================================
-- Un disparador nuevo para las reglas de las apps: cuando se borra una fila, el
-- suceso lleva los valores que tenía (la fila ya no existe) y sirve, por ejemplo,
-- para recalcular el acumulado de la fila padre («costo total del vuelo») con las
-- hijas que quedan. Es sólo ampliar la lista de tipos permitidos de la copia
-- `trigger_kind`; la regla completa sigue validándose en el código
-- (packages/agent-tools/src/apps/automations/spec.ts), sin migración por cambio.
--
-- Lo demás de esta función (acciones «cambiar filas relacionadas», «cambiar filas
-- por filtro», «acumular», «esperar», y el «si» / «si no» por acción) vive dentro
-- del JSON de `actions` y no necesita cambios en la base.

alter table public.custom_app_automations
  drop constraint if exists custom_app_automations_kind;
alter table public.custom_app_automations
  add constraint custom_app_automations_kind check (
    trigger_kind in ('row_created', 'row_updated', 'row_flagged_duplicate',
                     'form_submitted', 'approval_decided', 'schedule', 'button',
                     'rows_poll', 'row_deleted')
  );
