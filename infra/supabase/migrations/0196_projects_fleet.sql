-- ===========================================================================
-- ÓRDENES DE SERVICIO Y PROYECTOS · FLOTA Y RUTAS
-- ===========================================================================
-- Dos módulos de operación (0186: `service_orders` y `fleet`) que comparten
-- migración porque comparten la pregunta de fondo: ¿cuánto me cuesta de verdad
-- lo que hago para un cliente, y me deja plata?
--
-- PROYECTOS
--
--   1. `projects` — una orden de servicio o un proyecto para un cliente: código
--      por empresa (OS-0007 / PRY-0007, un solo consecutivo), estado
--
--        cotizado → abierto → en_curso ⇄ en_pausa → terminado → facturado → cerrado
--        (cualquiera antes de facturar) → cancelado
--
--      presupuesto de COSTO y de HORAS, valor del contrato (lo que se le cobra),
--      fechas, responsable y de dónde salió: la cotización o el pedido de
--      ventas (0182), el contrato (0195) o la oportunidad ganada (0193). Estos
--      dos últimos sin llave foránea: son de módulos que se construyen a la vez.
--
--   2. Las TAREAS no tienen tabla propia: son `work_items` (0174) con
--      `project_id`. El registro de trabajo sigue siendo el único sistema de
--      tareas — «Mi semana», las métricas del equipo y el piloto ya las ven.
--
--   3. `time_entries` — horas: quién, qué proyecto (y tarea), qué día, cuántas,
--      si se cobran, y la tarifa de costo y de venta CONGELADAS al registrar
--      (cambiar la tarifa no reescribe la rentabilidad del mes pasado).
--
--   4. `project_rates` — tarifa por hora por persona (y la de la empresa, con
--      `user_id` nulo). Si nómina (0194) trae el costo por hora, lo escribe aquí.
--
--   5. `project_costs` — gastos, subcontratos y materiales que no salen del
--      inventario; un gasto del libro de plata (0172) se ata por
--      `ledger_movement_id` (una sola vez). Los materiales DEL INVENTARIO no se
--      copian: son las salidas de `stock_movements` con `project_id` (§ 7).
--
--   6. `project_milestones` — hitos de facturación: al cumplirse, un pedido y
--      su factura en borrador en ventas (`sales_document_id`).
--
-- FLOTA
--
--   7. `vehicles` (0054) se extiende: tipo, combustible, odómetro, conductor
--      asignado, capacidad del tanque y si es de la flota de la empresa. Las
--      herramientas vehicles.* (RUNT/SIMIT) siguen igual.
--
--   8. `maintenance_plans` — cada cuántos km y/o cada cuántos días (cambio de
--      aceite, llantas, revisión) y cuándo se hizo por última vez.
--   9. `maintenance_events` — lo que se le hizo, con km, costo y taller.
--  10. `fuel_logs` — tanqueos con odómetro, galones y valor: de aquí sale el
--      rendimiento (km/gal) y la alerta de consumo raro.
--  11. `trips` — recorridos: fecha, vehículo, conductor, origen, paradas en
--      orden, destino, km (planeados y reales), peajes y viáticos, guías y
--      pedidos que lleva, y estado.
--
-- Tenencia: `organization_id` en todas, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. RLS encendido sin políticas
-- (deny-all) y sólo service_role. Idempotente.

-- ---------------------------------------------------------------------------
-- 1. Proyectos y órdenes de servicio
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  -- Consecutivo por empresa (uno solo para los dos tipos): OS-0007, PRY-0008.
  number              integer     not null check (number > 0),
  code                text        not null check (char_length(btrim(code)) between 1 and 40),
  kind                text        not null default 'orden_servicio'
                                  check (kind in ('orden_servicio', 'proyecto')),
  title               text        not null check (char_length(btrim(title)) between 1 and 200),
  description         text        check (description is null or char_length(description) <= 4000),
  status              text        not null default 'abierto'
                                  check (status in ('cotizado', 'abierto', 'en_curso', 'en_pausa',
                                                    'terminado', 'facturado', 'cerrado', 'cancelado')),
  -- El cliente del hub (0075); el nombre se copia porque la orden dice para
  -- quién se hizo ESE trabajo aunque el cliente cambie de nombre.
  client_id           uuid        references public.clients(id) on delete set null,
  client_name         text        check (client_name is null or char_length(client_name) <= 200),
  owner_id            uuid        references public.users(id) on delete set null,
  currency            text        not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  -- Presupuesto de COSTO (mano de obra + materiales + gastos) y de HORAS.
  budget_amount       numeric(18,2) check (budget_amount is null or budget_amount >= 0),
  budget_hours        numeric(10,2) check (budget_hours is null or budget_hours >= 0),
  -- Lo que se le cobra al cliente, antes de IVA. Sin él, se usa el total del
  -- pedido o de la cotización atada.
  contract_amount     numeric(18,2) check (contract_amount is null or contract_amount >= 0),
  start_on            date,
  due_on              date,
  finished_on         date,
  -- De dónde salió.
  quote_id            uuid        references public.sales_documents(id) on delete set null,
  sales_order_id      uuid        references public.sales_documents(id) on delete set null,
  contract_id         uuid,
  opportunity_id      uuid,
  origin              text        not null default 'manual'
                                  check (origin in ('manual', 'cotizacion', 'pedido', 'oportunidad', 'chat')),
  -- Gente del proyecto (además del responsable y de quien registra horas).
  team_ids            uuid[]      not null default '{}' check (cardinality(team_ids) <= 100),
  location            text        check (location is null or char_length(location) <= 300),
  notes               text        check (notes is null or char_length(notes) <= 4000),
  created_by          uuid        references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint projects_dates check (due_on is null or start_on is null or due_on >= start_on),
  constraint projects_finished check (
    status not in ('terminado', 'facturado', 'cerrado') or finished_on is not null
  )
);

