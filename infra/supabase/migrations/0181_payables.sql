-- ===========================================================================
-- CUENTAS POR PAGAR: DE LA FACTURA DEL PROVEEDOR AL PAGO
-- ===========================================================================
-- La factura de un proveedor llega por cuatro caminos —el correo (el ZIP de la
-- factura electrónica con su XML UBL 2.1 y el PDF), la Bandeja/Cerebro (un
-- documento ya leído y confirmado como «por pagar», 0143), el programa
-- contable (las compras de Siigo, Alegra o QuickBooks) o el chat/a mano— y
-- recorre un solo camino:
--
--   recibida → por_aprobar → aprobada → programada → pagada
--                    └──────────┴────────────┴──→ rechazada
--
--   recibida     llegó y se revisó sola; algo bloquea (NIT del adquiriente que
--                no es el nuestro, posible duplicado) y la mira una persona.
--   por_aprobar  limpia o con avisos; espera el visto bueno.
--   aprobada     una persona dijo «sí se debe»; falta decidir cuándo pagar.
--   programada   con día de pago (`scheduled_pay_date`), sugerido contra la
--                proyección de caja: nunca en una semana que quede debajo de
--                la caja mínima.
--   pagada       una salida del banco la pagó (ledger/payables.ts) o una
--                persona la marcó pagada con evidencia.
--   rechazada    no se paga (con motivo).
--
-- CORTEX NUNCA MUEVE PLATA. Aprobar y programar son decisiones; pagar lo hace
-- una persona en su banco, y Cortex se entera por el extracto.
--
-- DEDUPE. La misma factura llega por correo, como PDF a la Bandeja y desde
-- Siigo. Es una sola: por CUFE cuando lo hay, y siempre por proveedor + número
-- (`dedupe_key`, calculado en packages/agent-tools/src/payables/shape.ts).
--
-- EL LIBRO DE PLATA. Cada factura vive también en `ledger_movements` como
-- `payable` (la suya o la del documento/programa que la trajo), con su llave
-- del hecho compartida (`invoice:out:<nit>:<número>`), así que no se cuenta
-- dos veces. La proyección de caja usa el día programado como vencimiento.
--
-- PROVEEDORES. Lista paralela a `clients` (no un rol dentro de clientes): un
-- cliente es a quien se le cobra (cartera, salud, servicios); un proveedor, a
-- quien se le paga (plazo, retenciones, quién aprueba). La identidad es la
-- misma —el NIT sin dígito de verificación— y se reusa el mismo normalizador.
--
-- Tenencia: `organization_id` en las tres tablas, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. Sólo service_role.

