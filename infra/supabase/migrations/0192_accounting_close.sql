-- ===========================================================================
-- REGISTRAR EN EL PROGRAMA CONTABLE Y CERRAR EL MES
-- ===========================================================================
-- Hasta aquí Cortex LEÍA el programa contable (0165) y sólo escribía una cosa
-- en él: la factura electrónica de venta (0182). Lo que una empresa le paga a
-- un contador cada mes es, sobre todo, pasar al programa lo que ya pasó en el
-- banco y en el correo, y después «cerrar el mes». Esta migración guarda lo
-- que hace falta para las dos cosas:
--
--   1. `accounting_account_map` — el plan de cuentas (PUC) de la empresa como
--      Cortex lo necesita para escribir: a qué cuenta va cada categoría del
--      libro de plata, cada proveedor y cada papel fijo (proveedores
--      nacionales, retenciones, IVA descontable, bancos, clientes), con su
--      centro de costo y, por programa, el id de la cuenta allá (Alegra y
--      QuickBooks no reciben el código PUC sino su propio id). Sin fila, el
--      defecto del código (packages/agent-tools/src/close/writeback/mapping.ts).
--
--   2. `accounting_writebacks` — cada escritura en el programa: causar una
--      factura de proveedor (Siigo compra / Alegra bill / QuickBooks Bill),
--      registrar un recibo de caja (pago recibido de un cliente) o registrar
--      el pago a un proveedor. UNA por (empresa, clase, origen): pedirla dos
--      veces no la manda dos veces. Siempre la aprueba una persona después de
--      ver la vista previa; nunca corre desatendida. Guarda lo que se mandó,
--      lo que el programa devolvió (su id y número) y, si la red se cortó a
--      mitad, `incierta`: no se reintenta sola.
--
--        pendiente → enviando → registrada
--                       └────→ error (el programa la rechazó: se corrige y se repite)
--                       └────→ incierta (no se sabe si llegó: revisar antes)
--        cualquiera salvo registrada → descartada (se hace a mano en el programa)
--
--   3. `close_periods` + `close_tasks` — el cierre de cada mes: abierto →
--      en_cierre → cerrado, y su lista guiada. Cada tarea se revisa sola
--      contra los datos (`auto_check`: extractos importados hasta fin de mes,
--      movimientos del banco sin conciliar, facturas sin aprobar o sin causar,
--      recibos sin registrar, movimientos sin categoría, nómina, impuestos,
--      conteo de inventario) y una persona puede darla por hecha con evidencia
--      («explicado») o por no aplica. Cerrar un mes BLOQUEA los cambios de
--      Cortex en ese mes (anotar o recategorizar movimientos, escribir en el
--      programa con fecha de ese mes); un administrador puede abrir una
--      ventana de cambios con motivo (`override_until`), y queda registrado.
--
--   4. `close_events` — la bitácora del cierre: cerrar, reabrir, abrir una
--      ventana de cambios, marcar una tarea. Quién, cuándo y por qué.
--
-- Tenencia: `organization_id` en todas, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. RLS encendido sin políticas
-- (deny-all) y sólo service_role. Idempotente.

-- ---------------------------------------------------------------------------
-- 1. El plan de cuentas que usa Cortex para escribir
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_account_map (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  -- categoria: una categoría del libro de plata («arriendo»);
  -- proveedor: un proveedor (`suppliers.id`), manda sobre su categoría;
  -- rol: un papel fijo de la partida («proveedores», «retefuente», «banco:<cuenta>»…).
  scope             text        not null check (scope in ('categoria', 'proveedor', 'rol')),
  key               text        not null check (char_length(btrim(key)) between 2 and 120),
  -- Código PUC (cuenta, subcuenta o auxiliar): 4 a 10 dígitos.
  account_code      text        not null check (account_code ~ '^[0-9]{4,10}$'),
  account_name      text        check (account_name is null or char_length(account_name) <= 160),
  cost_center       text        check (cost_center is null or char_length(cost_center) <= 40),
  -- { "alegra": "5063", "quickbooks": "91" }: el id de la cuenta EN el programa
  -- cuando no se puede encontrar por el código.
  provider_refs     jsonb       not null default '{}'::jsonb check (jsonb_typeof(provider_refs) = 'object'),
  updated_by        uuid        references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint accounting_account_map_once unique (organization_id, scope, key)
);