create unique index if not exists projects_number_uidx
  on public.projects (organization_id, number);
create index if not exists projects_status_idx
  on public.projects (organization_id, status, due_on);
create index if not exists projects_client_idx
  on public.projects (organization_id, client_id) where client_id is not null;
-- Una oportunidad ganada crea UN proyecto (reintentar no duplica).
create unique index if not exists projects_opportunity_uidx
  on public.projects (organization_id, opportunity_id) where opportunity_id is not null;
create index if not exists projects_order_idx
  on public.projects (sales_order_id) where sales_order_id is not null;

comment on table public.projects is
  'Órdenes de servicio y proyectos por cliente: estado, presupuesto de costo y de horas, valor del contrato y de dónde salió (cotización/pedido de ventas, contrato, oportunidad). Tareas = work_items.project_id; horas = time_entries; costos = project_costs + salidas de inventario con project_id. Ver packages/agent-tools/src/projects.';

-- ---------------------------------------------------------------------------
-- 2. Las tareas son el registro de trabajo
-- ---------------------------------------------------------------------------
alter table public.work_items
  add column if not exists project_id uuid references public.projects(id) on delete set null;
create index if not exists work_items_project_idx
  on public.work_items (project_id, status) where project_id is not null;

comment on column public.work_items.project_id is
  'El proyecto u orden de servicio (0196) al que pertenece esta tarea. El registro de trabajo sigue siendo el sistema de tareas.';