-- ---------------------------------------------------------------------------
-- 1. Proveedores
-- ---------------------------------------------------------------------------
create table if not exists public.suppliers (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  -- NIT en dígitos, SIN dígito de verificación. Nulo sólo si nunca se supo.
  nit                 text        check (nit is null or nit ~ '^[0-9]{3,15}$'),
  name                text        not null check (char_length(btrim(name)) between 1 and 200),
  -- Nombre normalizado (sin tildes, sin S.A.S.) para encontrarlo sin NIT.
  name_key            text        not null check (char_length(name_key) between 1 and 200),
  email               text        check (email is null or char_length(email) <= 200),
  -- Plazo acordado en días; sin él, el vencimiento de la factura (o 30 días).
  payment_terms_days  integer     check (payment_terms_days is null or payment_terms_days between 0 and 365),
  -- Quién aprueba sus facturas. Nulo: cualquier dueño o administrador.
  approver_id         uuid        references public.users(id) on delete set null,
  -- Retenciones que se le practican, en porcentaje (2.5 = 2,5 %). Las pone
  -- una persona; Cortex sólo avisa si faltan.
  retefuente_rate     numeric(6,3) check (retefuente_rate is null or retefuente_rate between 0 and 100),
  reteiva_rate        numeric(6,3) check (reteiva_rate is null or reteiva_rate between 0 and 100),
  reteica_rate        numeric(6,3) check (reteica_rate is null or reteica_rate between 0 and 100),
  notes               text        check (notes is null or char_length(notes) <= 2000),
  created_by          uuid        references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists suppliers_org_nit_uidx
  on public.suppliers (organization_id, nit) where nit is not null;
create index if not exists suppliers_org_name_idx
  on public.suppliers (organization_id, name_key);

comment on table public.suppliers is
  'Proveedores de la empresa: a quién se le paga. Identidad por NIT (sin DV), plazo, quién aprueba y retenciones. Paralela a clients. Ver packages/agent-tools/src/payables.';

-- ---------------------------------------------------------------------------
-- 2. Facturas de proveedor
-- ---------------------------------------------------------------------------
create table if not exists public.payable_invoices (
  id                   uuid        primary key default gen_random_uuid(),
  organization_id      text        not null references public.ba_organization(id) on delete cascade,
  supplier_id          uuid        references public.suppliers(id) on delete set null,

  -- De dónde llegó.
  source               text        not null check (source in ('correo', 'documento', 'contable', 'manual', 'chat')),
  source_system        text        not null default '' check (char_length(source_system) <= 80),
  -- La identidad en su fuente: mensaje+adjunto, id de la lectura, id en Siigo…
  source_ref           text        not null check (char_length(source_ref) between 1 and 300),

  -- Identidad de la factura.
  cufe                 text        check (cufe is null or char_length(cufe) between 8 and 200),
  doc_number           text        not null check (char_length(btrim(doc_number)) between 1 and 120),
  -- `<nit o nombre>:<número normalizado>`: la misma factura, llegue por donde llegue.
  dedupe_key           text        not null check (char_length(dedupe_key) between 3 and 200),
  supplier_nit         text        check (supplier_nit is null or supplier_nit ~ '^[0-9]{3,15}$'),
  supplier_dv          text        check (supplier_dv is null or supplier_dv ~ '^[0-9]$'),
  supplier_name        text        not null check (char_length(btrim(supplier_name)) between 1 and 200),
  -- A nombre de quién vino (debería ser nuestro NIT).
  customer_nit         text        check (customer_nit is null or customer_nit ~ '^[0-9]{3,15}$'),

  -- Plata.
  currency             text        not null check (currency ~ '^[A-Z]{3}$'),
  issue_date           date        not null,
  due_date             date,
  subtotal             numeric(18,2) check (subtotal is null or subtotal >= 0),
  iva                  numeric(18,2) not null default 0 check (iva >= 0),
  other_taxes          numeric(18,2) not null default 0 check (other_taxes >= 0),
  total                numeric(18,2) not null check (total >= 0),
  -- Lo que NOSOTROS retenemos al pagar (o lo que la factura ya informa).
  retefuente           numeric(18,2) not null default 0 check (retefuente >= 0),
  reteiva              numeric(18,2) not null default 0 check (reteiva >= 0),
  reteica              numeric(18,2) not null default 0 check (reteica >= 0),
  withholding_source   text        check (withholding_source is null or withholding_source in ('factura', 'proveedor', 'persona')),
  -- Lo que de verdad sale del banco.
  net_amount           numeric(18,2) generated always as (greatest(total - retefuente - reteiva - reteica, 0)) stored,
  lines                jsonb       not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),

  -- Orden de compra (la de inventario/compras, 0183, si existe).
  order_reference      text        check (order_reference is null or char_length(order_reference) <= 120),
  purchase_order_id    uuid,

  -- Flujo.
  status               text        not null default 'recibida'
                                   check (status in ('recibida', 'por_aprobar', 'aprobada', 'programada', 'pagada', 'rechazada')),
  -- Lo que la revisión automática encontró: [{code, severity, message}].
  checks               jsonb       not null default '[]'::jsonb check (jsonb_typeof(checks) = 'array'),
  checked_at           timestamptz,
  approver_id          uuid        references public.users(id) on delete set null,
  approved_by          uuid        references public.users(id) on delete set null,
  approved_at          timestamptz,
  rejected_by          uuid        references public.users(id) on delete set null,
  rejected_at          timestamptz,
  rejection_reason     text        check (rejection_reason is null or char_length(rejection_reason) <= 500),
  scheduled_pay_date   date,
  scheduled_by         uuid        references public.users(id) on delete set null,
  schedule_note        text        check (schedule_note is null or char_length(schedule_note) <= 500),
  paid_at              date,
  paid_by              uuid        references public.users(id) on delete set null,
  -- {kind: 'bank'|'manual', movementId?, reference?, note?, documentId?}
  paid_evidence        jsonb       check (paid_evidence is null or jsonb_typeof(paid_evidence) = 'object'),

  -- Enlaces.
  ledger_movement_id   uuid        references public.ledger_movements(id) on delete set null,
  extraction_id        uuid        references public.document_extractions(id) on delete set null,
  -- Lo que respalda la factura: {provider, messageId, subject, from, files[], documentId}.
  evidence             jsonb       not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  -- La validación de la DIAN que venía en el AttachedDocument, si venía.
  dian_validated       boolean,

  created_by           uuid        references public.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint payable_invoices_source_once unique (organization_id, source, source_system, source_ref),
  constraint payable_invoices_once unique (organization_id, dedupe_key),
  constraint payable_invoices_approved_has_who check (
    status not in ('aprobada', 'programada') or approved_at is not null
  ),
  constraint payable_invoices_scheduled_has_date check (
    status <> 'programada' or scheduled_pay_date is not null
  ),
  constraint payable_invoices_paid_has_date check (status <> 'pagada' or paid_at is not null),
  constraint payable_invoices_rejected_has_when check (status <> 'rechazada' or rejected_at is not null)
);

