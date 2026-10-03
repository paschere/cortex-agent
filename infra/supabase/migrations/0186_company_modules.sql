-- ===========================================================================
-- MÓDULOS POR EMPRESA: EL INTERRUPTOR DE CADA ÁREA
-- ===========================================================================
-- Una ferretería no necesita órdenes de servicio y una agencia no necesita
-- inventario. Cada área grande de Cortex (el catálogo vive en
-- packages/agent-tools/src/modules/catalog.ts) se puede prender o apagar por
-- empresa. Apagar un módulo lo saca del menú, de la paleta, de las
-- herramientas que el agente ve y del piloto automático — NO BORRA DATOS:
-- prenderlo otra vez lo deja como estaba.
--
-- UNA FILA SÓLO SI ALGUIEN TOCÓ EL INTERRUPTOR. Una empresa sin filas tiene el
-- estado por defecto de cada módulo (`defaultOn` en el catálogo), así que un
-- módulo nuevo llega encendido o apagado según diga el catálogo sin escribir
-- nada aquí. Por eso `module_key` NO tiene un check con la lista de claves: el
-- catálogo crece con cada módulo que se construye y una lista en SQL obligaría
-- a una migración por cada uno. Una clave que el código ya no conoce se ignora
-- al leer.
--
-- Quién lo cambia: sólo quien administra la empresa o es su dueño
-- (`isCompanyManager`), comprobado en el servidor; cada cambio deja una fila
-- en `audit_events` (tool_id = 'modules.toggle').
--
-- Tenencia: `organization_id` en cada fila; `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. RLS encendido sin políticas
-- (deny-all) y sólo service_role. Idempotente.

create table if not exists public.company_modules (
  organization_id  text        not null references public.ba_organization(id) on delete cascade,
  module_key       text        not null check (module_key ~ '^[a-z][a-z0-9_]{1,59}$'),
  enabled          boolean     not null,
  -- Quién lo dejó así. `set null`: si la persona se va, el estado sigue.
  updated_by       uuid        references public.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  primary key (organization_id, module_key)
);

comment on table public.company_modules is
  'El interruptor de cada módulo de Cortex por empresa. Sin fila = el estado por defecto del catálogo (packages/agent-tools/src/modules/catalog.ts). Apagar no borra datos.';

-- ---------------------------------------------------------------------------
-- Lo que ya se usaba sigue prendido.
--
-- Tres módulos del catálogo llegan APAGADOS por defecto pero cubren cosas que
-- algunas empresas ya usan hoy: la flota (vehículos registrados), el
-- inventario (productos cargados) y la atención por WhatsApp (encendida en su
-- propia configuración). Para esas empresas, apagarlas de un día para otro
-- sería quitarles algo sin que nadie lo decidiera, así que se dejan
-- explícitamente encendidas. La nómina (`payroll.*`) se trata igual si la
-- empresa la consultó en los últimos 180 días. `updated_by` nulo: lo decidió
-- esta migración, no una persona. `on conflict do nothing`: si alguien ya
-- tocó el interruptor, gana lo que decidió.
-- ---------------------------------------------------------------------------
insert into public.company_modules (organization_id, module_key, enabled)
select distinct v.organization_id, 'fleet', true
from public.vehicles v
where v.organization_id is not null
on conflict do nothing;

insert into public.company_modules (organization_id, module_key, enabled)
select distinct p.organization_id, 'inventory', true
from public.products p
where p.organization_id is not null
on conflict do nothing;

insert into public.company_modules (organization_id, module_key, enabled)
select s.organization_id, 'whatsapp_service', true
from public.wa_customer_settings s
where s.enabled
on conflict do nothing;

insert into public.company_modules (organization_id, module_key, enabled)
select distinct a.organization_id, 'payroll', true
from public.audit_events a
where a.tool_id like 'payroll.%'
  and a.status = 'ok'
  and a.created_at > now() - interval '180 days'
  and a.organization_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Acceso
-- ---------------------------------------------------------------------------
alter table public.company_modules enable row level security;

revoke all on table public.company_modules from public, anon, authenticated;

grant select, insert, update, delete on table public.company_modules to service_role;