comment on table public.accounting_account_map is
  'A qué cuenta del PUC (y centro de costo) va cada categoría, proveedor o papel fijo cuando Cortex escribe en el programa contable. Sin fila, el defecto del código (close/writeback/mapping.ts). Lo edita quien administra en /cierre.';

-- ---------------------------------------------------------------------------
-- 2. Cada escritura en el programa contable
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_writebacks (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  kind              text        not null check (kind in ('compra', 'recibo', 'pago_proveedor')),
  -- compra y pago_proveedor: `payable_invoices.id`; recibo: `payments.id`.
  source_table      text        not null check (source_table in ('payable_invoices', 'payments')),
  source_id         uuid        not null,
  provider          text        not null check (provider in ('siigo', 'alegra', 'quickbooks')),
  connection_id     uuid        references public.accounting_connections(id) on delete set null,
  status            text        not null default 'pendiente'
                                check (status in ('pendiente', 'enviando', 'registrada', 'error', 'incierta', 'descartada')),
  -- La fecha del documento contable: decide en qué mes cae (y si está cerrado).
  doc_date          date        not null,
  amount            numeric(18,2) check (amount is null or amount >= 0),
  currency          text        check (currency is null or currency ~ '^[A-Z]{3}$'),
  counterparty_name text        check (counterparty_name is null or char_length(counterparty_name) <= 200),
  label             text        not null check (char_length(btrim(label)) between 1 and 300),
  -- Lo que se mandó (o se mandaría), tal cual.
  payload           jsonb       check (payload is null or jsonb_typeof(payload) = 'object'),
  -- La partida en palabras: cuentas, débitos y créditos, lo que la persona aprobó.
  preview           jsonb       check (preview is null or jsonb_typeof(preview) = 'object'),
  -- Siigo: cabecera Idempotency-Key; QuickBooks: ?requestid=. Estable por origen.
  idempotency_key   text        not null check (char_length(idempotency_key) between 8 and 60),
  provider_id       text        check (provider_id is null or char_length(provider_id) <= 120),
  provider_number   text        check (provider_number is null or char_length(provider_number) <= 120),
  -- Lo último que se supo del documento en el programa (anulado, saldado…).
  provider_status   text        check (provider_status is null or char_length(provider_status) <= 80),
  error             text        check (error is null or char_length(error) <= 2000),
  attempts          integer     not null default 0 check (attempts >= 0),
  attempted_at      timestamptz,
  registered_at     timestamptz,
  reconciled_at     timestamptz,
  approved_by       uuid        references public.users(id) on delete set null,
  discarded_by      uuid        references public.users(id) on delete set null,
  discard_reason    text        check (discard_reason is null or char_length(discard_reason) <= 500),
  created_by        uuid        references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint accounting_writebacks_once unique (organization_id, kind, source_id),
  constraint accounting_writebacks_registered_has_id check (
    status <> 'registrada' or (provider_id is not null and registered_at is not null)
  ),
  constraint accounting_writebacks_source_pair check (
    (kind = 'recibo') = (source_table = 'payments')
  )
);

create index if not exists accounting_writebacks_status_idx
  on public.accounting_writebacks (organization_id, status, doc_date desc);
create index if not exists accounting_writebacks_period_idx
  on public.accounting_writebacks (organization_id, doc_date);

comment on table public.accounting_writebacks is
  'Cada escritura de Cortex en el programa contable (causar una compra, registrar un recibo de caja o un pago a proveedor), una por origen. Siempre aprobada por una persona tras la vista previa; idempotente por (empresa, clase, origen) y por la llave que se le manda al programa.';

