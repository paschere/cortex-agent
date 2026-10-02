-- ===========================================================================
-- LOS PLANES SOBRE EL LIBRO DE PLATA: ESCENARIOS, RECURRENTES Y FACTURAS
-- POR PAGAR QUE EL BANCO YA PAGÓ
-- ===========================================================================
-- La proyección de caja a 13 semanas (packages/agent-tools/src/ledger/
-- forecast.ts) es pura: entra el libro (0172), sale la tabla de semanas. Lo
-- que una persona DECIDE sobre ella tiene que quedar guardado para la próxima
-- vez que alguien la abra, y eso es esta migración:
--
-- 1. ESCENARIOS GUARDADOS (`ledger_scenarios`). «¿Y si Nexa paga un mes
--    tarde?», «¿y si contrato dos personas?»: una etiqueta y la lista de
--    ajustes (el `ScenarioAdjustment[]` de ledger/types.ts, tal cual). Un
--    escenario no cambia el libro: se aplica encima de la proyección base
--    cuando alguien lo pide. La etiqueta es única por empresa (sin mayúsculas
--    ni espacios de más): guardar otra vez «Nexa se atrasa» lo reemplaza.
--
-- 2. LO QUE SE REPITE, DICHO POR UNA PERSONA (`ledger_recurring`). Tres clases
--    de fila, por `status`:
--      · 'declared'  un ingreso o gasto que se repite y que la persona dijo
--                    («el crédito de Bancolombia, 2 M el 28 de cada mes»). Se
--                    SUMA a lo que el motor detecta del historial; si hablan
--                    de lo mismo, manda lo declarado.
--      · 'confirmed' un recurrente DETECTADO que la persona confirmó.
--      · 'ignored'   un recurrente DETECTADO que la persona dijo que no se
--                    repite (un gasto de una sola vez que parecía mensual). No
--                    entra en la proyección.
--    Las decisiones sobre lo detectado se atan por `detected_key`, la llave
--    estable que el motor le pone a cada recurrente detectado (contraparte o
--    firma, periodicidad y día; ledger/recurring.ts), para que la decisión siga
--    valiendo cuando el historial avance. Una sola decisión por llave y
--    empresa. Se guardan también los campos del recurrente (etiqueta, monto,
--    día…) como estaban al decidir, para mostrarlo aunque ya no se detecte.
--
-- 3. FACTURAS POR PAGAR SALDADAS POR EL BANCO (`ledger_movements.settled_by`).
--    Una factura de proveedor abierta y una salida del extracto por el mismo
--    valor (±1%), a la misma contraparte (NIT o nombre), después de emitida,
--    son el mismo pago: la factura queda saldada (`status = 'settled'`) y
--    `settled_by` apunta a la salida del banco que la pagó. Así una factura
--    que ya se pagó no se queda en la proyección como «por pagar» para
--    siempre. Es REVERSIBLE: si la salida deja de contar (se anuló, resultó
--    duplicada, una persona lo dice), la factura vuelve a estar abierta con
--    el saldo que tenía (`settled_by_outstanding`). Una fuente que vuelve a
--    traer la factura abierta (el programa contable que todavía no registra
--    el pago) no deshace el saldado: manda el banco. Reglas en
--    packages/agent-tools/src/ledger/payables.ts.
--
-- Tenencia: `organization_id` en las dos tablas nuevas, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. Sólo service_role.

-- ---------------------------------------------------------------------------
-- Escenarios guardados
-- ---------------------------------------------------------------------------
create table public.ledger_scenarios (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  label            text not null check (char_length(btrim(label)) between 1 and 80),
  -- La etiqueta normalizada (minúsculas, espacios simples): la identidad.
  label_key        text not null check (char_length(label_key) between 1 and 80),
  -- ScenarioAdjustment[] (ledger/types.ts). La forma la valida la aplicación;
  -- aquí sólo que sea una lista corta.
  adjustments      jsonb not null default '[]'::jsonb
                   check (jsonb_typeof(adjustments) = 'array' and jsonb_array_length(adjustments) <= 20),
  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint ledger_scenarios_label_once unique (organization_id, label_key)
);

