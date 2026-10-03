-- ===========================================================================
-- CONTRATOS Y CUMPLIMIENTO
-- ===========================================================================
-- Dos módulos del área «Legal» (0186: `contracts`, `compliance`) que viven de
-- la misma idea: un papel con fechas y obligaciones que alguien tiene que
-- cumplir, y una persona que responde por cada una.
--
-- NADA DE ESTO ES ASESORÍA LEGAL. Las plantillas son BORRADORES con
-- marcadores («[COMPLETAR: …]») para revisión de un abogado; los plazos y
-- umbrales que salen de una norma se guardan con su fundamento y, cuando no
-- están verificados, marcados «por confirmar». Ninguna columna dice que un
-- contrato es válido.
--
--   1. `contract_templates` — las plantillas PROPIAS de la empresa (una copia
--      editada de una de serie, o una nueva). Las de serie (prestación de
--      servicios, confidencialidad, laboral a término fijo e indefinido,
--      compraventa, arrendamiento comercial, otrosí, carta de terminación)
--      viven en código (packages/agent-tools/src/contracts/templates.ts) y no
--      se copian a cada empresa: una fila por empresa por plantilla de serie
--      sería una copia que nadie actualiza.
--   2. `contracts` — cada contrato: tipo, partes (cliente, proveedor o
--      empleado enlazados), valor, vigencia, renovación (automática o por
--      prórroga), aviso previo, estado, el texto del borrador y la copia
--      firmada (un documento del Cerebro). El vencimiento del contrato NO se
--      duplica: se enlaza al de «Documentos que vencen» (0184,
--      `expiration_id`), que ya lo vigila; el aviso previo (la fecha hasta la
--      que se puede avisar que no se renueva) es su propio vencimiento en
--      `commitments` (`notice_commitment_id`).
--   3. `contract_obligations` — lo que cada parte se obligó a hacer, leído del
--      contrato firmado CON LA FRASE QUE LO DICE (`evidence_quote`) o escrito
--      a mano. Igual que en 0069 y 0184: lo leído es una PROPUESTA hasta que
--      una persona lo confirma; sólo entonces nace su vencimiento con
--      responsable.
--   4. `contract_events` — la línea de tiempo del contrato.
--   5. `compliance_profiles` — el perfil del que sale la lista de
--      cumplimiento: tipo de sociedad, tamaño, ingresos y activos, si la vigila
--      una superintendencia, si maneja datos personales, si atiende
--      consumidores. También el enlace público del formulario de PQRS.
--   6. `compliance_items` — la lista de cumplimiento de la empresa: asamblea
--      ordinaria, libros, matrícula (enlazada a Impuestos, 0180), RNBD de la
--      SIC, política de datos, PQRS, SAGRILAFT/PTEE, procesos judiciales. Cada
--      cosa con su frecuencia, su fecha, su evidencia y su estado.
--   7. `pqrs` — peticiones, quejas, reclamos, sugerencias y felicitaciones,
--      con radicado consecutivo por año y su plazo legal en días hábiles.
--   8. `legal_cases` y `legal_case_actions` — procesos judiciales: radicado
--      de 23 dígitos, despacho, partes, estado, actuaciones y la próxima
--      diligencia.
--
-- Tenencia: `organization_id` en todas, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. RLS encendido sin políticas
-- (deny-all) y sólo service_role. Idempotente.

