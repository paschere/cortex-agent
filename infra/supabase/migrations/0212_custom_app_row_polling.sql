-- ===========================================================================
-- APLICACIONES: «CADA X MINUTOS, PARA CADA FILA QUE CUMPLA…» Y TOPES POR APP
-- ===========================================================================
-- 1. Un disparador nuevo, `rows_poll`: cada X minutos mira la tabla y encola una
--    corrida por cada fila que cumpla las condiciones (y esté dentro de su
--    ventana de fechas), con tope de filas por vuelta y frecuencia mínima por
--    fila. Reutiliza el despachador de horarios (`schedule_last_slot` guarda la
--    última vuelta reclamada); no hay tabla nueva: la frecuencia por fila sale
--    de la clave de idempotencia de la corrida (regla + fila + franja).
--    Con él, «seguir vuelos» o «recalcular precios» son una automatización
--    normal: disparador + pedirle a Cortex en texto.
-- 2. Topes por app configurables (antes fijos: 500 corridas y 20 pedidos a
--    Cortex por día): `automation_limits` = { runsPerDay, askCortexPerDay }.
--    Vacío = los valores por defecto del código (packages/agent-tools/src/
--    apps/automations/engine.ts), que también fija los máximos permitidos.

alter table public.custom_app_automations
  drop constraint if exists custom_app_automations_kind;
alter table public.custom_app_automations
  add constraint custom_app_automations_kind check (
    trigger_kind in ('row_created', 'row_updated', 'row_flagged_duplicate',
                     'form_submitted', 'approval_decided', 'schedule', 'button',
                     'rows_poll')
  );

-- Las vueltas de «cada X minutos» las busca el despachador de cada minuto.
create index if not exists custom_app_automations_poll_idx
  on public.custom_app_automations (trigger_kind)
  where enabled and trigger_kind = 'rows_poll';

alter table public.custom_apps
  add column if not exists automation_limits jsonb not null default '{}'::jsonb
    check (jsonb_typeof(automation_limits) = 'object');

comment on column public.custom_apps.automation_limits is
  'Topes diarios de las automatizaciones de la app: { runsPerDay, askCortexPerDay }. Vacío = valores por defecto del código.';
