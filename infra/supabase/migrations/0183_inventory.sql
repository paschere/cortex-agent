-- ===========================================================================
-- INVENTARIO Y COMPRAS: DE LA EXISTENCIA A LA ORDEN DE COMPRA RECIBIDA
-- ===========================================================================
-- Hasta aquí Cortex sabía de productos sólo como filas de una tabla («Productos
-- (Siigo)», 0165): nombre, precio y unas existencias que el programa contable
-- decía. Nadie podía preguntar «¿qué tengo que pedir esta semana?» ni dejar una
-- orden de compra lista para aprobar. Esta migración le da al inventario su
-- propio libro:
--
--   1. `products` — el catálogo con lo que hace falta para reponer: costo
--      (promedio ponderado, lo mantiene packages/agent-tools/src/inventory),
--      precio, mínimo, cantidad a pedir, días de entrega y proveedor habitual.
--      Cada producto dice de dónde salió (a mano, hoja, programa contable) y,
--      si viene de un programa, su id allá (`source_system` + `source_ref`):
--      re-importar actualiza, no duplica.
--
--   2. `stock_locations` — las bodegas. Una por defecto por empresa.
--
--   3. `stock_movements` — EL LIBRO. Las existencias no se guardan: se suman.
--      Cada fila es una entrada, una salida, un ajuste o una pata de un
--      traslado, con su cantidad CON SIGNO, su costo y su referencia (orden de
--      compra, venta/factura, manual, conteo, sincronización, importación). Lo
--      que dice el programa contable entra como un ajuste por la diferencia, así
--      que la suma siempre cuadra con lo último que se supo y la historia queda.
--
--   4. `stock_levels` — vista: la suma del libro por producto y bodega.
--
--   5. `purchase_orders` + `purchase_order_lines` — la orden de compra:
--
--        borrador → por_aprobar → aprobada → enviada → recibida_parcial
--                                                    → recibida → facturada → cerrada
--        (cualquiera antes de recibir) → cancelada
--
--      El proveedor es `public.suppliers` (0181, cuentas por pagar): una sola
--      lista de a quién se le paga. La factura del proveedor (0181) se ata a la
--      orden (`payable_id`) y desde ahí la orden queda facturada. Mientras no
--      llega la factura, la orden aprobada vive en el libro de plata como un
--      «por pagar» esperado (fuente manual · «orden de compra»): la proyección
--      de caja ve las compras comprometidas.
--
-- Tenencia: `organization_id` en todas, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts (la vista también: lleva la
-- columna). RLS deny-all + service_role. Idempotente.

-- ---------------------------------------------------------------------------
-- 1. Bodegas
-- ---------------------------------------------------------------------------
create table if not exists public.stock_locations (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  text        not null references public.ba_organization(id) on delete cascade,
  name             text        not null check (char_length(btrim(name)) between 1 and 120),
  code             text        check (code is null or char_length(code) <= 40),
  address          text        check (address is null or char_length(address) <= 300),
  is_default       boolean     not null default false,
  active           boolean     not null default true,
  -- La bodega del programa contable (Siigo/Alegra traen bodegas por producto).
  source_system    text        check (source_system is null or source_system in ('siigo', 'alegra', 'quickbooks')),
  source_ref       text        check (source_ref is null or char_length(source_ref) <= 120),
  created_by       uuid        references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint stock_locations_source_pair check ((source_system is null) = (source_ref is null))
);

-- Una sola bodega por defecto por empresa.
create unique index if not exists stock_locations_default_uidx
  on public.stock_locations (organization_id) where is_default;
create unique index if not exists stock_locations_name_uidx
  on public.stock_locations (organization_id, lower(btrim(name)));
create unique index if not exists stock_locations_source_uidx
  on public.stock_locations (organization_id, source_system, source_ref) where source_system is not null;

comment on table public.stock_locations is
  'Bodegas de la empresa. Una por defecto (is_default). Las del programa contable llevan source_system + source_ref.';

