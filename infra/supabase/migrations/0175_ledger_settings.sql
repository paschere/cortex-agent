-- ===========================================================================
-- LA CAJA MÍNIMA DE CADA EMPRESA
-- ===========================================================================
-- La proyección de caja (packages/agent-tools/src/ledger/forecast.ts) mide
-- todo contra un piso: «la caja aguanta 6 semanas antes de bajar de…». Hasta
-- hoy ese piso era, si nadie decía otra cosa, un mes de gastos fijos, y quien
-- quería otro tenía que escribirlo cada vez (`?minimo=` en /finance, o
-- decírselo al chat en cada pregunta). Pero la caja mínima con la que una
-- empresa está tranquila es una decisión de la empresa, no de la pregunta:
-- «avísame si la caja baja de 20 millones» tiene que valer mañana, en el
-- centro de mando, en el pulso y en la revisión semanal.
--
-- `ledger_settings`: una fila por empresa con esa caja mínima y su moneda.
-- La escribe sólo quien administra la empresa o es su dueño (la regla está en
-- packages/agent-tools/src/ledger/plans.ts `saveLedgerSettings`, que llaman
-- la herramienta `ledger.set_minimum_cash` y la acción de /finance; las dos
-- revisan el permiso en el servidor). `minimum_cash` nulo = sin decidir: el
-- motor vuelve a un mes de gastos fijos, como antes.
--
-- Tenencia: `organization_id` es la llave, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. Sólo service_role.

create table if not exists public.ledger_settings (
  organization_id  text primary key,
  -- La caja con la que la empresa está tranquila. Nulo = sin decidir.
  minimum_cash     numeric(18,2) check (minimum_cash is null or (minimum_cash >= 0 and minimum_cash <= 1e13)),
  currency         text not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  updated_by       uuid references public.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.ledger_settings is
  'Por empresa: la caja mínima con la que está tranquila (y su moneda). La proyección de caja, el centro de mando, el pulso y la revisión semanal miden contra ella; nula = un mes de gastos fijos. La cambia quien administra o es dueño (ledger/plans.ts saveLedgerSettings).';

-- ---------------------------------------------------------------------------
-- Acceso
-- ---------------------------------------------------------------------------
alter table public.ledger_settings enable row level security;

revoke all on table public.ledger_settings from public, anon, authenticated;

grant select, insert, update, delete on table public.ledger_settings to service_role;