-- ---------------------------------------------------------------------------
-- 3. Tarifas por hora
-- ---------------------------------------------------------------------------
create table if not exists public.project_rates (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  -- Nulo = la tarifa por defecto de la empresa.
  user_id             uuid        references public.users(id) on delete cascade,
  cost_rate           numeric(14,2) not null default 0 check (cost_rate >= 0),
  bill_rate           numeric(14,2) check (bill_rate is null or bill_rate >= 0),
  currency            text        not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  -- manual: lo puso una persona. nomina: lo calculó nómina (0194).
  source              text        not null default 'manual' check (source in ('manual', 'nomina')),
  updated_by          uuid        references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists project_rates_person_uidx
  on public.project_rates (organization_id, user_id) where user_id is not null;
create unique index if not exists project_rates_default_uidx
  on public.project_rates (organization_id) where user_id is null;

comment on table public.project_rates is
  'Costo (y precio de venta) por hora de cada persona; la fila con user_id nulo es la de la empresa. Se copia a cada registro de horas al registrarlo.';

-- ---------------------------------------------------------------------------
-- 4. Horas
-- ---------------------------------------------------------------------------
create table if not exists public.time_entries (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  project_id          uuid        not null references public.projects(id) on delete cascade,
  work_item_id        uuid        references public.work_items(id) on delete set null,
  user_id             uuid        references public.users(id) on delete set null,
  -- Quien no tiene cuenta (un técnico de un contratista): su nombre.
  person_label        text        check (person_label is null or char_length(person_label) <= 160),
  worked_on           date        not null,
  hours               numeric(6,2) not null check (hours > 0 and hours <= 24),
  billable            boolean     not null default true,
  -- Congeladas al registrar.
  cost_rate           numeric(14,2) not null default 0 check (cost_rate >= 0),
  bill_rate           numeric(14,2) check (bill_rate is null or bill_rate >= 0),
  note                text        check (note is null or char_length(note) <= 500),
  recorded_by         uuid        references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint time_entries_who check (user_id is not null or person_label is not null)
);

create index if not exists time_entries_project_idx
  on public.time_entries (organization_id, project_id, worked_on desc);
create index if not exists time_entries_person_idx
  on public.time_entries (organization_id, user_id, worked_on desc) where user_id is not null;

comment on table public.time_entries is
  'Horas trabajadas por persona, proyecto (y tarea) y día, con la tarifa de costo y de venta congeladas al registrar. Costo de mano de obra = horas × cost_rate.';

-- ---------------------------------------------------------------------------
-- 5. Costos del proyecto (lo que no son horas ni salidas de inventario)
-- ---------------------------------------------------------------------------
create table if not exists public.project_costs (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  project_id          uuid        not null references public.projects(id) on delete cascade,
  kind                text        not null check (kind in ('material', 'gasto', 'subcontrato', 'otro')),
  description         text        not null check (char_length(btrim(description)) between 1 and 300),
  amount              numeric(18,2) not null check (amount >= 0),
  currency            text        not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  incurred_on         date        not null,
  counterparty        text        check (counterparty is null or char_length(counterparty) <= 200),
  -- Un gasto del libro de plata atado a este proyecto (una sola vez).
  ledger_movement_id  uuid        references public.ledger_movements(id) on delete set null,
  source              text        not null default 'manual' check (source in ('manual', 'libro', 'chat')),
  created_by          uuid        references public.users(id) on delete set null,
  created_at          timestamptz not null default now()
);

create index if not exists project_costs_project_idx
  on public.project_costs (organization_id, project_id, incurred_on desc);
create unique index if not exists project_costs_ledger_uidx
  on public.project_costs (organization_id, ledger_movement_id) where ledger_movement_id is not null;

comment on table public.project_costs is
  'Gastos, subcontratos y materiales comprados para un proyecto. Un gasto del libro de plata se ata una vez (ledger_movement_id). Los materiales del inventario NO van aquí: son stock_movements con project_id.';

-- Materiales del inventario: una salida que dice para qué proyecto fue.
alter table public.stock_movements
  add column if not exists project_id uuid references public.projects(id) on delete set null;
create index if not exists stock_movements_project_idx
  on public.stock_movements (project_id) where project_id is not null;

comment on column public.stock_movements.project_id is
  'El proyecto u orden de servicio (0196) que consumió esta salida: su costo (−qty × unit_cost) es material del proyecto.';

-- ---------------------------------------------------------------------------
-- 6. Hitos de facturación
-- ---------------------------------------------------------------------------
create table if not exists public.project_milestones (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  project_id          uuid        not null references public.projects(id) on delete cascade,
  position            integer     not null default 0,
  title               text        not null check (char_length(btrim(title)) between 1 and 200),
  amount              numeric(18,2) not null check (amount >= 0),
  due_on              date,
  status              text        not null default 'pendiente'
                                  check (status in ('pendiente', 'listo', 'facturado', 'cancelado')),
  -- El pedido (y su factura en borrador) que salió de este hito.
  sales_document_id   uuid        references public.sales_documents(id) on delete set null,
  invoiced_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint project_milestones_invoiced check (status <> 'facturado' or sales_document_id is not null)
);

create index if not exists project_milestones_project_idx
  on public.project_milestones (organization_id, project_id, position);

comment on table public.project_milestones is
  'Hitos de facturación de un proyecto: al cumplirse, un pedido con su factura en borrador en ventas (0182). Emitirla sigue siendo sales.invoice_emit, con aprobación.';

-- ---------------------------------------------------------------------------
-- 7. Vehículos de la flota (0054 extendida)
-- ---------------------------------------------------------------------------
alter table public.vehicles add column if not exists in_fleet boolean not null default false;
alter table public.vehicles add column if not exists vehicle_type text
  check (vehicle_type is null or vehicle_type in ('carro', 'camioneta', 'camion', 'tractomula', 'moto', 'furgon', 'bus', 'otro'));
alter table public.vehicles add column if not exists fuel_type text
  check (fuel_type is null or fuel_type in ('gasolina', 'diesel', 'gas', 'electrico', 'hibrido'));
alter table public.vehicles add column if not exists odometer_km numeric(12,1)
  check (odometer_km is null or odometer_km >= 0);
alter table public.vehicles add column if not exists odometer_on date;
alter table public.vehicles add column if not exists tank_gallons numeric(8,2)
  check (tank_gallons is null or tank_gallons > 0);
alter table public.vehicles add column if not exists driver_user_id uuid
  references public.users(id) on delete set null;
alter table public.vehicles add column if not exists driver_name text
  check (driver_name is null or char_length(driver_name) <= 160);
-- La póliza, el SOAT y la tecnomecánica leídos de documentos viven en
-- `document_expirations` (0184) con `vehicle_id`: no se copian aquí.

create index if not exists vehicles_fleet_idx
  on public.vehicles (organization_id, in_fleet) where in_fleet;

comment on column public.vehicles.in_fleet is
  'Vehículo de la flota de la empresa (0196): sale en /flota con mantenimiento, tanqueos y recorridos. Los demás son placas que alguien vigila para sí.';

-- ---------------------------------------------------------------------------
-- 8. Plan de mantenimiento
-- ---------------------------------------------------------------------------
create table if not exists public.maintenance_plans (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  vehicle_id          uuid        not null references public.vehicles(id) on delete cascade,
  task                text        not null check (char_length(btrim(task)) between 1 and 120),
  every_km            integer     check (every_km is null or every_km > 0),
  every_days          integer     check (every_days is null or every_days between 1 and 3650),
  last_done_km        numeric(12,1) check (last_done_km is null or last_done_km >= 0),
  last_done_on        date,
  active              boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint maintenance_plans_some_interval check (every_km is not null or every_days is not null)
);

create unique index if not exists maintenance_plans_task_uidx
  on public.maintenance_plans (organization_id, vehicle_id, lower(btrim(task)));

comment on table public.maintenance_plans is
  'Mantenimiento preventivo por vehículo: cada cuántos km y/o días, y cuándo se hizo por última vez. Lo que toca se calcula con el odómetro (fleet/math.ts).';

-- ---------------------------------------------------------------------------
-- 9. Mantenimientos hechos
-- ---------------------------------------------------------------------------
create table if not exists public.maintenance_events (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  vehicle_id          uuid        not null references public.vehicles(id) on delete cascade,
  plan_id             uuid        references public.maintenance_plans(id) on delete set null,
  kind                text        not null default 'preventivo'
                                  check (kind in ('preventivo', 'correctivo', 'llantas', 'revision', 'otro')),
  description         text        not null check (char_length(btrim(description)) between 1 and 300),
  done_on             date        not null,
  odometer_km         numeric(12,1) check (odometer_km is null or odometer_km >= 0),
  cost                numeric(18,2) not null default 0 check (cost >= 0),
  vendor              text        check (vendor is null or char_length(vendor) <= 200),
  ledger_movement_id  uuid        references public.ledger_movements(id) on delete set null,
  recorded_by         uuid        references public.users(id) on delete set null,
  created_at          timestamptz not null default now()
);

create index if not exists maintenance_events_vehicle_idx
  on public.maintenance_events (organization_id, vehicle_id, done_on desc);

-- ---------------------------------------------------------------------------
-- 10. Tanqueos
-- ---------------------------------------------------------------------------
create table if not exists public.fuel_logs (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  vehicle_id          uuid        not null references public.vehicles(id) on delete cascade,
  filled_on           date        not null,
  odometer_km         numeric(12,1) check (odometer_km is null or odometer_km >= 0),
  gallons             numeric(10,3) not null check (gallons > 0),
  amount              numeric(18,2) not null check (amount >= 0),
  -- Tanque lleno: sólo entre dos llenos se puede medir el rendimiento.
  full_tank           boolean     not null default true,
  station             text        check (station is null or char_length(station) <= 200),
  driver_user_id      uuid        references public.users(id) on delete set null,
  driver_name         text        check (driver_name is null or char_length(driver_name) <= 160),
  recorded_by         uuid        references public.users(id) on delete set null,
  created_at          timestamptz not null default now()
);

create index if not exists fuel_logs_vehicle_idx
  on public.fuel_logs (organization_id, vehicle_id, filled_on desc);

comment on table public.fuel_logs is
  'Tanqueos con odómetro, galones y valor. El rendimiento (km/gal) se mide entre tanques llenos y el consumo raro se marca contra la mediana del mismo vehículo (fleet/math.ts).';

-- ---------------------------------------------------------------------------
-- 11. Recorridos y rutas
-- ---------------------------------------------------------------------------
create table if not exists public.trips (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  vehicle_id          uuid        references public.vehicles(id) on delete set null,
  trip_on             date        not null,
  driver_user_id      uuid        references public.users(id) on delete set null,
  driver_name         text        check (driver_name is null or char_length(driver_name) <= 160),
  origin              text        check (origin is null or char_length(origin) <= 300),
  destination         text        check (destination is null or char_length(destination) <= 300),
  -- Paradas en orden: [{ "place": "...", "note": "..." }].
  stops               jsonb       not null default '[]'::jsonb check (jsonb_typeof(stops) = 'array'),
  planned_km          numeric(10,1) check (planned_km is null or planned_km >= 0),
  -- De dónde salió planned_km: a mano o del proveedor de rutas.
  planned_source      text        check (planned_source is null or planned_source in ('manual', 'proveedor')),
  start_km            numeric(12,1) check (start_km is null or start_km >= 0),
  end_km              numeric(12,1) check (end_km is null or end_km >= 0),
  km                  numeric(10,1) check (km is null or km >= 0),
  tolls               numeric(18,2) not null default 0 check (tolls >= 0),
  other_costs         numeric(18,2) not null default 0 check (other_costs >= 0),
  status              text        not null default 'planeado'
                                  check (status in ('planeado', 'en_ruta', 'completado', 'cancelado')),
  -- Lo que lleva: guías (texto libre: números de guía), un pedido, un proyecto.
  guide_refs          text[]      not null default '{}' check (cardinality(guide_refs) <= 200),
  sales_document_id   uuid        references public.sales_documents(id) on delete set null,
  project_id          uuid        references public.projects(id) on delete set null,
  note                text        check (note is null or char_length(note) <= 1000),
  recorded_by         uuid        references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint trips_odometer check (start_km is null or end_km is null or end_km >= start_km)
);

create index if not exists trips_org_day_idx
  on public.trips (organization_id, trip_on desc);
create index if not exists trips_vehicle_idx
  on public.trips (organization_id, vehicle_id, trip_on desc) where vehicle_id is not null;

comment on table public.trips is
  'Recorridos: vehículo, conductor, origen, paradas en orden, destino, km planeados (a mano o del proveedor de rutas) y reales, peajes y viáticos, guías/pedido/proyecto que lleva, y estado.';

-- ---------------------------------------------------------------------------
-- 12. updated_at
-- ---------------------------------------------------------------------------
drop trigger if exists projects_touch_updated_at on public.projects;
create trigger projects_touch_updated_at
  before update on public.projects
  for each row execute function public.touch_updated_at();

drop trigger if exists project_rates_touch_updated_at on public.project_rates;
create trigger project_rates_touch_updated_at
  before update on public.project_rates
  for each row execute function public.touch_updated_at();

drop trigger if exists time_entries_touch_updated_at on public.time_entries;
create trigger time_entries_touch_updated_at
  before update on public.time_entries
  for each row execute function public.touch_updated_at();

drop trigger if exists project_milestones_touch_updated_at on public.project_milestones;
create trigger project_milestones_touch_updated_at
  before update on public.project_milestones
  for each row execute function public.touch_updated_at();

drop trigger if exists maintenance_plans_touch_updated_at on public.maintenance_plans;
create trigger maintenance_plans_touch_updated_at
  before update on public.maintenance_plans
  for each row execute function public.touch_updated_at();

drop trigger if exists trips_touch_updated_at on public.trips;
create trigger trips_touch_updated_at
  before update on public.trips
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 13. Acceso: sólo el servidor
-- ---------------------------------------------------------------------------
alter table public.projects           enable row level security;
alter table public.project_rates      enable row level security;
alter table public.time_entries       enable row level security;
alter table public.project_costs      enable row level security;
alter table public.project_milestones enable row level security;
alter table public.maintenance_plans  enable row level security;
alter table public.maintenance_events enable row level security;
alter table public.fuel_logs          enable row level security;
alter table public.trips              enable row level security;

revoke all on table public.projects           from public, anon, authenticated;
revoke all on table public.project_rates      from public, anon, authenticated;
revoke all on table public.time_entries       from public, anon, authenticated;
revoke all on table public.project_costs      from public, anon, authenticated;
revoke all on table public.project_milestones from public, anon, authenticated;
revoke all on table public.maintenance_plans  from public, anon, authenticated;
revoke all on table public.maintenance_events from public, anon, authenticated;
revoke all on table public.fuel_logs          from public, anon, authenticated;
revoke all on table public.trips              from public, anon, authenticated;

grant select, insert, update, delete on table public.projects           to service_role;
grant select, insert, update, delete on table public.project_rates      to service_role;
grant select, insert, update, delete on table public.time_entries       to service_role;
grant select, insert, update, delete on table public.project_costs      to service_role;
grant select, insert, update, delete on table public.project_milestones to service_role;
grant select, insert, update, delete on table public.maintenance_plans  to service_role;
grant select, insert, update, delete on table public.maintenance_events to service_role;
grant select, insert, update, delete on table public.fuel_logs          to service_role;
grant select, insert, update, delete on table public.trips              to service_role;