-- ---------------------------------------------------------------------------
-- 2. Productos
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  sku                 text        check (sku is null or char_length(btrim(sku)) between 1 and 60),
  name                text        not null check (char_length(btrim(name)) between 1 and 200),
  unit                text        not null default 'und' check (char_length(btrim(unit)) between 1 and 30),
  category            text        check (category is null or char_length(category) <= 120),
  -- Un servicio o un combo no lleva existencias: se lista pero no se repone.
  track_stock         boolean     not null default true,
  currency            text        not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  -- Costo promedio ponderado por unidad. Lo recalcula cada entrada con costo.
  cost                numeric(18,4) check (cost is null or cost >= 0),
  price               numeric(18,4) check (price is null or price >= 0),
  min_stock           numeric(18,4) check (min_stock is null or min_stock >= 0),
  reorder_qty         numeric(18,4) check (reorder_qty is null or reorder_qty > 0),
  lead_time_days      integer     check (lead_time_days is null or lead_time_days between 0 and 365),
  preferred_supplier_id uuid      references public.suppliers(id) on delete set null,
  -- De dónde salió: manual, hoja/CSV, programa contable.
  source              text        not null default 'manual' check (source in ('manual', 'sheet', 'accounting')),
  source_system       text        check (source_system is null or source_system in ('siigo', 'alegra', 'quickbooks')),
  source_ref          text        check (source_ref is null or char_length(source_ref) <= 120),
  -- Quién tiene la verdad de las existencias: el libro de Cortex, o el
  -- programa contable (cada sincronización ajusta por la diferencia).
  stock_from          text        not null default 'cortex' check (stock_from in ('cortex', 'accounting')),
  active              boolean     not null default true,
  notes               text        check (notes is null or char_length(notes) <= 2000),
  created_by          uuid        references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint products_source_pair check ((source_system is null) = (source_ref is null)),
  constraint products_accounting_stock check (stock_from = 'cortex' or source_system is not null)
);

-- Un código, un producto (sin distinguir mayúsculas).
create unique index if not exists products_sku_uidx
  on public.products (organization_id, lower(btrim(sku))) where sku is not null;
create unique index if not exists products_source_uidx
  on public.products (organization_id, source_system, source_ref) where source_system is not null;
create index if not exists products_org_name_idx
  on public.products (organization_id, lower(name));
create index if not exists products_supplier_idx
  on public.products (preferred_supplier_id) where preferred_supplier_id is not null;

comment on table public.products is
  'Catálogo de inventario: costo promedio ponderado, precio, mínimo, cantidad a pedir, días de entrega y proveedor habitual. Las existencias NO viven aquí: son la suma de stock_movements (vista stock_levels).';

