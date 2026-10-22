-- 0239 — Fuentes contables combinadas.
--
-- Una tabla de la empresa (casi siempre una hoja de cálculo conectada, 0161)
-- se declara como FUENTE CONTABLE de un tipo —ventas, compras, pagos
-- recibidos, pagos a proveedores, movimientos, presupuesto— con un mapeo de
-- columnas. Desde ahí alimenta las mismas cifras que el programa contable
-- (cortex.ventas / por_pagar / pagos, cartera, resultados, Hoy) sin sumar dos
-- veces lo que está en los dos lados.
--
--   mapping     { "numero": "factura", "fecha": "fecha", "total": "valor", ... }
--               campo canónico → clave del campo de la tabla (la columna).
--   precedence  'program' (por defecto): si la misma factura (tipo + número +
--               NIT) está en el programa contable, manda el programa.
--               'sheet': la hoja manda sobre el programa.
--               En los dos casos una diferencia de valor se avisa.
--   options     { "currency": "COP", "sumRepeated": false }
--
-- Una tabla puede ser fuente de más de un tipo (una hoja con ventas y compras
-- en pestañas distintas son dos tablas; una sola tabla, dos tipos, también).

create table if not exists public.accounting_sources (
  id              uuid primary key default gen_random_uuid(),
  organization_id text not null,
  tracker_id      uuid not null references public.trackers (id) on delete cascade,
  kind            text not null
                  check (kind in ('ventas', 'compras', 'pagos_recibidos', 'pagos_proveedores', 'movimientos', 'presupuesto')),
  label           text not null check (char_length(btrim(label)) between 1 and 80),
  mapping         jsonb not null default '{}'::jsonb check (jsonb_typeof(mapping) = 'object'),
  precedence      text not null default 'program' check (precedence in ('program', 'sheet')),
  options         jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object'),
  enabled         boolean not null default true,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint accounting_sources_unique unique (organization_id, tracker_id, kind)
);

create index if not exists accounting_sources_org_kind_idx
  on public.accounting_sources (organization_id, kind) where enabled;

comment on table public.accounting_sources is
  'Tablas de la empresa (hojas conectadas u otras) declaradas como fuente contable de un tipo, con el mapeo de columnas y la regla de precedencia frente al programa contable.';

alter table public.accounting_sources enable row level security;
revoke all on table public.accounting_sources from public, anon, authenticated;
grant select, insert, update, delete on table public.accounting_sources to service_role;
