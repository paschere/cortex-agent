-- 0221 — El detalle de auditoría se borra a los 30 días.
--
-- Desde «Lo que hizo Cortex» (/actividad), las llamadas con efectos guardan en
-- audit_events.metadata.detail la entrada y el resultado recortados (y, para
-- trackers.upsert, los valores de antes), para escribir la frase y poder
-- deshacer. Eso incluye datos personales de las tablas (nombres, teléfonos).
-- Ley 1581: se guardan sólo mientras sirven. A los 30 días se quita `detail`
-- de la fila; la fila de auditoría (quién, qué herramienta, cuándo, resultado)
-- se queda. Pasado ese plazo la acción ya no se puede deshacer.
--
-- Mantenimiento de toda la instalación (RPC_TENANCY 'maintenance'): sin
-- argumento de empresa, no devuelve nada de una empresa, sólo un conteo. La
-- llama el barrido diario turn-latency/purge.

create index if not exists audit_events_detail_created_idx
  on public.audit_events (created_at)
  where metadata ? 'detail';

create or replace function public.audit_detail_purge()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_redacted bigint;
begin
  with stripped as (
    update public.audit_events
    set metadata = metadata - 'detail'
    where metadata ? 'detail'
      and created_at < now() - interval '30 days'
    returning 1
  )
  select count(*) into v_redacted from stripped;

  return v_redacted;
end;
$$;

comment on function public.audit_detail_purge() is
  'Retention sweep: strips metadata.detail from audit_events older than 30 days (Ley 1581). Install-wide maintenance — no tenant argument, returns only a count.';

revoke all on function public.audit_detail_purge() from public;
grant execute on function public.audit_detail_purge() to service_role;