-- ---------------------------------------------------------------------------
-- 3. Órdenes de compra (antes que los movimientos: una entrada la nombra)
-- ---------------------------------------------------------------------------
create table if not exists public.purchase_orders (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  -- Consecutivo por empresa: OC-0001.
  number              integer     not null check (number > 0),
  supplier_id         uuid        references public.suppliers(id) on delete set null,
  -- Lo que decía el proveedor cuando se hizo la orden: la orden es un papel.
  supplier_name       text        not null check (char_length(btrim(supplier_name)) between 1 and 200),
  supplier_tax_id     text        check (supplier_tax_id is null or supplier_tax_id ~ '^[0-9]{3,15}$'),
  supplier_email      text        check (supplier_email is null or char_length(supplier_email) <= 200),
  status              text        not null default 'borrador'
                                  check (status in ('borrador', 'por_aprobar', 'aprobada', 'enviada',
                                                    'recibida_parcial', 'recibida', 'facturada', 'cerrada', 'cancelada')),
  currency            text        not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  subtotal            numeric(18,2) not null default 0 check (subtotal >= 0),
  tax_total           numeric(18,2) not null default 0 check (tax_total >= 0),
  total               numeric(18,2) not null default 0 check (total >= 0),
  -- Cuándo debería llegar y a qué bodega.
  expected_on         date,
  location_id         uuid        references public.stock_locations(id) on delete set null,
  -- Plazo de pago en días: de aquí sale el vencimiento esperado en el libro.
  payment_terms_days  integer     not null default 30 check (payment_terms_days between 0 and 365),
  notes               text        check (notes is null or char_length(notes) <= 2000),
  -- Cómo nació: a mano, de las sugerencias de reposición, del chat, del piloto.
  origin              text        not null default 'manual' check (origin in ('manual', 'sugerencia', 'chat', 'piloto')),
  -- La aprobación pendiente en mcp_pending_actions (sin FK: esa fila caduca).
  approval_id         uuid,
  requested_by        uuid        references public.users(id) on delete set null,
  approved_by         uuid        references public.users(id) on delete set null,
  approved_at         timestamptz,
  sent_at             timestamptz,
  sent_to             text        check (sent_to is null or char_length(sent_to) <= 400),
  received_at         timestamptz,
  invoiced_at         timestamptz,
  -- La factura del proveedor (0181) que la cubre.
  payable_id          uuid,
  cancelled_reason    text        check (cancelled_reason is null or char_length(cancelled_reason) <= 500),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- De «aprobada» en adelante (salvo cancelada) alguien la aprobó.
  constraint purchase_orders_approved check (
    status in ('borrador', 'por_aprobar', 'cancelada') or approved_at is not null
  ),
  constraint purchase_orders_sent check (status <> 'enviada' or sent_at is not null),
  constraint purchase_orders_invoiced check (status <> 'facturada' or payable_id is not null)
);

create unique index if not exists purchase_orders_number_uidx
  on public.purchase_orders (organization_id, number);
create index if not exists purchase_orders_status_idx
  on public.purchase_orders (organization_id, status, created_at desc);
create index if not exists purchase_orders_supplier_idx
  on public.purchase_orders (organization_id, supplier_tax_id) where supplier_tax_id is not null;

comment on table public.purchase_orders is
  'Órdenes de compra: borrador → por_aprobar → aprobada → enviada → recibida_parcial/recibida → facturada/cerrada (o cancelada). Proveedor de public.suppliers (0181); la factura del proveedor se ata en payable_id.';

create table if not exists public.purchase_order_lines (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  purchase_order_id   uuid        not null references public.purchase_orders(id) on delete cascade,
  product_id          uuid        references public.products(id) on delete set null,
  position            integer     not null default 0,
  description         text        not null check (char_length(btrim(description)) between 1 and 300),
  unit                text        not null default 'und' check (char_length(btrim(unit)) between 1 and 30),
  qty                 numeric(18,4) not null check (qty > 0),
  unit_cost           numeric(18,4) not null default 0 check (unit_cost >= 0),
  -- IVA en porcentaje (19 = 19 %).
  tax_rate            numeric(6,3) not null default 0 check (tax_rate between 0 and 100),
  qty_received        numeric(18,4) not null default 0 check (qty_received >= 0),
  created_at          timestamptz not null default now(),
  constraint purchase_order_lines_received check (qty_received <= qty)
);

create index if not exists purchase_order_lines_po_idx
  on public.purchase_order_lines (purchase_order_id, position);
create index if not exists purchase_order_lines_product_idx
  on public.purchase_order_lines (product_id) where product_id is not null;

