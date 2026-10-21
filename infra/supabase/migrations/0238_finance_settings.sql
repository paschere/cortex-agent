-- 0238 — Ajustes de finanzas por empresa.
--
-- El plazo de pago por defecto: Siigo guarda «vence el mismo día» cuando nadie
-- escribió plazo, y entonces Cortex no puede decir qué está vencido. Este es el
-- plazo con el que se cuentan las facturas que no traen uno propio ni lo tiene
-- su cliente. Por defecto 30 días; la empresa lo cambia en Cartera y pagos.

create table if not exists public.finance_settings (
  organization_id            text primary key references public.ba_organization(id) on delete cascade,
  default_payment_terms_days integer not null default 30
                             check (default_payment_terms_days between 1 and 365),
  updated_by                 uuid,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

comment on column public.finance_settings.default_payment_terms_days is
  'Días de plazo para las facturas sin plazo propio ni plazo del cliente (Cartera: qué está vencido).';

alter table public.finance_settings enable row level security;
revoke all on table public.finance_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.finance_settings to service_role;
