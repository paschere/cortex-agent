-- ===========================================================================
-- NÓMINA TRAÍDA DE SIIGO (comprobantes contables de nómina)
-- ===========================================================================
-- Siigo Nube NO tiene endpoint de nómina en su API pública (ver
-- docs/features/accounting-connectors.md, «Nómina»): lo que sí expone son los
-- comprobantes contables (GET /v1/journals) con cuenta PUC, tercero y valor.
-- La nómina que Siigo Nómina contabiliza llega ahí como un comprobante por
-- periodo: gastos de personal (5105/5205/7205), salarios por pagar (2505),
-- retenciones y aportes de nómina (2370, 2365) y provisiones (2510–2525).
--
--   1. `accounting_connections.entities` admite 'payroll' (opcional, apagada
--      por defecto: es información confidencial).
--   2. `accounting_payroll_lines` — una fila por línea de comprobante de
--      nómina: periodo, concepto, cuenta, valor y, si el comprobante trae
--      tercero, la identificación de la persona.
--
-- CONFIDENCIALIDAD. Mismo trato que `employees` y `payroll_payslips`: RLS
-- encendido sin políticas, revocado a anon/authenticated, sólo service_role.
-- La regla de quién ve qué vive en el servidor (accounting/payroll-store.ts):
-- quien administra la empresa ve el detalle por persona; el resto, totales por
-- periodo y concepto. NO va a Tablas (las tablas se comparten con el equipo).
-- Idempotente.

do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.accounting_connections'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%entities%'
  loop
    execute format('alter table public.accounting_connections drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.accounting_connections
  add constraint accounting_connections_entities_check check (
    cardinality(entities) between 1 and 5
    and entities <@ array['customers', 'products', 'invoices', 'payments', 'payroll']::text[]
  );

create table if not exists public.accounting_payroll_lines (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  source_system       text        not null check (source_system ~ '^[a-z][a-z0-9_-]{1,39}$'),
  -- El id del comprobante en el programa y el lugar de la línea: con
  -- `organization_id` y `source_system` es la identidad. Traerlo otra vez
  -- reemplaza las líneas del comprobante, no las duplica.
  journal_id          text        not null check (char_length(journal_id) between 1 and 120),
  line_index          integer     not null check (line_index >= 0),
  journal_name        text        check (journal_name is null or char_length(journal_name) <= 120),
  journal_date        date        not null,
  -- 'AAAA-MM': el mes del comprobante.
  period              text        not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  account_code        text        not null check (char_length(account_code) between 4 and 20),
  movement            text        not null check (movement in ('debit', 'credit')),
  -- devengado | prestaciones | aportes | otros_personal | neto | deducciones | provisiones
  concept_group       text        not null check (concept_group in
                        ('devengado', 'prestaciones', 'aportes', 'otros_personal', 'neto', 'deducciones', 'provisiones')),
  concept             text        not null check (char_length(concept) between 1 and 80),
  amount              numeric(16,2) not null,
  currency            text        not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  -- Identificación del tercero del comprobante (la persona), si la trae.
  person_tax_id       text        check (person_tax_id is null or char_length(person_tax_id) <= 30),
  person_name         text        check (person_name is null or char_length(person_name) <= 200),
  description         text        check (description is null or char_length(description) <= 400),
  synced_at           timestamptz not null default now(),
  constraint accounting_payroll_lines_once
    unique (organization_id, source_system, journal_id, line_index)
);

create index if not exists accounting_payroll_lines_period_idx
  on public.accounting_payroll_lines (organization_id, period);
create index if not exists accounting_payroll_lines_journal_idx
  on public.accounting_payroll_lines (organization_id, source_system, journal_id);

comment on table public.accounting_payroll_lines is
  'Líneas de los comprobantes contables de nómina de un programa contable (Siigo): periodo, concepto, cuenta PUC, valor y tercero. CONFIDENCIAL: el detalle por persona lo lee sólo quien administra (accounting/payroll-store.ts).';

alter table public.accounting_payroll_lines enable row level security;
revoke all on table public.accounting_payroll_lines from public, anon, authenticated;
grant select, insert, update, delete on table public.accounting_payroll_lines to service_role;
