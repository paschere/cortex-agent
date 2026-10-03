-- ===========================================================================
-- BORRADORES DE DECLARACIONES PARA EL CONTADOR, CERTIFICADOS DE RETENCIÓN Y
-- LAS OBLIGACIONES QUE LE FALTABAN AL CALENDARIO
-- ===========================================================================
-- El calendario tributario (0180) dice CUÁNDO vence cada cosa. Esta migración
-- guarda el QUÉ: el borrador de cada declaración armado con los datos que la
-- empresa ya tiene en Cortex (ventas 0182, cuentas por pagar 0181, el libro
-- 0172, los estados 0191 y la nómina si existe), para que el contador lo
-- revise y lo presente él.
--
-- CORTEX NUNCA PRESENTA NADA ANTE LA DIAN. Un borrador es eso: un borrador.
-- Sus estados los pone una persona:
--   borrador   lo armó Cortex (o alguien lo guardó para revisarlo).
--   revisado   el contador lo revisó: las cifras quedan congeladas como las vio.
--   presentado alguien lo presentó por fuera (portal de la DIAN, el programa
--              contable) y lo anotó aquí con el formulario presentado como
--              evidencia. Marca también la obligación de 0180 como presentada,
--              que es lo que mira el cierre de mes.
--   anulado    no sirve (se armó con el periodo equivocado, se rehízo…).
--
-- `figures` es la fotografía de las cifras con su origen: cada renglón dice qué
-- facturas, compras o movimientos lo forman (packages/agent-tools/src/tax/
-- drafts.ts). Nada aquí se recalcula en SQL.
--
-- `tax_withholding_certificates`: los certificados de retención (renta, IVA,
-- ICA) que la empresa como agente de retención le expide a cada proveedor, con
-- el PDF generado y a quién se le mandó.
--
-- Además:
--   - Casillas nuevas del perfil tributario: impuesto al patrimonio, operaciones
--     con vinculados del exterior (precios de transferencia), fecha del último
--     cambio de beneficiarios finales (RUB), tarifa de autorretención especial,
--     tarifa del Régimen Simple y las actividades de ICA con su tarifa. Todas
--     las escribe quien administra (store.ts `saveTaxProfile`).
--   - Tres clases nuevas de obligación: patrimonio, rub, precios_transferencia.
--   - El concepto de retención de cada proveedor (compras, servicios,
--     honorarios…), que la retención mensual y los certificados necesitan.
--
-- Tenencia: `organization_id` en las dos tablas nuevas, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. RLS encendido sin políticas
-- (deny-all) y sólo service_role. Idempotente.

-- ---------------------------------------------------------------------------
-- 1. El perfil: las casillas que faltaban
-- ---------------------------------------------------------------------------
alter table public.tax_profiles
  add column if not exists impuesto_patrimonio  boolean      not null default false,
  add column if not exists vinculados_exterior  boolean      not null default false,
  add column if not exists rub_last_change      date,
  -- Porcentaje (0,55 = 0,55 %). Lo dicta el contador según el CIIU.
  add column if not exists autorretencion_rate  numeric(6,3) check (autorretencion_rate is null or autorretencion_rate between 0 and 10),
  -- Tarifa SIMPLE consolidada del grupo de la empresa, en porcentaje.
  add column if not exists simple_rate          numeric(6,3) check (simple_rate is null or simple_rate between 0 and 20),
  -- [{ "code": "4711", "label": "Comercio al por menor", "ratePerMil": 11.04 }]
  add column if not exists ica_activities       jsonb        not null default '[]'::jsonb
                                                 check (jsonb_typeof(ica_activities) = 'array');

-- ---------------------------------------------------------------------------
-- 2. Las clases nuevas de obligación
-- ---------------------------------------------------------------------------
alter table public.tax_obligations drop constraint if exists tax_obligations_kind_check;
alter table public.tax_obligations add constraint tax_obligations_kind_check check (kind in (
  'renta', 'iva', 'retencion', 'exogena', 'activos_exterior',
  'simple_anticipo', 'simple_declaracion', 'ica',
  'camara_comercio', 'nomina_electronica', 'pila',
  'patrimonio', 'rub', 'precios_transferencia'));

-- ---------------------------------------------------------------------------
-- 3. El concepto de retención de cada proveedor
-- ---------------------------------------------------------------------------
alter table public.suppliers
  add column if not exists withholding_concept text
    check (withholding_concept is null or withholding_concept in (
      'compras', 'servicios', 'honorarios', 'comisiones', 'arrendamiento_inmuebles',
      'arrendamiento_muebles', 'transporte', 'servicios_temporales', 'otros'));

