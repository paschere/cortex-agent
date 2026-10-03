-- ===========================================================================
-- EL CALENDARIO TRIBUTARIO DE CADA EMPRESA
-- ===========================================================================
-- Una empresa colombiana tiene, al año, entre veinte y cincuenta fechas con la
-- DIAN, la Cámara de Comercio, la secretaría de hacienda de su ciudad y la
-- seguridad social. Casi todas dependen de dos cosas que la empresa ya sabe y
-- nadie le pregunta: el último dígito (o los dos últimos) de su NIT y unas
-- cuantas casillas de su RUT (gran contribuyente, régimen simple, IVA
-- bimestral o cuatrimestral, agente de retención, ciudad del ICA…).
--
-- Esta migración guarda esas dos cosas y lo que sale de ellas:
--
--   1. `tax_profiles` — una fila por empresa: NIT, dígito de verificación,
--      tipo de persona y las casillas. La escribe sólo quien administra o es
--      dueño (packages/agent-tools/src/tax/store.ts `saveTaxProfile`, que
--      llaman la herramienta `tax.configure` y la acción de /impuestos; las
--      dos revisan el permiso en el servidor con `isCompanyManager`). Guarda
--      también QUIÉN responde por los impuestos (`owner_user_id`: el contador
--      o el responsable) y con cuántos días de aviso.
--
--   2. `tax_obligations` — cada fecha del año que le aplica a ESA empresa,
--      generada por el motor puro (packages/agent-tools/src/tax/engine.ts)
--      desde tablas de fechas versionadas y con su fuente. Cada fila dice qué
--      versión de la regla la produjo (`rule_version`) y si la fecha exacta
--      está confirmada o hay que confirmarla con el contador
--      (`needs_confirmation`): una fecha que Cortex no pudo verificar se
--      muestra como tal, nunca se inventa.
--
--      El estado (pendiente / presentada / pagada / no aplica) lo pone una
--      persona, con su evidencia: un documento del Cerebro o un enlace. Cada
--      obligación pendiente con fecha futura tiene su vencimiento en
--      `commitments` (`commitment_id`), así que los avisos, el responsable, el
--      resumen diario de vencidos y el piloto automático salen del mismo
--      vigilante que ya cuida los SOAT y los contratos.
--
-- IDEMPOTENTE POR DISEÑO: la llave natural (empresa, año, `obligation_key`) es
-- única, así que volver a generar el calendario actualiza en vez de duplicar.
-- Cambiar el perfil regenera sólo lo FUTURO y PENDIENTE: lo presentado o
-- pagado es historia y no se toca.
--
-- Tenencia: `organization_id` en las dos, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. RLS encendido sin políticas
-- (deny-all) y sólo service_role. Idempotente.