-- ---------------------------------------------------------------------------
-- 1. Plantillas propias de la empresa
-- ---------------------------------------------------------------------------
create table if not exists public.contract_templates (
  id              uuid        primary key default gen_random_uuid(),
  organization_id text        not null references public.ba_organization(id) on delete cascade,
  -- La plantilla de serie de la que salió esta copia, si alguna.
  builtin_key     text        check (builtin_key is null or builtin_key ~ '^[a-z_]{3,40}$'),
  contract_type   text        not null
                              check (contract_type in ('prestacion_servicios', 'confidencialidad',
                                                       'laboral_fijo', 'laboral_indefinido',
                                                       'compraventa', 'arrendamiento_comercial',
                                                       'otrosi', 'terminacion', 'otro')),
  name            text        not null check (length(btrim(name)) between 3 and 160),
  description     text        check (description is null or length(description) <= 600),
  -- El texto con marcadores {{campo}}.
  body            text        not null check (length(body) between 20 and 60000),
  -- [{ key, label, kind, required, source }]
  fields          jsonb       not null default '[]'::jsonb
                              check (jsonb_typeof(fields) = 'array'),
  status          text        not null default 'activa' check (status in ('activa', 'archivada')),
  created_by      uuid        references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists contract_templates_org_name_idx
  on public.contract_templates (organization_id, lower(name))
  where status = 'activa';

comment on table public.contract_templates is
  'Plantillas de contrato PROPIAS de una empresa (copia editada de una de serie o nueva). Las de serie viven en código (agent-tools/src/contracts/templates.ts). Todo lo que sale de aquí es un borrador para revisión de un abogado.';

-- ---------------------------------------------------------------------------
-- 2. Contratos
-- ---------------------------------------------------------------------------
create table if not exists public.contracts (
  id                     uuid        primary key default gen_random_uuid(),
  organization_id        text        not null references public.ba_organization(id) on delete cascade,
  contract_type          text        not null
                                     check (contract_type in ('prestacion_servicios', 'confidencialidad',
                                                              'laboral_fijo', 'laboral_indefinido',
                                                              'compraventa', 'arrendamiento_comercial',
                                                              'otrosi', 'terminacion', 'otro')),
  title                  text        not null check (length(btrim(title)) between 3 and 200),
  -- De qué plantilla salió: la clave de una de serie, o una propia.
  template_key           text        check (template_key is null or length(template_key) <= 60),
  template_id            uuid        references public.contract_templates(id) on delete set null,
  -- Con quién. El enlace que aplique; el nombre queda escrito por si el
  -- registro enlazado se borra.
  counterparty_kind      text        not null default 'otro'
                                     check (counterparty_kind in ('cliente', 'proveedor', 'empleado', 'otro')),
  counterparty_name      text        check (counterparty_name is null or length(counterparty_name) <= 200),
  counterparty_id_number text        check (counterparty_id_number is null or length(counterparty_id_number) <= 40),
  client_id              uuid        references public.clients(id) on delete set null,
  supplier_id            uuid        references public.suppliers(id) on delete set null,
  -- Quien trabaja en la empresa y tiene cuenta. La ficha de nómina (0194) la
  -- lleva su módulo; aquí sólo se nombra (`employee_ref`) para no depender de
  -- una tabla ajena.
  employee_user_id       uuid        references public.users(id) on delete set null,
  employee_ref           text        check (employee_ref is null or length(employee_ref) <= 120),
  -- Un otrosí o una carta de terminación cuelgan del contrato que modifican.
  parent_contract_id     uuid        references public.contracts(id) on delete set null,
  value_amount           numeric(18,2) check (value_amount is null or value_amount >= 0),
  currency               text        not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  -- «mensual», «por entrega», «canon mensual»…
  value_note             text        check (value_note is null or length(value_note) <= 300),
  start_on               date,
  end_on                 date,
  -- automatica: se renueva sola si nadie avisa a tiempo. prorroga: sólo si
  -- las partes la pactan (otrosí). ninguna: termina en `end_on`.
  renewal                text        not null default 'ninguna'
                                     check (renewal in ('ninguna', 'automatica', 'prorroga')),
  -- Meses de cada renovación automática; null = la misma duración inicial.
  renewal_months         integer     check (renewal_months is null or renewal_months between 1 and 120),
  -- Días de aviso previo para no renovar (o para terminar).
  notice_days            integer     check (notice_days is null or notice_days between 0 and 730),
  -- borrador / en_revision / firmado son decisiones; vigente y vencido se
  -- recalculan con las fechas en cada lectura (esta columna es su caché);
  -- terminado es una decisión.
  status                 text        not null default 'borrador'
                                     check (status in ('borrador', 'en_revision', 'firmado',
                                                       'vigente', 'vencido', 'terminado')),
  -- El texto del borrador, ya llenado. Lo que falta va como «[COMPLETAR: …]».
  body_text              text        check (body_text is null or length(body_text) <= 120000),
  placeholders           text[]      not null default '{}'::text[],
  -- Cómo nació: de una plantilla, redactado con Cortex en el chat, o subido
  -- ya firmado.
  drafted_with           text        not null default 'plantilla'
                                     check (drafted_with in ('plantilla', 'chat', 'subido')),
  -- La copia firmada, en el Cerebro.
  document_id            uuid        references public.kb_documents(id) on delete set null,
  signed_at              date,
  terminated_on          date,
  termination_reason     text        check (termination_reason is null or length(termination_reason) <= 600),
  owner_user_id          uuid        references public.users(id) on delete set null,
  -- El vencimiento del contrato lo vigila «Documentos que vencen» (0184).
  expiration_id          uuid        references public.document_expirations(id) on delete set null,
  -- La fecha límite del aviso previo, como vencimiento con responsable.
  notice_commitment_id   uuid        references public.commitments(id) on delete set null,
  created_by             uuid        references public.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint contracts_dates_order
    check (start_on is null or end_on is null or start_on <= end_on),
  -- Un contrato firmado tiene la fecha de firma o la copia firmada. (Un
  -- borrador que se cierra sin firmarse queda «terminado» sin ninguna.)
  constraint contracts_signed_has_proof
    check (status in ('borrador', 'en_revision', 'terminado')
           or signed_at is not null or document_id is not null),
  constraint contracts_terminated_has_date
    check (status <> 'terminado' or terminated_on is not null),
  constraint contracts_not_own_parent
    check (parent_contract_id is null or parent_contract_id <> id)
);

create index if not exists contracts_org_status_idx
  on public.contracts (organization_id, status, end_on);
create index if not exists contracts_client_idx
  on public.contracts (client_id) where client_id is not null;
create index if not exists contracts_supplier_idx
  on public.contracts (supplier_id) where supplier_id is not null;
create index if not exists contracts_document_idx
  on public.contracts (document_id) where document_id is not null;
create index if not exists contracts_parent_idx
  on public.contracts (parent_contract_id) where parent_contract_id is not null;

comment on table public.contracts is
  'Contratos de la empresa: borradores desde plantillas (para revisión de un abogado), copias firmadas en el Cerebro, vigencia, renovación y aviso previo. El vencimiento se enlaza a document_expirations (0184) en vez de duplicarse; el aviso previo es su propio compromiso (notice_commitment_id).';
comment on column public.contracts.placeholders is
  'Marcadores que el borrador todavía no llena (lo que no se sabía). Un contrato con marcadores no está listo para firmar.';

-- ---------------------------------------------------------------------------
-- 3. Obligaciones de cada contrato
-- ---------------------------------------------------------------------------
create table if not exists public.contract_obligations (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    text        not null references public.ba_organization(id) on delete cascade,
  contract_id        uuid        not null references public.contracts(id) on delete cascade,
  -- Quién debe cumplirla: nosotros, la contraparte o ambas.
  party              text        not null check (party in ('nosotros', 'contraparte', 'ambas')),
  -- Cómo la nombra el contrato («EL CONTRATISTA», «EL ARRENDATARIO»).
  responsible_label  text        check (responsible_label is null or length(responsible_label) <= 200),
  category           text        not null default 'otra'
                                 check (category in ('pago', 'entrega', 'reporte', 'renovacion',
                                                     'confidencialidad', 'garantia', 'otra')),
  description        text        not null check (length(btrim(description)) between 3 and 600),
  due_on             date,
  recurrence         text        not null default 'none'
                                 check (recurrence in ('none', 'monthly', 'quarterly', 'yearly')),
  -- «dentro de los cinco primeros días de cada mes» tal como lo dice.
  due_note           text        check (due_note is null or length(due_note) <= 300),
  penalty            text        check (penalty is null or length(penalty) <= 600),
  -- La frase literal del contrato. Obligatoria para lo leído de un documento.
  evidence_quote     text        check (evidence_quote is null or length(evidence_quote) <= 800),
  chunk_id           uuid,
  source             text        not null check (source in ('documento', 'manual', 'plantilla')),
  status             text        not null default 'propuesta'
                                 check (status in ('propuesta', 'confirmada', 'descartada', 'cumplida')),
  -- Calculada por reglas, nunca dicha por el modelo.
  confidence         text        check (confidence is null or confidence in ('alta', 'media', 'baja')),
  review_note        text        check (review_note is null or length(review_note) <= 600),
  owner_user_id      uuid        references public.users(id) on delete set null,
  notice_days        integer     check (notice_days is null or notice_days between 0 and 365),
  commitment_id      uuid        references public.commitments(id) on delete set null,
  confirmed_by       uuid        references public.users(id) on delete set null,
  confirmed_at       timestamptz,
  created_by         uuid        references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint contract_obligations_read_has_quote
    check (source <> 'documento' or evidence_quote is not null),
  constraint contract_obligations_confirmed_needs_human
    check (status not in ('confirmada', 'cumplida') or confirmed_at is not null),
  constraint contract_obligations_confirmed_pair
    check (confirmed_by is null or confirmed_at is not null)
);

create index if not exists contract_obligations_contract_idx
  on public.contract_obligations (contract_id, status);
create index if not exists contract_obligations_org_due_idx
  on public.contract_obligations (organization_id, due_on)
  where status = 'confirmada';
create index if not exists contract_obligations_commitment_idx
  on public.contract_obligations (commitment_id) where commitment_id is not null;

comment on table public.contract_obligations is
  'Lo que cada parte se obligó a hacer en un contrato. Lo leído del documento lleva su cita (evidence_quote) y es una propuesta hasta que una persona la confirma; al confirmarse con fecha nace su vencimiento en commitments con responsable.';

-- ---------------------------------------------------------------------------
-- 4. La línea de tiempo del contrato
-- ---------------------------------------------------------------------------
create table if not exists public.contract_events (
  id              uuid        primary key default gen_random_uuid(),
  organization_id text        not null references public.ba_organization(id) on delete cascade,
  contract_id     uuid        not null references public.contracts(id) on delete cascade,
  kind            text        not null
                              check (kind in ('creado', 'editado', 'en_revision', 'firmado',
                                              'copia_firmada', 'obligaciones', 'aviso', 'vencimiento',
                                              'terminado', 'exportado', 'nota')),
  detail          text        check (detail is null or length(detail) <= 600),
  actor_user_id   uuid        references public.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists contract_events_contract_idx
  on public.contract_events (contract_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. El perfil de cumplimiento (uno por empresa)
-- ---------------------------------------------------------------------------
create table if not exists public.compliance_profiles (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       text        not null references public.ba_organization(id) on delete cascade,
  entity_type           text        not null default 'sas'
                                    check (entity_type in ('sas', 'ltda', 'sa', 'comandita', 'colectiva',
                                                           'esal', 'persona_natural', 'sucursal_extranjera',
                                                           'otra')),
  size                  text        check (size is null or size in ('micro', 'pequena', 'mediana', 'grande')),
  -- Cifras al 31 de diciembre del año anterior (`figures_year`), en pesos.
  revenue_cop           numeric(20,2) check (revenue_cop is null or revenue_cop >= 0),
  assets_cop            numeric(20,2) check (assets_cop is null or assets_cop >= 0),
  figures_year          integer     check (figures_year is null or figures_year between 2000 and 2100),
  -- Negocios internacionales y contratos con el Estado del año anterior (PTEE).
  international_cop     numeric(20,2) check (international_cop is null or international_cop >= 0),
  state_contracts_cop   numeric(20,2) check (state_contracts_cop is null or state_contracts_cop >= 0),
  -- Quién la vigila y cómo.
  supervisor            text        not null default 'ninguna'
                                    check (supervisor in ('ninguna', 'supersociedades', 'superfinanciera',
                                                          'supersalud', 'supertransporte', 'superservicios',
                                                          'supersolidaria', 'otra')),
  supervision_level     text        not null default 'ninguna'
                                    check (supervision_level in ('ninguna', 'inspeccion', 'vigilancia', 'control')),
  sectors               text[]      not null default '{}'::text[]
                                    check (sectors <@ array['inmobiliario', 'metales_preciosos',
                                                            'servicios_juridicos', 'servicios_contables',
                                                            'construccion', 'farmaceutico', 'infraestructura',
                                                            'manufactura', 'minero_energetico', 'tic',
                                                            'activos_virtuales', 'vehiculos', 'otro']::text[]),
  handles_personal_data boolean     not null default true,
  consumer_facing       boolean     not null default false,
  employees             integer     check (employees is null or employees between 0 and 1000000),
  has_board             boolean     not null default false,
  compliance_officer    text        check (compliance_officer is null or length(compliance_officer) <= 160),
  owner_user_id         uuid        references public.users(id) on delete set null,
  privacy_policy_url    text        check (privacy_policy_url is null or length(privacy_policy_url) <= 500),
  -- El formulario público de PQRS (/pqrs/<token>). El token ES la credencial.
  pqrs_enabled          boolean     not null default false,
  pqrs_token            text        check (pqrs_token is null or pqrs_token ~ '^[A-Za-z0-9_-]{32,64}$'),
  pqrs_owner_user_id    uuid        references public.users(id) on delete set null,
  -- Plazos propios por clase ({"reclamo": 10}); sin entrada, el legal.
  pqrs_deadlines        jsonb       not null default '{}'::jsonb
                                    check (jsonb_typeof(pqrs_deadlines) = 'object'),
  created_by            uuid        references public.users(id) on delete set null,
  updated_by            uuid        references public.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint compliance_profiles_public_needs_token
    check (not pqrs_enabled or pqrs_token is not null)
);

create unique index if not exists compliance_profiles_org_idx
  on public.compliance_profiles (organization_id);
create unique index if not exists compliance_profiles_pqrs_token_idx
  on public.compliance_profiles (pqrs_token) where pqrs_token is not null;

comment on table public.compliance_profiles is
  'El perfil del que sale la lista de cumplimiento de una empresa (tipo de sociedad, tamaño, cifras del año anterior, superintendencia, datos personales, consumidores) y el enlace del formulario público de PQRS. Los umbrales que se comparan contra estas cifras están en código y marcados por confirmar.';

-- ---------------------------------------------------------------------------
-- 6. La lista de cumplimiento
-- ---------------------------------------------------------------------------
create table if not exists public.compliance_items (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       text        not null references public.ba_organization(id) on delete cascade,
  -- Clave del catálogo (compliance/catalog.ts) o «propio_…» para lo agregado a mano.
  item_key              text        not null check (item_key ~ '^[a-z0-9_]{3,60}$'),
  -- «2026», «2026-S1», «2026-10»; vacío para lo continuo.
  period                text        not null default '' check (length(period) <= 20),
  area                  text        not null
                                    check (area in ('societario', 'datos_personales', 'consumidor',
                                                    'lavado_activos', 'transparencia', 'litigios', 'otro')),
  title                 text        not null check (length(btrim(title)) between 3 and 200),
  description           text        check (description is null or length(description) <= 1200),
  frequency             text        not null
                                    check (frequency in ('unica', 'anual', 'semestral', 'mensual',
                                                         'continua', 'por_evento')),
  due_on                date,
  due_needs_confirmation boolean    not null default false,
  legal_basis           text        check (legal_basis is null or length(legal_basis) <= 400),
  -- Lo que dice el perfil: aplica, no aplica, o hay que revisarlo con alguien.
  applies               text        not null default 'si' check (applies in ('si', 'no', 'revisar')),
  applicability_note    text        check (applicability_note is null or length(applicability_note) <= 600),
  status                text        not null default 'pendiente'
                                    check (status in ('pendiente', 'en_curso', 'cumplido', 'no_aplica')),
  evidence_document_id  uuid        references public.kb_documents(id) on delete set null,
  evidence_url          text        check (evidence_url is null or length(evidence_url) <= 500),
  evidence_note         text        check (evidence_note is null or length(evidence_note) <= 1000),
  completed_at          timestamptz,
  completed_by          uuid        references public.users(id) on delete set null,
  owner_user_id         uuid        references public.users(id) on delete set null,
  commitment_id         uuid        references public.commitments(id) on delete set null,
  -- Dónde se lleva de verdad (p. ej. la matrícula en /impuestos).
  linked_href           text        check (linked_href is null or length(linked_href) <= 200),
  source                text        not null default 'catalogo' check (source in ('catalogo', 'manual')),
  rule_version          text,
  created_by            uuid        references public.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- Cumplido con evidencia: un documento, un enlace o una nota de quien lo hizo.
  constraint compliance_items_done_has_evidence
    check (status <> 'cumplido' or evidence_document_id is not null
           or evidence_url is not null or evidence_note is not null),
  constraint compliance_items_done_has_time
    check (status <> 'cumplido' or completed_at is not null)
);

create unique index if not exists compliance_items_key_idx
  on public.compliance_items (organization_id, item_key, period);
create index if not exists compliance_items_due_idx
  on public.compliance_items (organization_id, due_on)
  where status in ('pendiente', 'en_curso');

comment on table public.compliance_items is
  'La lista de cumplimiento de una empresa, generada desde su perfil (compliance_profiles) con el catálogo en código: cada obligación con su fundamento, frecuencia, fecha (marcada si está por confirmar), evidencia y estado. Cumplido exige evidencia.';

-- ---------------------------------------------------------------------------
-- 7. PQRS
-- ---------------------------------------------------------------------------
create table if not exists public.pqrs (
  id                   uuid        primary key default gen_random_uuid(),
  organization_id      text        not null references public.ba_organization(id) on delete cascade,
  -- Consecutivo por año: PQRS-2026-000012.
  year                 integer     not null check (year between 2000 and 2100),
  seq                  integer     not null check (seq > 0),
  radicado             text        not null check (radicado ~ '^PQRS-[0-9]{4}-[0-9]{6}$'),
  channel              text        not null
                                   check (channel in ('formulario', 'correo', 'whatsapp', 'telefono',
                                                      'presencial', 'otro')),
  kind                 text        not null
                                   check (kind in ('peticion', 'queja', 'reclamo', 'sugerencia', 'felicitacion')),
  -- De qué trata: decide el plazo legal (Ley 1755 de 2015 art. 14; Ley 1581
  -- de 2012 arts. 14-15; Ley 1480 de 2011).
  matter               text        not null default 'general'
                                   check (matter in ('general', 'informacion', 'consulta', 'consumo',
                                                     'datos_personales')),
  subject              text        not null check (length(btrim(subject)) between 3 and 200),
  body                 text        not null check (length(btrim(body)) between 1 and 8000),
  requester_name       text        not null check (length(btrim(requester_name)) between 2 and 160),
  requester_id_number  text        check (requester_id_number is null or length(requester_id_number) <= 40),
  requester_email      text        check (requester_email is null or length(requester_email) <= 200),
  requester_phone      text        check (requester_phone is null or length(requester_phone) <= 40),
  client_id            uuid        references public.clients(id) on delete set null,
  received_at          timestamptz not null default now(),
  -- El día de Bogotá en que llegó: desde ahí se cuentan los días hábiles.
  received_on          date        not null,
  deadline_days        integer     not null check (deadline_days between 1 and 90),
  due_on               date        not null,
  deadline_basis       text        not null check (length(deadline_basis) <= 400),
  -- Ampliación del plazo, avisada antes de vencer (Ley 1755 de 2015 art. 14 par.).
  extended_due_on      date,
  extension_reason     text        check (extension_reason is null or length(extension_reason) <= 600),
  status               text        not null default 'radicada'
                                   check (status in ('radicada', 'en_tramite', 'respondida', 'cerrada',
                                                     'trasladada', 'desistida')),
  assigned_user_id     uuid        references public.users(id) on delete set null,
  response_text        text        check (response_text is null or length(response_text) <= 12000),
  responded_at         timestamptz,
  responded_by         uuid        references public.users(id) on delete set null,
  response_channel     text        check (response_channel is null or response_channel in
                                          ('formulario', 'correo', 'whatsapp', 'telefono', 'presencial', 'otro')),
  -- El correo o la conversación de donde salió (para encontrarla).
  source_ref           text        check (source_ref is null or length(source_ref) <= 300),
  -- La autorización de tratamiento de datos que dio quien escribió en el
  -- formulario público (Ley 1581 de 2012).
  consent_accepted     boolean     not null default false,
  created_by           uuid        references public.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint pqrs_responded_has_text
    check (status <> 'respondida' or (response_text is not null and responded_at is not null)),
  constraint pqrs_extension_later
    check (extended_due_on is null or extended_due_on > due_on),
  constraint pqrs_form_has_consent
    check (channel <> 'formulario' or consent_accepted),
  constraint pqrs_due_after_receipt
    check (due_on >= received_on)
);

create unique index if not exists pqrs_org_seq_idx on public.pqrs (organization_id, year, seq);
create unique index if not exists pqrs_org_radicado_idx on public.pqrs (organization_id, radicado);
create index if not exists pqrs_org_open_idx
  on public.pqrs (organization_id, due_on)
  where status in ('radicada', 'en_tramite');

comment on table public.pqrs is
  'Peticiones, quejas, reclamos, sugerencias y felicitaciones de la empresa, con radicado por año y plazo legal en días hábiles colombianos (calculado en compliance/pqrs.ts; los plazos por clase se pueden ajustar en el perfil). Entran por el formulario público, el correo, WhatsApp o a mano.';

-- ---------------------------------------------------------------------------
-- 8. Procesos judiciales
-- ---------------------------------------------------------------------------
create table if not exists public.legal_cases (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       text        not null references public.ba_organization(id) on delete cascade,
  -- El número único de radicación de la Rama Judicial: 23 dígitos.
  radicado              text        check (radicado is null or radicado ~ '^[0-9]{23}$'),
  title                 text        not null check (length(btrim(title)) between 3 and 200),
  court                 text        check (court is null or length(court) <= 300),
  city                  text        check (city is null or length(city) <= 120),
  process_type          text        check (process_type is null or length(process_type) <= 160),
  role                  text        not null default 'demandado'
                                    check (role in ('demandante', 'demandado', 'tercero', 'otro')),
  counterparty          text        check (counterparty is null or length(counterparty) <= 300),
  parties               text        check (parties is null or length(parties) <= 1200),
  claim_amount          numeric(18,2) check (claim_amount is null or claim_amount >= 0),
  status                text        not null default 'activo'
                                    check (status in ('activo', 'suspendido', 'terminado', 'archivado')),
  last_action_on        date,
  last_action           text        check (last_action is null or length(last_action) <= 1000),
  next_hearing_on       date,
  next_hearing          text        check (next_hearing is null or length(next_hearing) <= 600),
  lawyer                text        check (lawyer is null or length(lawyer) <= 200),
  owner_user_id         uuid        references public.users(id) on delete set null,
  client_id             uuid        references public.clients(id) on delete set null,
  contract_id           uuid        references public.contracts(id) on delete set null,
  -- La próxima diligencia como vencimiento con responsable.
  hearing_commitment_id uuid        references public.commitments(id) on delete set null,
  last_checked_at       timestamptz,
  last_checked_via      text        check (last_checked_via is null or last_checked_via in ('manual', 'rama_judicial')),
  created_by            uuid        references public.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists legal_cases_org_radicado_idx
  on public.legal_cases (organization_id, radicado) where radicado is not null;
create index if not exists legal_cases_org_hearing_idx
  on public.legal_cases (organization_id, next_hearing_on)
  where status in ('activo', 'suspendido');

create table if not exists public.legal_case_actions (
  id              uuid        primary key default gen_random_uuid(),
  organization_id text        not null references public.ba_organization(id) on delete cascade,
  case_id         uuid        not null references public.legal_cases(id) on delete cascade,
  action_on       date        not null,
  text            text        not null check (length(btrim(text)) between 2 and 2000),
  source          text        not null default 'manual' check (source in ('manual', 'rama_judicial')),
  created_by      uuid        references public.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists legal_case_actions_case_idx
  on public.legal_case_actions (case_id, action_on desc);

comment on table public.legal_cases is
  'Procesos judiciales de la empresa (radicado de 23 dígitos, despacho, partes, estado, última actuación y próxima diligencia). Se llevan a mano o con lo que trae el trámite aprendido de «Consulta de Procesos» de la Rama Judicial; el CAPTCHA, si lo hay, lo resuelve la persona.';

-- ---------------------------------------------------------------------------
-- 9. Acceso: sólo el servicio. La app filtra por empresa (getOrgScopedClient).
-- ---------------------------------------------------------------------------
alter table public.contract_templates   enable row level security;
alter table public.contracts            enable row level security;
alter table public.contract_obligations enable row level security;
alter table public.contract_events      enable row level security;
alter table public.compliance_profiles  enable row level security;
alter table public.compliance_items     enable row level security;
alter table public.pqrs                 enable row level security;
alter table public.legal_cases          enable row level security;
alter table public.legal_case_actions   enable row level security;

revoke all on table public.contract_templates   from public, anon, authenticated;
revoke all on table public.contracts            from public, anon, authenticated;
revoke all on table public.contract_obligations from public, anon, authenticated;
revoke all on table public.contract_events      from public, anon, authenticated;
revoke all on table public.compliance_profiles  from public, anon, authenticated;
revoke all on table public.compliance_items     from public, anon, authenticated;
revoke all on table public.pqrs                 from public, anon, authenticated;
revoke all on table public.legal_cases          from public, anon, authenticated;
revoke all on table public.legal_case_actions   from public, anon, authenticated;

grant select, insert, update, delete on table public.contract_templates   to service_role;
grant select, insert, update, delete on table public.contracts            to service_role;
grant select, insert, update, delete on table public.contract_obligations to service_role;
grant select, insert, update, delete on table public.contract_events      to service_role;
grant select, insert, update, delete on table public.compliance_profiles  to service_role;
grant select, insert, update, delete on table public.compliance_items     to service_role;
grant select, insert, update, delete on table public.pqrs                 to service_role;
grant select, insert, update, delete on table public.legal_cases          to service_role;
grant select, insert, update, delete on table public.legal_case_actions   to service_role;