-- ---------------------------------------------------------------------------
-- 4. Los borradores
-- ---------------------------------------------------------------------------
create table if not exists public.tax_drafts (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       text        not null references public.ba_organization(id) on delete cascade,
  -- La obligación del calendario a la que corresponde (nula para un borrador
  -- suelto, p. ej. una renta estimada a mitad de año).
  obligation_id         uuid        references public.tax_obligations(id) on delete set null,
  form_kind             text        not null check (form_kind in ('iva', 'retencion', 'ica', 'simple_anticipo', 'renta')),
  -- El formulario de referencia («300», «350»…), sólo informativo.
  form                  text        check (form is null or length(form) <= 40),
  period_start          date        not null,
  period_end            date        not null,
  period_label          text        not null check (length(period_label) between 1 and 80),
  status                text        not null default 'borrador'
                                    check (status in ('borrador', 'revisado', 'presentado', 'anulado')),
  -- La fotografía: secciones, renglones con su origen, datos que faltan.
  figures               jsonb       not null check (jsonb_typeof(figures) = 'object'),
  -- La versión de las tarifas con que se armó (tax/rates-co.ts).
  rules_version         text        not null check (length(rules_version) between 1 and 40),
  -- El resultado, para listar sin abrir el jsonb: positivo = a pagar, negativo = saldo a favor.
  result_amount         numeric(18,2) not null default 0,
  notes                 text        check (notes is null or length(notes) <= 2000),
  created_by            uuid        references public.users(id) on delete set null,
  reviewed_by           uuid        references public.users(id) on delete set null,
  reviewed_at           timestamptz,
  presented_by          uuid        references public.users(id) on delete set null,
  presented_at          timestamptz,
  -- El formulario presentado (PDF en el Cerebro) o un enlace al recibo.
  evidence_document_id  uuid        references public.kb_documents(id) on delete set null,
  evidence_url          text        check (evidence_url is null or (length(evidence_url) <= 1000 and evidence_url ~ '^https?://')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint tax_drafts_period_order check (period_end >= period_start),
  -- Revisado lleva quién y cuándo; presentado, además, su evidencia.
  constraint tax_drafts_reviewed_pair check (
    status not in ('revisado', 'presentado') or (reviewed_at is not null or presented_at is not null)
  ),
  constraint tax_drafts_presented_evidence check (
    status <> 'presentado' or (presented_at is not null and (evidence_document_id is not null or evidence_url is not null))
  )
);

-- Un borrador vivo por obligación: rehacerlo actualiza el mismo.
create unique index if not exists tax_drafts_obligation_live_idx
  on public.tax_drafts (organization_id, obligation_id)
  where obligation_id is not null and status <> 'anulado';

create index if not exists tax_drafts_org_period_idx
  on public.tax_drafts (organization_id, period_end desc);

comment on table public.tax_drafts is
  'Borradores de declaraciones tributarias armados con los datos de la empresa para que el contador los revise y los presente. Cortex nunca presenta ante la DIAN: «presentado» lo marca una persona con el formulario como evidencia. figures = cifras con el origen de cada renglón.';

-- ---------------------------------------------------------------------------
-- 5. Los certificados de retención a proveedores
-- ---------------------------------------------------------------------------
create table if not exists public.tax_withholding_certificates (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       text        not null references public.ba_organization(id) on delete cascade,
  supplier_id           uuid        references public.suppliers(id) on delete set null,
  supplier_nit          text        check (supplier_nit is null or supplier_nit ~ '^[0-9]{3,15}$'),
  supplier_name         text        not null check (length(btrim(supplier_name)) between 1 and 200),
  -- renta: retención en la fuente a título de renta; iva: reteIVA; ica: reteICA.
  kind                  text        not null check (kind in ('renta', 'iva', 'ica')),
  year                  int         not null check (year between 2020 and 2100),
  -- Para IVA se expide por bimestre (1–6); renta e ICA, anual (nulo).
  period                int         check (period is null or period between 1 and 6),
  -- El concepto dominante (renta) o la tarifa aplicada, legible.
  concept               text        check (concept is null or length(concept) <= 120),
  base                  numeric(18,2) not null default 0 check (base >= 0),
  withheld              numeric(18,2) not null default 0 check (withheld >= 0),
  -- Las facturas detrás de las cifras: [{ id, docNumber, issueDate, base, withheld }].
  sources               jsonb       not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  -- El PDF expedido (app_files o Cerebro) y su huella.
  document_path         text        check (document_path is null or length(document_path) <= 500),
  issued_at             timestamptz,
  issued_by             uuid        references public.users(id) on delete set null,
  sent_to               text        check (sent_to is null or length(sent_to) <= 500),
  sent_at               timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Un certificado por proveedor, clase y periodo: re-expedirlo actualiza.
create unique index if not exists tax_withholding_certificates_once_idx
  on public.tax_withholding_certificates
  (organization_id, kind, year, coalesce(period, 0), coalesce(supplier_nit, supplier_name));

create index if not exists tax_withholding_certificates_org_year_idx
  on public.tax_withholding_certificates (organization_id, year, kind);

comment on table public.tax_withholding_certificates is
  'Certificados de retención (renta, IVA, ICA) que la empresa expide a sus proveedores, calculados con las cuentas por pagar (0181), con su PDF y a quién se mandaron. Mandarlos por correo pide aprobación.';

-- ---------------------------------------------------------------------------
-- 6. Acceso: sólo el servidor
-- ---------------------------------------------------------------------------
alter table public.tax_drafts                   enable row level security;
alter table public.tax_withholding_certificates enable row level security;

revoke all on table public.tax_drafts                   from public, anon, authenticated;
revoke all on table public.tax_withholding_certificates from public, anon, authenticated;

grant select, insert, update, delete on table public.tax_drafts                   to service_role;
grant select, insert, update, delete on table public.tax_withholding_certificates to service_role;