-- ---------------------------------------------------------------------------
-- 3. El cierre de cada mes y su lista
-- ---------------------------------------------------------------------------
create table if not exists public.close_periods (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  period            text        not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status            text        not null default 'abierto' check (status in ('abierto', 'en_cierre', 'cerrado')),
  started_by        uuid        references public.users(id) on delete set null,
  started_at        timestamptz,
  closed_by         uuid        references public.users(id) on delete set null,
  closed_at         timestamptz,
  reopened_by       uuid        references public.users(id) on delete set null,
  reopened_at       timestamptz,
  reopen_reason     text        check (reopen_reason is null or char_length(reopen_reason) <= 500),
  -- Ventana de cambios en un mes cerrado, abierta por un administrador.
  override_until    timestamptz,
  override_by       uuid        references public.users(id) on delete set null,
  override_reason   text        check (override_reason is null or char_length(override_reason) <= 500),
  -- La foto al cerrar: tareas, cifras, quién; de aquí sale el PDF.
  summary           jsonb       not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint close_periods_once unique (organization_id, period),
  constraint close_periods_closed_has_when check (status <> 'cerrado' or closed_at is not null),
  constraint close_periods_override_has_who check (
    override_until is null or (override_by is not null and override_reason is not null)
  )
);

create index if not exists close_periods_org_period_idx
  on public.close_periods (organization_id, period desc);

comment on table public.close_periods is
  'El cierre de cada mes de una empresa: abierto, en cierre o cerrado. Cerrado bloquea los cambios de Cortex con fecha de ese mes, salvo una ventana de cambios abierta por un administrador (override_until), que queda en close_events.';

create table if not exists public.close_tasks (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  period_id         uuid        not null references public.close_periods(id) on delete cascade,
  period            text        not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  key               text        not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  title             text        not null check (char_length(btrim(title)) between 2 and 200),
  -- pendiente: falta; hecha: una persona la dio por hecha (o explicada);
  -- no_aplica: este mes no corre. La revisión automática NO escribe aquí.
  status            text        not null default 'pendiente' check (status in ('pendiente', 'hecha', 'no_aplica')),
  owner_id          uuid        references public.users(id) on delete set null,
  evidence          text        check (evidence is null or char_length(evidence) <= 2000),
  evidence_url      text        check (evidence_url is null or (char_length(evidence_url) <= 1000 and evidence_url ~ '^https?://')),
  -- { "state": "ok|pendiente|no_aplica|error", "count": 3, "detail": "…" }
  auto_check        jsonb       check (auto_check is null or jsonb_typeof(auto_check) = 'object'),
  auto_checked_at   timestamptz,
  done_by           uuid        references public.users(id) on delete set null,
  done_at           timestamptz,
  position          integer     not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint close_tasks_once unique (organization_id, period, key),
  constraint close_tasks_done_has_who check (status = 'pendiente' or done_at is not null)
);

create index if not exists close_tasks_period_idx
  on public.close_tasks (organization_id, period_id, position);

comment on table public.close_tasks is
  'La lista guiada del cierre de un mes: cada tarea con su revisión automática contra los datos (auto_check), su responsable y la evidencia de quien la dio por hecha.';

create table if not exists public.close_events (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  period            text        not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  kind              text        not null check (kind in ('cerrado', 'reabierto', 'ventana', 'tarea', 'bloqueado')),
  user_id           uuid        references public.users(id) on delete set null,
  detail            text        check (detail is null or char_length(detail) <= 1000),
  metadata          jsonb       not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at        timestamptz not null default now()
);

create index if not exists close_events_org_period_idx
  on public.close_events (organization_id, period, created_at desc);

comment on table public.close_events is
  'Bitácora del cierre: cerrar, reabrir, abrir una ventana de cambios en un mes cerrado, marcar una tarea, y los intentos de cambio que el cierre detuvo.';

-- ---------------------------------------------------------------------------
-- 4. Acceso: sólo el servidor
-- ---------------------------------------------------------------------------
alter table public.accounting_account_map enable row level security;
alter table public.accounting_writebacks  enable row level security;
alter table public.close_periods          enable row level security;
alter table public.close_tasks            enable row level security;
alter table public.close_events           enable row level security;

revoke all on table public.accounting_account_map from public, anon, authenticated;
revoke all on table public.accounting_writebacks  from public, anon, authenticated;
revoke all on table public.close_periods          from public, anon, authenticated;
revoke all on table public.close_tasks            from public, anon, authenticated;
revoke all on table public.close_events           from public, anon, authenticated;

grant select, insert, update, delete on table public.accounting_account_map to service_role;
grant select, insert, update, delete on table public.accounting_writebacks  to service_role;
grant select, insert, update, delete on table public.close_periods          to service_role;
grant select, insert, update, delete on table public.close_tasks            to service_role;
grant select, insert, update, delete on table public.close_events           to service_role;
