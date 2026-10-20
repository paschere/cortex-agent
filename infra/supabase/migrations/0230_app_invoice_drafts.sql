-- ===========================================================================
-- PREFACTURAS POR REVISAR (acción de automatización `accounting_draft_invoice`)
-- ===========================================================================
-- Cuando una fila de una app cumple una condición (p. ej. una atención se
-- cierra), la regla arma una PREFACTURA: cliente (por NIT), ítems con producto
-- de Siigo, cantidades y precios, observaciones. Queda aquí como `pending`
-- hasta que una persona la apruebe (o la edite, o la descarte) en la bandeja
-- «Prefacturas por revisar». SÓLO al aprobar se crea en Siigo, por el camino de
-- siempre de Ventas (pedido → factura → `emitInvoice`): nunca sale una factura
-- electrónica sin esa aprobación.
--
--   · idempotency_key  — `<regla>:<fila>`, ÚNICA: una fila no genera dos
--                        prefacturas por la misma regla, ni aunque la regla
--                        corra dos veces (reintento, dos escritores, descarte).
--   · vínculo          — fila (`tracker_id`, `row_id`) ↔ prefactura (`id`) ↔
--                        documento de Ventas (`sales_document_id`) ↔ factura
--                        del programa (`provider_invoice_id`, `provider_number`).
--   · lines            — [{ description, productCode, quantity, unitPrice (en
--                        pesos), taxRate, unit?, sourceUnitPrice? }].
--
-- Tenencia: `organization_id` y `tenant()` en tenancy/tables.ts. RLS como
-- 0210: sólo service_role, con el cliente acotado (`getOrgScopedClient`).

create table if not exists public.app_invoice_drafts (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      text not null,
  app_id               uuid not null references public.custom_apps (id) on delete cascade,
  -- La regla que la armó; si la borran, la prefactura (y su factura) quedan.
  automation_id        uuid references public.custom_app_automations (id) on delete set null,
  run_id               uuid,
  tracker_id           uuid,
  row_id               uuid,
  row_label            text not null default '',
  idempotency_key      text not null,
  status               text not null default 'pending'
                       check (status in ('pending', 'creating', 'created', 'discarded', 'error')),
  customer_tax_id      text,
  customer_name        text not null default '',
  currency             text not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  trm                  numeric(14, 4),
  lines                jsonb not null check (jsonb_typeof(lines) = 'array'),
  observations         text not null default '',
  payment_form         text not null default 'contado' check (payment_form in ('contado', 'credito')),
  payment_days         integer not null default 0 check (payment_days between 0 and 365),
  -- { documentTypeId?, sellerId?, paymentTypeId? } (ids de Siigo).
  choices              jsonb not null default '{}'::jsonb check (jsonb_typeof(choices) = 'object'),
  -- { invoiceNumber?: campo, status?: { field, pending?, created? } }
  write_back           jsonb not null default '{}'::jsonb check (jsonb_typeof(write_back) = 'object'),
  -- Total estimado con IVA, en pesos (informativo: el definitivo lo calcula Ventas).
  total                numeric(16, 2) not null default 0,
  sales_document_id    uuid,
  provider             text,
  provider_invoice_id  text,
  provider_number      text,
  sent_to_dian         boolean,
  error                text,
  decided_by           uuid,
  decided_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint app_invoice_drafts_key_len check (char_length(idempotency_key) <= 300),
  constraint app_invoice_drafts_obs_len check (char_length(observations) <= 4000),
  constraint app_invoice_drafts_lines_len check (jsonb_array_length(lines) between 1 and 50)
);

create unique index if not exists app_invoice_drafts_key_idx
  on public.app_invoice_drafts (idempotency_key);
create index if not exists app_invoice_drafts_inbox_idx
  on public.app_invoice_drafts (organization_id, status, created_at desc);
create index if not exists app_invoice_drafts_row_idx
  on public.app_invoice_drafts (organization_id, row_id)
  where row_id is not null;
create index if not exists app_invoice_drafts_app_idx
  on public.app_invoice_drafts (organization_id, app_id, created_at desc);

comment on table public.app_invoice_drafts is
  'Prefacturas armadas por una automatización y pendientes de revisión humana. Sólo al aprobarse se crean en Siigo (vía Ventas). idempotency_key única: una fila no genera dos prefacturas.';

alter table public.app_invoice_drafts enable row level security;
revoke all on table public.app_invoice_drafts from public, anon, authenticated;
grant select, insert, update, delete on table public.app_invoice_drafts to service_role;