-- ---------------------------------------------------------------------------
-- 4. El libro de existencias
-- ---------------------------------------------------------------------------
create table if not exists public.stock_movements (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  product_id          uuid        not null references public.products(id) on delete cascade,
  location_id         uuid        not null references public.stock_locations(id) on delete restrict,
  kind                text        not null check (kind in ('entrada', 'salida', 'ajuste', 'traslado')),
  -- Con signo: + entra a la bodega, − sale de ella.
  qty                 numeric(18,4) not null check (qty <> 0),
  -- Costo por unidad: el de compra en una entrada; el promedio vigente en una
  -- salida (lo que costó lo que salió).
  unit_cost           numeric(18,4) check (unit_cost is null or unit_cost >= 0),
  reference_kind      text        not null default 'manual'
                                  check (reference_kind in ('orden_compra', 'venta', 'factura', 'manual',
                                                            'conteo', 'sincronizacion', 'importacion', 'traslado')),
  reference_id        text        check (reference_id is null or char_length(reference_id) <= 120),
  reference_label     text        check (reference_label is null or char_length(reference_label) <= 200),
  purchase_order_id   uuid        references public.purchase_orders(id) on delete set null,
  -- Las dos patas de un traslado comparten este id.
  transfer_id         uuid,
  note                text        check (note is null or char_length(note) <= 500),
  occurred_on         date        not null default current_date,
  -- Para que reintentar no duplique (una línea recibida, un ajuste de sync).
  dedupe_key          text        check (dedupe_key is null or char_length(dedupe_key) <= 200),
  created_by          uuid        references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  constraint stock_movements_sign check (
    (kind = 'entrada' and qty > 0) or (kind = 'salida' and qty < 0) or kind in ('ajuste', 'traslado')
  ),
  constraint stock_movements_transfer check ((kind = 'traslado') = (transfer_id is not null))
);

create index if not exists stock_movements_product_idx
  on public.stock_movements (organization_id, product_id, occurred_on desc);
create index if not exists stock_movements_po_idx
  on public.stock_movements (purchase_order_id) where purchase_order_id is not null;
create unique index if not exists stock_movements_dedupe_uidx
  on public.stock_movements (organization_id, dedupe_key) where dedupe_key is not null;

comment on table public.stock_movements is
  'El libro de existencias: entradas, salidas, ajustes y traslados con cantidad con signo, costo y referencia. Las existencias son su suma (vista stock_levels).';

-- ---------------------------------------------------------------------------
-- 5. Existencias: la suma del libro
-- ---------------------------------------------------------------------------
create or replace view public.stock_levels
with (security_invoker = true) as
select
  m.organization_id,
  m.product_id,
  m.location_id,
  sum(m.qty)            as on_hand,
  max(m.occurred_on)    as last_movement_on,
  count(*)::integer     as movements
from public.stock_movements m
group by m.organization_id, m.product_id, m.location_id;

comment on view public.stock_levels is
  'Existencias por producto y bodega: la suma de stock_movements. Lleva organization_id (tenant).';

-- ---------------------------------------------------------------------------
-- 6. updated_at
-- ---------------------------------------------------------------------------
drop trigger if exists products_touch_updated_at on public.products;
create trigger products_touch_updated_at
  before update on public.products
  for each row execute function public.touch_updated_at();

drop trigger if exists stock_locations_touch_updated_at on public.stock_locations;
create trigger stock_locations_touch_updated_at
  before update on public.stock_locations
  for each row execute function public.touch_updated_at();

drop trigger if exists purchase_orders_touch_updated_at on public.purchase_orders;
create trigger purchase_orders_touch_updated_at
  before update on public.purchase_orders
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 7. Acceso: sólo el servidor
-- ---------------------------------------------------------------------------
alter table public.stock_locations      enable row level security;
alter table public.products             enable row level security;
alter table public.purchase_orders      enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.stock_movements      enable row level security;

revoke all on table public.stock_locations      from public, anon, authenticated;
revoke all on table public.products             from public, anon, authenticated;
revoke all on table public.purchase_orders      from public, anon, authenticated;
revoke all on table public.purchase_order_lines from public, anon, authenticated;
revoke all on table public.stock_movements      from public, anon, authenticated;
revoke all on table public.stock_levels         from public, anon, authenticated;

grant select, insert, update, delete on table public.stock_locations      to service_role;
grant select, insert, update, delete on table public.products             to service_role;
grant select, insert, update, delete on table public.purchase_orders      to service_role;
grant select, insert, update, delete on table public.purchase_order_lines to service_role;
grant select, insert, update, delete on table public.stock_movements      to service_role;
grant select on table public.stock_levels to service_role;