comment on table public.ledger_scenarios is
  'Escenarios guardados sobre la proyección de caja («¿y si Nexa paga un mes tarde?»): una etiqueta y la lista de ajustes (ScenarioAdjustment[] de ledger/types.ts). No cambian el libro; se aplican encima de la proyección base cuando alguien los pide.';

-- ---------------------------------------------------------------------------
-- Lo que se repite: declarado, confirmado o ignorado
-- ---------------------------------------------------------------------------
create table public.ledger_recurring (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    text not null,
  status             text not null check (status in ('declared', 'confirmed', 'ignored')),
  -- La llave estable del recurrente detectado al que se refiere la decisión.
  -- Obligatoria para confirmar o ignorar; opcional para lo declarado.
  detected_key       text check (detected_key is null or char_length(detected_key) between 1 and 80),
  label              text not null check (char_length(btrim(label)) between 1 and 120),
  direction          text not null check (direction in ('in', 'out')),
  amount             numeric(18,2) not null check (amount > 0),
  currency           text not null check (currency ~ '^[A-Z]{3}$'),
  every              text not null check (every in ('week', 'month')),
  -- Día del mes (1–31) o de la semana (1 = lunes … 7 = domingo).
  anchor             smallint not null check (anchor between 1 and 31),
  category           text check (category is null or category ~ '^[a-z][a-z0-9_]{1,39}$'),
  counterparty_name  text check (counterparty_name is null or char_length(counterparty_name) <= 200),
  created_by         uuid,
  updated_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint ledger_recurring_decision_needs_key check (
    status = 'declared' or detected_key is not null
  ),
  constraint ledger_recurring_weekday check (every = 'month' or anchor between 1 and 7)
);

-- Una sola decisión por recurrente detectado.
create unique index ledger_recurring_detected_once
  on public.ledger_recurring (organization_id, detected_key)
  where detected_key is not null;

comment on table public.ledger_recurring is
  'Lo que se repite según una persona: declared (lo dijo; se suma a lo detectado y manda cuando hablan de lo mismo), confirmed / ignored (su decisión sobre un recurrente que el motor detectó, atada por detected_key). Lo ignorado no entra en la proyección de caja.';

-- ---------------------------------------------------------------------------
-- Facturas por pagar saldadas por una salida del banco
-- ---------------------------------------------------------------------------
alter table public.ledger_movements
  add column settled_by uuid references public.ledger_movements (id) on delete set null,
  -- El saldo pendiente que tenía la factura antes de saldarla: para devolverlo
  -- intacto si el saldado se deshace.
  add column settled_by_outstanding numeric(18,2)
    check (settled_by_outstanding is null or settled_by_outstanding >= 0),
  add constraint ledger_movements_settled_by_payables check (
    settled_by is null or (kind = 'payable' and settled_by <> id)
  );

-- Cada salida del banco salda a lo sumo una factura.
create unique index ledger_movements_settled_by_once
  on public.ledger_movements (organization_id, settled_by)
  where settled_by is not null;

comment on column public.ledger_movements.settled_by is
  'En una factura por pagar: la salida del banco (otra fila del libro) que la pagó, encontrada por contraparte, valor (±1%) y fecha (ledger/payables.ts). Reversible: si esa salida deja de contar, la factura vuelve a estar abierta con settled_by_outstanding.';

-- ---------------------------------------------------------------------------
-- Acceso
-- ---------------------------------------------------------------------------
alter table public.ledger_scenarios  enable row level security;
alter table public.ledger_recurring  enable row level security;

revoke all on table public.ledger_scenarios  from public, anon, authenticated;
revoke all on table public.ledger_recurring  from public, anon, authenticated;

grant select, insert, update, delete on table public.ledger_scenarios  to service_role;
grant select, insert, update, delete on table public.ledger_recurring  to service_role;
