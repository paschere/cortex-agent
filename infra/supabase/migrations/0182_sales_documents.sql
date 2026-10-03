-- ===========================================================================
-- COTIZACIONES → PEDIDOS → FACTURAS ELECTRÓNICAS
-- ===========================================================================
-- Hasta aquí Cortex sabía COBRAR (la cartera, 0159/0165) pero no VENDER: la
-- cotización se hacía en Word, se mandaba a mano, el «sí» del cliente llegaba
-- por WhatsApp y la factura se volvía a digitar en Siigo o Alegra. Tres
-- copias del mismo negocio y ninguna sabía de las otras.
--
-- Esta migración guarda el negocio UNA vez, con su vida entera:
--
--   1. `sales_documents` — cotización, pedido o factura (`kind`). Un pedido
--      nace de una cotización aceptada y una factura de cualquiera de los dos
--      (`source_id`), así que la línea de tiempo de un negocio se arma
--      siguiendo esa llave. Los totales (subtotal, descuentos, IVA,
--      retenciones, neto a recibir) se guardan calculados por el código
--      (packages/agent-tools/src/sales/totals.ts) para que una lista no tenga
--      que recalcular nada y una cifra vista hoy sea la misma mañana.
--
--   2. `sales_document_lines` — las líneas, cada una con su tarifa de IVA
--      (19, 5, 0 = exento, excluido) y, si salió del catálogo del programa
--      contable, la referencia del producto allá (`product_ref`/`product_code`):
--      sin ella Siigo o Alegra no aceptan la factura.
--
--   3. `sales_document_events` — la línea de tiempo: creada, enviada, vista,
--      aceptada por el cliente desde el enlace, convertida, facturada, o el
--      error del programa en español. Con autor: una persona del equipo o
--      «el cliente, desde el enlace».
--
--   4. `sales_sequences` + `sales_next_number()` — la numeración consecutiva
--      por empresa y clase (COT-1, COT-2…), atómica: dos cotizaciones a la vez
--      no pueden salir con el mismo número. La numeración LEGAL de la factura
--      la pone el programa contable (FV-2-22) y se guarda aparte
--      (`provider_number`).
--
-- LA FACTURA ELECTRÓNICA LA SELLA EL PROGRAMA, NO CORTEX. Cortex arma lo que
-- se le manda a Siigo (POST /v1/invoices) o a Alegra (POST /invoices), lo
-- enseña, espera la aprobación de una persona y lo manda con una llave de
-- idempotencia. Lo que vuelve (id, número, CUFE, estado DIAN) queda aquí.
-- Sin programa conectado la factura se queda en `borrador` con la guía para
-- conectarlo: nunca hay una columna que diga «emitida» sin un id del programa
-- (ver `sales_documents_emitted_has_provider`).
--
-- EL ENLACE PÚBLICO. `share_token` abre la cotización sin sesión en
-- /cotizacion/<token> (el token ES la credencial, como /v/<token> de 0156):
-- verla, bajarla en PDF y pulsar «Aceptar cotización». La búsqueda por token
-- es la única lectura sin alcance (apps/web/lib/sales/public.ts); lo demás se
-- lee con el espacio de la fila.
--
-- Tenencia: `organization_id` en las cuatro tablas, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts; RLS deny-all + service_role.
-- Idempotente.

