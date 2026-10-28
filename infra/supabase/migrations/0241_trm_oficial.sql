-- 0241 — TRM oficial (cortex.trm).
--
-- Copia en la base de la Tasa Representativa del Mercado que publica la
-- Superintendencia Financiera en datos abiertos (datos.gov.co, dataset
-- 32sa-8pi3). Cada fila es una VIGENCIA: el valor (pesos por dólar) rige desde
-- `vigencia_desde` hasta `vigencia_hasta`, ambas inclusive; una vigencia del
-- viernes cubre sábado, domingo y el lunes festivo. Es un dato PÚBLICO y de la
-- plataforma (no de una empresa): sin organization_id. Un trabajo diario trae
-- las nuevas y rellena el histórico; las fórmulas `trm(fecha)`, el «buscar en
-- lista» por fecha, las prefacturas y las fuentes contables la leen de aquí.

create table if not exists public.platform_trm_rates (
  vigencia_desde date primary key,
  vigencia_hasta date not null,
  valor          numeric(14, 4) not null check (valor > 0),
  fetched_at     timestamptz not null default now(),
  constraint platform_trm_rates_range check (vigencia_hasta >= vigencia_desde)
);

create index if not exists platform_trm_rates_hasta_idx
  on public.platform_trm_rates (vigencia_hasta);

comment on table public.platform_trm_rates is
  'TRM oficial (Superfinanciera, datos.gov.co 32sa-8pi3): valor COP por USD con su vigencia desde/hasta inclusive. Dato público de la plataforma.';

alter table public.platform_trm_rates enable row level security;
revoke all on table public.platform_trm_rates from public, anon, authenticated;
grant select, insert, update, delete on table public.platform_trm_rates to service_role;