create unique index if not exists payable_invoices_org_cufe_uidx
  on public.payable_invoices (organization_id, cufe) where cufe is not null;
create index if not exists payable_invoices_org_status_idx
  on public.payable_invoices (organization_id, status, due_date);
create index if not exists payable_invoices_org_supplier_idx
  on public.payable_invoices (organization_id, supplier_id, issue_date desc);
create index if not exists payable_invoices_org_schedule_idx
  on public.payable_invoices (organization_id, scheduled_pay_date)
  where status = 'programada';
create index if not exists payable_invoices_ledger_idx
  on public.payable_invoices (ledger_movement_id) where ledger_movement_id is not null;

comment on table public.payable_invoices is
  'Facturas de proveedor y su camino recibida → por_aprobar → aprobada → programada → pagada/rechazada. Dedupe por CUFE y por proveedor+número. Cortex nunca paga: aprueba, programa contra la caja y se entera del pago por el banco. Ver packages/agent-tools/src/payables.';

-- ---------------------------------------------------------------------------
-- 3. Lo que se revisó al recibir (correo, documentos, programa contable)
-- ---------------------------------------------------------------------------
-- Cada adjunto o registro mirado deja una fila: así el barrido del correo no
-- vuelve a bajar el mismo ZIP que no era factura, y queda el porqué.
create table if not exists public.payable_intake_log (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  text        not null references public.ba_organization(id) on delete cascade,
  channel          text        not null check (channel in ('correo', 'documento', 'contable', 'manual', 'chat')),
  ref              text        not null check (char_length(ref) between 1 and 300),
  outcome          text        not null check (outcome in ('creada', 'duplicada', 'no_factura', 'nota', 'error')),
  invoice_id       uuid        references public.payable_invoices(id) on delete set null,
  detail           text        check (detail is null or char_length(detail) <= 500),
  created_at       timestamptz not null default now(),
  constraint payable_intake_log_once unique (organization_id, channel, ref)
);

create index if not exists payable_intake_log_org_created_idx
  on public.payable_intake_log (organization_id, created_at desc);

comment on table public.payable_intake_log is
  'Cada adjunto/registro revisado buscando facturas de proveedor y qué salió (creada, duplicada, no era factura, nota crédito/débito, error). Evita releer lo mismo.';

alter table public.suppliers          enable row level security;
alter table public.payable_invoices   enable row level security;
alter table public.payable_intake_log enable row level security;

revoke all on table public.suppliers          from public, anon, authenticated;
revoke all on table public.payable_invoices   from public, anon, authenticated;
revoke all on table public.payable_intake_log from public, anon, authenticated;

grant select, insert, update, delete on table public.suppliers          to service_role;
grant select, insert, update, delete on table public.payable_invoices   to service_role;
grant select, insert, update, delete on table public.payable_intake_log to service_role;