-- ---------------------------------------------------------------------------
-- 1. El documento
-- ---------------------------------------------------------------------------
create table if not exists public.sales_documents (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    text        not null references public.ba_organization(id) on delete cascade,
  kind               text        not null check (kind in ('quote', 'order', 'invoice')),
  -- Consecutivo propio por empresa y clase (sales_next_number). COT-12, PED-4.
  number             integer     not null check (number > 0),
  status             text        not null default 'borrador',
  -- De qué documento salió: el pedido de la cotización, la factura del pedido.
  source_id          uuid        references public.sales_documents(id) on delete set null,

  -- El cliente. `client_id` cuando es un cliente del hub (0075); el nombre y
  -- el NIT se copian al crear porque el documento dice a quién se le cotizó
  -- ESE día aunque el cliente cambie de nombre después.
  client_id          uuid        references public.clients(id) on delete set null,
  client_name        text        not null check (length(btrim(client_name)) between 1 and 200),
  client_tax_id      text        check (client_tax_id is null or client_tax_id ~ '^[0-9]{3,15}$'),
  client_email       text        check (client_email is null or length(client_email) <= 320),
  contact_name       text        check (contact_name is null or length(contact_name) <= 200),

  issue_date         date        not null default ((now() at time zone 'America/Bogota')::date),
  -- Cotización: hasta cuándo vale. Factura: cuándo vence el pago.
  valid_until        date,
  due_date           date,
  currency           text        not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  payment_form       text        not null default 'credito' check (payment_form in ('contado', 'credito')),
  payment_days       integer     not null default 30 check (payment_days between 0 and 365),
  notes              text        check (notes is null or length(notes) <= 4000),
  terms              text        check (terms is null or length(terms) <= 4000),

  -- Retenciones que el cliente practica (estimadas para el neto a recibir):
  -- { "retefuente_pct": 4, "reteica_per_mil": 9.66, "reteiva_pct": 15 }.
  withholdings       jsonb       not null default '{}'::jsonb,

  -- Totales, calculados por sales/totals.ts y guardados con dos decimales.
  subtotal           numeric(18,2) not null default 0,
  discount_total     numeric(18,2) not null default 0,
  tax_base           numeric(18,2) not null default 0,
  iva_total          numeric(18,2) not null default 0,
  total              numeric(18,2) not null default 0,
  withholding_total  numeric(18,2) not null default 0,
  net_total          numeric(18,2) not null default 0,

  -- El enlace público de la cotización.
  share_token        text        unique check (share_token is null or share_token ~ '^[A-Za-z0-9_-]{32,64}$'),
  share_views        integer     not null default 0,
  sent_at            timestamptz,
  sent_to            text,
  accepted_at        timestamptz,
  accepted_by_name   text        check (accepted_by_name is null or length(accepted_by_name) <= 200),
  rejected_at        timestamptz,
  rejection_reason   text        check (rejection_reason is null or length(rejection_reason) <= 1000),

  -- La factura electrónica, como la devolvió el programa contable.
  provider           text        check (provider is null or provider in ('siigo', 'alegra')),
  provider_invoice_id text,
  provider_number    text,
  cufe               text,
  einvoice_status    text,
  provider_url       text,
  provider_error     text        check (provider_error is null or length(provider_error) <= 2000),
  -- El intento salió y no se supo si llegó (la red se cortó a mitad): no se
  -- reintenta solo en un programa sin llave de idempotencia.
  emission_uncertain boolean     not null default false,
  emission_attempted_at timestamptz,
  emitted_at         timestamptz,
  -- Lo último que se le mandó al programa, para poder contestar «¿qué se envió?».
  provider_payload   jsonb,

  created_by         uuid        references public.users(id) on delete set null,
  updated_by         uuid        references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint sales_documents_status_by_kind check (
    (kind = 'quote'   and status in ('borrador', 'enviada', 'aceptada', 'rechazada', 'vencida', 'pedido', 'facturada', 'anulada'))
 or (kind = 'order'   and status in ('pedido', 'facturada', 'anulada'))
 or (kind = 'invoice' and status in ('borrador', 'emitiendo', 'emitida', 'error', 'anulada'))
  ),
  -- «Emitida» sin un id del programa sería decir que se selló algo que nadie
  -- selló. La base no lo deja escribir.
  constraint sales_documents_emitted_has_provider check (
    status <> 'emitida' or (provider is not null and provider_invoice_id is not null)
  ),
  constraint sales_documents_totals_sane check (
    subtotal >= 0 and discount_total >= 0 and iva_total >= 0 and withholding_total >= 0
  )
);

create unique index if not exists sales_documents_org_kind_number_idx
  on public.sales_documents (organization_id, kind, number);

create index if not exists sales_documents_org_kind_created_idx
  on public.sales_documents (organization_id, kind, created_at desc);

create index if not exists sales_documents_client_idx
  on public.sales_documents (organization_id, client_id, created_at desc)
  where client_id is not null;

create index if not exists sales_documents_source_idx
  on public.sales_documents (source_id)
  where source_id is not null;

-- Una factura viva por documento de origen: facturar dos veces el mismo pedido
-- no puede pasar ni por un doble clic ni por dos personas a la vez.
create unique index if not exists sales_documents_one_invoice_per_source_idx
  on public.sales_documents (organization_id, source_id)
  where kind = 'invoice' and source_id is not null and status <> 'anulada';

-- Y un id del programa, una factura.
create unique index if not exists sales_documents_provider_invoice_idx
  on public.sales_documents (organization_id, provider, provider_invoice_id)
  where provider_invoice_id is not null;

comment on table public.sales_documents is
  'Cotizaciones, pedidos y facturas de venta. La factura electrónica la sella el programa contable (Siigo/Alegra); aquí queda su id, número, CUFE y estado. Ver packages/agent-tools/src/sales/.';

