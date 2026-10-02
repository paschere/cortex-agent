-- ===========================================================================
-- LA MEMORIA DEL PULSO: LAS CIFRAS DE CADA DÍA, GUARDADAS
-- ===========================================================================
-- El «Resumen de hoy» del pulso de la empresa (views/pulse.ts) sólo podía decir
-- «frente a ayer» lo que traía fecha de ayer: nada guardaba los totales de
-- ayer, así que «la cartera vencida subió $ 1.200.000 desde ayer» era
-- imposible de afirmar sin inventar. Esta tabla es esa memoria.
--
-- UNA FILA POR VISTA Y DÍA DE BOGOTÁ. Cada vez que corre el resumen del día
-- (views.refresh_summary) o la revisión semanal (views.weekly_review), se
-- guardan las cifras que la vista calculó ese día (`facts`: las mismas que el
-- resumen puede citar — KPIs, puntos de las gráficas, primeras filas de las
-- tablas — con cómo se pintan). Dos corridas el mismo día pisan la misma fila
-- (el índice único decide; un reintento no duplica).
--
-- CON ESO, Y SÓLO CON ESO, SE COMPARA. Las diferencias (hoy menos el último
-- día guardado; hoy menos hace una semana) se calculan en el código y entran
-- a las cifras del resumen como una cifra más, así que la guarda de números
-- sigue sin aceptar nada que no esté ahí.
--
-- RETENCIÓN: unos 400 días (lo borra el mismo escritor al guardar el día; ver
-- views/pulse-snapshots.ts). Un año y un mes alcanza para «frente al mismo mes
-- del año pasado», que es la comparación más larga que un gerente pide.
--
-- Tenencia: `organization_id` en la fila, `tenant()` en tenancy/tables.ts.
-- Sólo service_role: la tabla la toca el servidor, nunca un navegador.

create table if not exists public.pulse_snapshots (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  view_id          uuid not null references public.custom_views (id) on delete cascade,
  -- El día de Bogotá de las cifras.
  day              date not null,
  -- [{ key, label, value, display, format?, period?, goodWhen? }, …]
  facts            jsonb not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint pulse_snapshots_facts_shape check (
    jsonb_typeof(facts) = 'array' and jsonb_array_length(facts) <= 400
  ),
  constraint pulse_snapshots_once unique (organization_id, view_id, day)
);

comment on table public.pulse_snapshots is
  'Las cifras que una vista (el pulso de la empresa) calculó cada día de Bogotá, para que el resumen diario y la revisión semanal digan cuánto cambió algo sin inventarlo. Una fila por vista y día; se guarda unos 400 días.';
comment on column public.pulse_snapshots.facts is
  'Arreglo de cifras { key, label, value, display, format?, period?, goodWhen? } tal como las calculó views/pulse.ts (pulseFacts). Nunca incluye las diferencias: ésas se recalculan al leer.';

alter table public.pulse_snapshots enable row level security;
revoke all on table public.pulse_snapshots from public, anon, authenticated;
grant select, insert, update, delete on table public.pulse_snapshots to service_role;