-- ---------------------------------------------------------------------------
-- 1. El perfil tributario
-- ---------------------------------------------------------------------------
create table if not exists public.tax_profiles (
  organization_id         text        primary key references public.ba_organization(id) on delete cascade,
  -- Sólo dígitos y SIN el dígito de verificación: el calendario se decide por
  -- los últimos dígitos del NIT sin DV (DUR 1625 de 2016, art. 1.6.1.13.2.x).
  nit                     text        not null check (nit ~ '^[0-9]{5,15}$'),
  dv                      text        check (dv is null or dv ~ '^[0-9]$'),
  person_type             text        not null default 'juridica'
                                      check (person_type in ('juridica', 'natural')),
  gran_contribuyente      boolean     not null default false,
  regimen_simple          boolean     not null default false,
  -- none: no responsable de IVA. bimestral / cuatrimestral: art. 600 ET.
  iva_periodicity         text        not null default 'none'
                                      check (iva_periodicity in ('none', 'bimestral', 'cuatrimestral')),
  agente_retencion        boolean     not null default false,
  -- La ciudad donde declara ICA. 'otra' = Cortex no conoce su calendario.
  ica_city                text        check (ica_city is null or ica_city in
                                        ('bogota', 'medellin', 'cali', 'barranquilla', 'otra')),
  -- Bogotá tiene dos periodicidades (bimestral y anual); en las demás es una.
  ica_periodicity         text        check (ica_periodicity is null or ica_periodicity in
                                        ('bimestral', 'anual', 'mensual')),
  exogena                 boolean     not null default false,
  activos_exterior        boolean     not null default false,
  camara_comercio         boolean     not null default true,
  nomina_electronica      boolean     not null default false,
  pila                    boolean     not null default false,
  facturacion_electronica boolean     not null default false,
  -- Quién responde por los impuestos: el contador o el responsable interno.
  -- Es el dueño de cada vencimiento que sale de aquí.
  owner_user_id           uuid        references public.users(id) on delete set null,
  -- Con cuántos días de anticipación avisa el vigilante de vencimientos.
  notice_days             int         not null default 7 check (notice_days between 1 and 60),
  -- De dónde salió el perfil: escrito a mano, o leído del RUT (con el
  -- documento del Cerebro de donde se leyó).
  source                  text        not null default 'manual' check (source in ('manual', 'rut')),
  source_document_id      uuid        references public.kb_documents(id) on delete set null,
  updated_by              uuid        references public.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table public.tax_profiles is
  'El perfil tributario de cada empresa (NIT sin DV, tipo de persona y casillas del RUT) del que sale su calendario de obligaciones. Lo escribe sólo quien administra o es dueño.';

-- ---------------------------------------------------------------------------
-- 2. Las obligaciones del año
-- ---------------------------------------------------------------------------
create table if not exists public.tax_obligations (
  id                      uuid        primary key default gen_random_uuid(),
  organization_id         text        not null references public.ba_organization(id) on delete cascade,
  year                    int         not null check (year between 2024 and 2100),
  -- La llave natural dentro del año: «iva:2026-B3», «renta:2025-c1»… La
  -- arma el motor; dos generaciones de la misma regla dan la misma llave.
  obligation_key          text        not null check (length(obligation_key) between 3 and 80),
  kind                    text        not null check (kind in (
                                        'renta', 'iva', 'retencion', 'exogena', 'activos_exterior',
                                        'simple_anticipo', 'simple_declaracion', 'ica',
                                        'camara_comercio', 'nomina_electronica', 'pila')),
  -- El periodo al que corresponde, legible: «Bimestre 3 (may–jun 2026)».
  period                  text        not null check (length(period) between 1 and 80),
  title                   text        not null check (length(title) between 3 and 200),
  authority               text        not null check (length(authority) between 2 and 80),
  form                    text        check (form is null or length(form) <= 40),
  due_date                date        not null,
  requires_payment        boolean     not null default true,
  -- La fecha exacta no está verificada contra la norma: la pantalla dice
  -- «confirma con tu contador» y el aviso también.
  needs_confirmation      boolean     not null default false,
  -- Qué tabla de fechas la produjo («co-2026.1»). Sirve para saber qué
  -- regenerar cuando cambie la norma.
  rule_version            text        not null check (length(rule_version) between 1 and 40),
  source_note             text        check (source_note is null or length(source_note) <= 300),
  status                  text        not null default 'pendiente'
                                      check (status in ('pendiente', 'presentada', 'pagada', 'no_aplica')),
  status_at               timestamptz,
  status_by               uuid        references public.users(id) on delete set null,
  status_note             text        check (status_note is null or length(status_note) <= 500),
  evidence_document_id    uuid        references public.kb_documents(id) on delete set null,
  evidence_url            text        check (evidence_url is null or (length(evidence_url) <= 1000 and evidence_url ~ '^https?://')),
  -- El vencimiento que la vigila. Nulo si ya pasó al generarse, o si no está
  -- pendiente.
  commitment_id           uuid        references public.commitments(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- Un estado distinto de pendiente lleva quién y cuándo.
  constraint tax_obligations_status_pair check (
    status = 'pendiente' or (status_at is not null)
  )
);

create unique index if not exists tax_obligations_org_year_key_idx
  on public.tax_obligations (organization_id, year, obligation_key);

create index if not exists tax_obligations_org_due_idx
  on public.tax_obligations (organization_id, due_date);

create index if not exists tax_obligations_commitment_idx
  on public.tax_obligations (commitment_id)
  where commitment_id is not null;

comment on table public.tax_obligations is
  'Cada fecha tributaria del año que le aplica a una empresa, generada desde su perfil y tablas de fechas versionadas (rule_version), con su estado, su evidencia y el vencimiento (commitments) que la vigila. needs_confirmation = la fecha no está verificada contra la norma.';

-- ---------------------------------------------------------------------------
-- 3. Acceso: sólo el servidor
-- ---------------------------------------------------------------------------
alter table public.tax_profiles    enable row level security;
alter table public.tax_obligations enable row level security;

revoke all on table public.tax_profiles    from public, anon, authenticated;
revoke all on table public.tax_obligations from public, anon, authenticated;

grant select, insert, update, delete on table public.tax_profiles    to service_role;
grant select, insert, update, delete on table public.tax_obligations to service_role;