-- ---------------------------------------------------------------------------
-- 2. Las líneas
-- ---------------------------------------------------------------------------
create table if not exists public.sales_document_lines (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    text        not null references public.ba_organization(id) on delete cascade,
  document_id        uuid        not null references public.sales_documents(id) on delete cascade,
  position           integer     not null check (position between 1 and 500),
  description        text        not null check (length(btrim(description)) between 1 and 1000),
  -- El producto en el programa contable: el id (Alegra lo exige) y el código
  -- (Siigo lo exige). Vacíos = línea de texto libre, que se puede cotizar pero
  -- no facturar electrónicamente hasta elegir un producto.
  product_ref        text        check (product_ref is null or length(product_ref) <= 120),
  product_code       text        check (product_code is null or length(product_code) <= 120),
  unit               text        check (unit is null or length(unit) <= 40),
  quantity           numeric(18,4) not null check (quantity > 0),
  unit_price         numeric(18,2) not null check (unit_price >= 0),
  discount_pct       numeric(5,2)  not null default 0 check (discount_pct between 0 and 100),
  -- iva_19 / iva_5 / iva_0 (exento: gravado al 0 %) / excluido (no causa IVA).
  tax_rate           text        not null default 'iva_19'
                                 check (tax_rate in ('iva_19', 'iva_5', 'iva_0', 'excluido')),
  -- Calculados por sales/totals.ts.
  gross              numeric(18,2) not null default 0,
  discount           numeric(18,2) not null default 0,
  base               numeric(18,2) not null default 0,
  iva                numeric(18,2) not null default 0,
  line_total         numeric(18,2) not null default 0,
  created_at         timestamptz not null default now()
);

create unique index if not exists sales_document_lines_doc_position_idx
  on public.sales_document_lines (document_id, position);

create index if not exists sales_document_lines_org_idx
  on public.sales_document_lines (organization_id, document_id);

-- ---------------------------------------------------------------------------
-- 3. La línea de tiempo
-- ---------------------------------------------------------------------------
create table if not exists public.sales_document_events (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    text        not null references public.ba_organization(id) on delete cascade,
  document_id        uuid        not null references public.sales_documents(id) on delete cascade,
  kind               text        not null check (kind in (
    'created', 'updated', 'sent', 'viewed', 'accepted', 'rejected', 'expired',
    'converted', 'invoice_prepared', 'invoice_emitted', 'invoice_failed', 'cancelled'
  )),
  detail             text        check (detail is null or length(detail) <= 2000),
  -- Una persona del equipo, o nadie (el cliente desde el enlace: actor_label).
  actor_user_id      uuid        references public.users(id) on delete set null,
  actor_label        text        check (actor_label is null or length(actor_label) <= 200),
  created_at         timestamptz not null default now()
);

create index if not exists sales_document_events_doc_idx
  on public.sales_document_events (document_id, created_at);

create index if not exists sales_document_events_org_idx
  on public.sales_document_events (organization_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. Numeración consecutiva por empresa
-- ---------------------------------------------------------------------------
create table if not exists public.sales_sequences (
  organization_id    text        not null references public.ba_organization(id) on delete cascade,
  kind               text        not null check (kind in ('quote', 'order', 'invoice')),
  last_number        integer     not null default 0 check (last_number >= 0),
  updated_at         timestamptz not null default now(),
  primary key (organization_id, kind)
);

-- El siguiente número, bajo candado de la fila: dos llamadas a la vez salen
-- con números distintos y seguidos. Un número que se gasta y no se usa (la
-- inserción falló después) deja un hueco; es lo honesto — reusarlo podría
-- repetir uno que alguien ya vio.
create or replace function public.sales_next_number(p_organization_id text, p_kind text)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  if p_kind not in ('quote', 'order', 'invoice') then
    raise exception 'sales_next_number: clase desconocida %', p_kind;
  end if;
  insert into public.sales_sequences as s (organization_id, kind, last_number)
       values (p_organization_id, p_kind, 1)
  on conflict (organization_id, kind)
  do update set last_number = s.last_number + 1, updated_at = now()
  returning last_number into n;
  return n;
end $$;

revoke all on function public.sales_next_number(text, text) from public, anon, authenticated;
grant execute on function public.sales_next_number(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Acceso
-- ---------------------------------------------------------------------------
alter table public.sales_documents       enable row level security;
alter table public.sales_document_lines  enable row level security;
alter table public.sales_document_events enable row level security;
alter table public.sales_sequences       enable row level security;

revoke all on table public.sales_documents       from public, anon, authenticated;
revoke all on table public.sales_document_lines  from public, anon, authenticated;
revoke all on table public.sales_document_events from public, anon, authenticated;
revoke all on table public.sales_sequences       from public, anon, authenticated;

grant select, insert, update, delete on table public.sales_documents       to service_role;
grant select, insert, update, delete on table public.sales_document_lines  to service_role;
grant select, insert, update, delete on table public.sales_document_events to service_role;
grant select, insert, update, delete on table public.sales_sequences       to service_role;
