-- ===========================================================================
-- NÓMINA COLOMBIANA, VACACIONES Y PERMISOS, Y SG-SST
-- ===========================================================================
-- Hasta aquí la «nómina» de Cortex era leer un servicio aparte (payroll.*,
-- packages/agent-tools/src/payroll/client.ts) que sabe lo que SE PAGÓ. Esta
-- migración le da a cada empresa su nómina de verdad, liquidada en Cortex con
-- la ley colombiana, y lo que viene con ella:
--
--   1. `payroll_settings` — una fila por empresa: quincenal o mensual,
--      exonerada o no del art. 114-1 ET, si el sábado es hábil (para contar
--      vacaciones) y quién responde por la nómina.
--   2. `employees` — quién está en la nómina: documento, contrato (indefinido,
--      fijo, obra, aprendizaje; prestación de servicios se registra pero NO se
--      liquida), fechas, salario, integral, clase de riesgo ARL, EPS / AFP /
--      caja / fondo de cesantías, cuenta bancaria ENMASCARADA (sólo los
--      últimos 4 dígitos: Cortex nunca guarda el número completo), centro de
--      costo y el usuario de Cortex si lo tiene (para que vea lo suyo).
--   3. `payroll_periods` — cada mes o quincena: borrador → liquidado →
--      aprobado → pagado. Guarda los TOTALES (sin nombres) y la versión de los
--      parámetros legales con que se liquidó.
--   4. `payroll_novelties` — horas extra, recargos, incapacidades, licencias,
--      vacaciones, comisiones, bonificaciones y deducciones por persona.
--   5. `payroll_items` — las líneas de la liquidación de cada persona en cada
--      periodo, con su explicación («30 días × $58.364»), y
--      `payroll_payslips` — el desprendible: devengado, deducciones, neto,
--      IBC, aportes y provisiones de esa persona en ese periodo.
--   6. `leave_requests` — vacaciones, permisos, licencias e incapacidades con
--      su aprobación; una aprobada se vuelve novedad de nómina. El saldo de
--      vacaciones (15 días hábiles por año) se calcula, no se guarda, desde
--      `employees.vacation_opening_days` + lo causado − lo aprobado.
--   7. `sst_settings`, `sst_plan`, `sst_activities`, `sst_incidents` — el
--      SG-SST: tamaño y riesgo (de ahí los 7, 21 o 60 estándares de la
--      Resolución 0312 de 2019), la autoevaluación del año con evidencia, las
--      actividades (capacitaciones, exámenes, inspecciones, COPASST/vigía,
--      simulacros) y los accidentes e incidentes con sus plazos: FURAT en 2
--      días hábiles e investigación en 15 días, vigilados como vencimientos
--      (`commitments`).
--
-- CONFIDENCIALIDAD. Los salarios son de quien administra y de la persona
-- misma. La regla vive en el servidor (packages/agent-tools/src/payroll/
-- store.ts, `payrollAccess`), la usan la pantalla /nomina, las herramientas
-- del chat y las exportaciones: quien no administra ve SUS desprendibles y
-- SU saldo de vacaciones, y de la empresa a lo sumo totales. El libro de plata
-- recibe la nómina como UNA fila por periodo, categoría «nomina» (ya
-- confidencial en ledger/privacy.ts), sin nombres.
--
-- Tenencia: `organization_id` en todas, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. RLS encendido sin políticas
-- (deny-all), revocado a anon/authenticated, sólo service_role. Idempotente.

-- ---------------------------------------------------------------------------
-- 1. Configuración de la nómina
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_settings (
  organization_id       text        primary key references public.ba_organization(id) on delete cascade,
  frequency             text        not null default 'mensual' check (frequency in ('mensual', 'quincenal')),
  -- Art. 114-1 ET: persona jurídica declarante (o natural con 2+ empleados)
  -- no paga salud empleador, SENA ni ICBF por quien gana < 10 SMMLV.
  exonerated_114_1      boolean     not null default true,
  -- El sábado cuenta como día hábil de vacaciones salvo que la empresa no
  -- trabaje sábados.
  saturday_is_workday   boolean     not null default true,
  -- Quién responde por la nómina (recibe los avisos del piloto).
  responsible_user_id   uuid        references public.users(id) on delete set null,
  updated_by            uuid        references public.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.payroll_settings is
  'Configuración de la nómina de cada empresa: frecuencia, exoneración art. 114-1 ET, sábado hábil, responsable. La escribe sólo quien administra.';

-- ---------------------------------------------------------------------------
-- 2. Empleados
-- ---------------------------------------------------------------------------
create table if not exists public.employees (
  id                      uuid        primary key default gen_random_uuid(),
  organization_id         text        not null references public.ba_organization(id) on delete cascade,
  -- Su cuenta en Cortex, si la tiene: con ella ve sus desprendibles y su saldo.
  user_id                 uuid        references public.users(id) on delete set null,
  full_name               text        not null check (length(full_name) between 2 and 160),
  document_type           text        not null default 'CC'
                                      check (document_type in ('CC', 'CE', 'PA', 'TI', 'PEP', 'PPT')),
  document_number         text        not null check (document_number ~ '^[0-9A-Za-z-]{3,20}$'),
  email                   text        check (email is null or length(email) <= 200),
  job_title               text        check (job_title is null or length(job_title) <= 120),
  contract_type           text        not null check (contract_type in
                                        ('indefinido', 'fijo', 'obra', 'aprendizaje', 'prestacion_servicios')),
  start_date              date        not null,
  end_date                date,
  -- Salario mensual pactado; en aprendizaje, el apoyo de sostenimiento.
  salary                  numeric(14,2) not null check (salary >= 0 and salary < 10000000000),
  salary_integral         boolean     not null default false,
  apprentice_phase        text        check (apprentice_phase is null or apprentice_phase in ('lectiva', 'productiva')),
  arl_class               smallint    not null default 1 check (arl_class between 1 and 5),
  eps                     text        check (eps is null or length(eps) <= 80),
  afp                     text        check (afp is null or length(afp) <= 80),
  ccf                     text        check (ccf is null or length(ccf) <= 80),
  arl                     text        check (arl is null or length(arl) <= 80),
  cesantias_fund          text        check (cesantias_fund is null or length(cesantias_fund) <= 80),
  bank_name               text        check (bank_name is null or length(bank_name) <= 80),
  bank_account_type       text        check (bank_account_type is null or bank_account_type in ('ahorros', 'corriente', 'deposito')),
  -- SÓLO los últimos cuatro dígitos. El número completo no entra a Cortex.
  bank_account_last4      text        check (bank_account_last4 is null or bank_account_last4 ~ '^[0-9]{4}$'),
  cost_center             text        check (cost_center is null or length(cost_center) <= 80),
  -- Para la retención en la fuente (art. 387 ET) y la medicina prepagada.
  dependents              boolean     not null default false,
  prepaid_health          numeric(14,2) check (prepaid_health is null or prepaid_health >= 0),
  -- Saldo de vacaciones (días hábiles) que traía al empezar a usar Cortex.
  vacation_opening_days   numeric(6,2) not null default 0 check (vacation_opening_days between -60 and 400),
  vacation_opening_as_of  date,
  status                  text        not null default 'activo' check (status in ('activo', 'retirado')),
  termination_reason      text        check (termination_reason is null or termination_reason in
                                        ('sin_justa_causa', 'justa_causa', 'renuncia', 'mutuo_acuerdo', 'fin_contrato', 'periodo_prueba')),
  notes                   text        check (notes is null or length(notes) <= 2000),
  created_by              uuid        references public.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint employees_dates check (end_date is null or end_date >= start_date),
  constraint employees_integral check (not salary_integral or contract_type in ('indefinido', 'fijo', 'obra')),
  constraint employees_apprentice check (contract_type = 'aprendizaje' or apprentice_phase is null)
);

create unique index if not exists employees_org_document_idx
  on public.employees (organization_id, document_type, document_number);
create unique index if not exists employees_org_user_idx
  on public.employees (organization_id, user_id) where user_id is not null;
create index if not exists employees_org_status_idx
  on public.employees (organization_id, status);

comment on table public.employees is
  'Las personas de la nómina de una empresa. CONFIDENCIAL: salario y datos personales; los lee quien administra y cada persona su propia fila (payroll/store.ts). La cuenta bancaria va enmascarada (últimos 4 dígitos).';

-- ---------------------------------------------------------------------------
-- 3. Periodos
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_periods (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  frequency         text        not null check (frequency in ('mensual', 'quincenal')),
  period_start      date        not null,
  period_end        date        not null,
  pay_date          date        not null,
  status            text        not null default 'borrador'
                                check (status in ('borrador', 'liquidado', 'aprobado', 'pagado', 'anulado')),
  -- La versión de los parámetros legales (payroll/co/params.ts).
  params_version    text        check (params_version is null or length(params_version) <= 40),
  -- Sólo totales, sin nombres: devengado, deducciones, neto, aportes,
  -- provisiones, costo total, número de personas.
  totals            jsonb       not null default '{}'::jsonb,
  employees_count   int         not null default 0 check (employees_count >= 0),
  liquidated_at     timestamptz,
  liquidated_by     uuid        references public.users(id) on delete set null,
  approved_at       timestamptz,
  approved_by       uuid        references public.users(id) on delete set null,
  paid_at           timestamptz,
  paid_by           uuid        references public.users(id) on delete set null,
  -- El aviso «toca pagar la nómina» en vencimientos.
  commitment_id     uuid        references public.commitments(id) on delete set null,
  notes             text        check (notes is null or length(notes) <= 1000),
  created_by        uuid        references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint payroll_periods_dates check (period_end >= period_start),
  constraint payroll_periods_approved check (status not in ('aprobado', 'pagado') or approved_at is not null),
  constraint payroll_periods_paid check (status <> 'pagado' or paid_at is not null)
);

create unique index if not exists payroll_periods_org_range_idx
  on public.payroll_periods (organization_id, period_start, period_end)
  where status <> 'anulado';
create index if not exists payroll_periods_org_status_idx
  on public.payroll_periods (organization_id, status, period_end);

comment on table public.payroll_periods is
  'Cada mes o quincena de nómina de una empresa, con su estado (borrador → liquidado → aprobado → pagado), totales sin nombres y la versión de parámetros legales usada.';

-- ---------------------------------------------------------------------------
-- 4. Vacaciones, permisos, licencias e incapacidades
-- ---------------------------------------------------------------------------
create table if not exists public.leave_requests (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       text        not null references public.ba_organization(id) on delete cascade,
  employee_id           uuid        not null references public.employees(id) on delete cascade,
  requested_by          uuid        references public.users(id) on delete set null,
  kind                  text        not null check (kind in (
                                      'vacaciones', 'permiso', 'licencia_remunerada', 'licencia_no_remunerada',
                                      'licencia_luto', 'calamidad', 'licencia_maternidad', 'licencia_paternidad',
                                      'incapacidad_general', 'incapacidad_laboral')),
  start_date            date        not null,
  end_date              date        not null,
  business_days         numeric(5,1) not null default 0 check (business_days >= 0),
  calendar_days         int         not null default 0 check (calendar_days >= 0),
  status                text        not null default 'pendiente'
                                    check (status in ('pendiente', 'aprobada', 'rechazada', 'cancelada')),
  reason                text        check (reason is null or length(reason) <= 1000),
  decided_by            uuid        references public.users(id) on delete set null,
  decided_at            timestamptz,
  decision_note         text        check (decision_note is null or length(decision_note) <= 1000),
  -- La incapacidad de la EPS, el registro civil… en el Cerebro.
  evidence_document_id  uuid        references public.kb_documents(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint leave_requests_dates check (end_date >= start_date),
  constraint leave_requests_decided check (status in ('pendiente', 'cancelada') or decided_at is not null)
);

create index if not exists leave_requests_org_status_idx
  on public.leave_requests (organization_id, status, start_date);
create index if not exists leave_requests_employee_idx
  on public.leave_requests (organization_id, employee_id, start_date);

comment on table public.leave_requests is
  'Solicitudes de vacaciones, permisos, licencias e incapacidades con su aprobación. Una aprobada se vuelve novedad de nómina (payroll_novelties.leave_request_id).';

-- ---------------------------------------------------------------------------
-- 5. Novedades
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_novelties (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  employee_id       uuid        not null references public.employees(id) on delete cascade,
  kind              text        not null check (kind in (
                                  'hora_extra_diurna', 'hora_extra_nocturna', 'hora_extra_dominical_diurna',
                                  'hora_extra_dominical_nocturna', 'recargo_nocturno', 'recargo_dominical',
                                  'recargo_dominical_nocturno', 'incapacidad_general', 'incapacidad_laboral',
                                  'licencia_maternidad', 'licencia_paternidad', 'licencia_remunerada',
                                  'licencia_no_remunerada', 'ausencia', 'vacaciones', 'comision',
                                  'bonificacion_salarial', 'bonificacion_no_salarial', 'deduccion')),
  date_from         date        not null,
  date_to           date,
  hours             numeric(7,2) check (hours is null or (hours > 0 and hours <= 400)),
  days              numeric(6,2) check (days is null or (days > 0 and days <= 400)),
  amount            numeric(14,2) check (amount is null or amount >= 0),
  note              text        check (note is null or length(note) <= 500),
  source            text        not null default 'manual' check (source in ('manual', 'chat', 'licencia')),
  leave_request_id  uuid        references public.leave_requests(id) on delete cascade,
  status            text        not null default 'activa' check (status in ('activa', 'anulada')),
  created_by        uuid        references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  constraint payroll_novelties_dates check (date_to is null or date_to >= date_from)
);

create index if not exists payroll_novelties_org_date_idx
  on public.payroll_novelties (organization_id, date_from);
create index if not exists payroll_novelties_employee_idx
  on public.payroll_novelties (organization_id, employee_id, date_from);
create unique index if not exists payroll_novelties_leave_idx
  on public.payroll_novelties (leave_request_id) where leave_request_id is not null and status = 'activa';

comment on table public.payroll_novelties is
  'Novedades de nómina por persona: horas extra y recargos (horas), incapacidades, licencias y vacaciones (rango de días), comisiones, bonificaciones y deducciones (valor). CONFIDENCIAL.';

-- ---------------------------------------------------------------------------
-- 6. La liquidación: líneas y desprendibles
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_payslips (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  period_id         uuid        not null references public.payroll_periods(id) on delete cascade,
  employee_id       uuid        not null references public.employees(id) on delete cascade,
  days              jsonb       not null default '{}'::jsonb,
  ibc               jsonb       not null default '{}'::jsonb,
  devengado         numeric(14,2) not null default 0,
  deducciones       numeric(14,2) not null default 0,
  neto              numeric(14,2) not null default 0,
  aportes           numeric(14,2) not null default 0,
  provisiones       numeric(14,2) not null default 0,
  costo_total       numeric(14,2) not null default 0,
  warnings          jsonb       not null default '[]'::jsonb,
  estimates         jsonb       not null default '[]'::jsonb,
  params_version    text        not null check (length(params_version) between 1 and 40),
  created_at        timestamptz not null default now()
);

create unique index if not exists payroll_payslips_period_employee_idx
  on public.payroll_payslips (period_id, employee_id);
create index if not exists payroll_payslips_org_employee_idx
  on public.payroll_payslips (organization_id, employee_id);

create table if not exists public.payroll_items (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  period_id         uuid        not null references public.payroll_periods(id) on delete cascade,
  employee_id       uuid        not null references public.employees(id) on delete cascade,
  line_no           int         not null check (line_no between 1 and 500),
  code              text        not null check (length(code) between 2 and 60),
  item_group        text        not null check (item_group in ('devengado', 'deduccion', 'aporte_empleador', 'provision')),
  label             text        not null check (length(label) between 1 and 200),
  quantity          numeric(10,2),
  unit              text        check (unit is null or unit in ('dias', 'horas')),
  base              numeric(16,2),
  rate              numeric(10,6),
  amount            numeric(14,2) not null,
  explanation       text        not null check (length(explanation) <= 1000),
  is_estimate       boolean     not null default false,
  created_at        timestamptz not null default now()
);

create unique index if not exists payroll_items_line_idx
  on public.payroll_items (period_id, employee_id, line_no);
create index if not exists payroll_items_org_employee_idx
  on public.payroll_items (organization_id, employee_id);

comment on table public.payroll_payslips is
  'El desprendible de cada persona en cada periodo (totales, IBC, días). CONFIDENCIAL: quien administra y la persona misma.';
comment on table public.payroll_items is
  'Las líneas de la liquidación (devengados, deducciones, aportes del empleador, provisiones) con su explicación. CONFIDENCIAL.';

-- ---------------------------------------------------------------------------
-- 7. SG-SST
-- ---------------------------------------------------------------------------
create table if not exists public.sst_settings (
  organization_id       text        primary key references public.ba_organization(id) on delete cascade,
  workers               int         not null default 1 check (workers between 1 and 100000),
  -- La clase de riesgo más alta de sus trabajadores (I a V).
  max_risk_class        smallint    not null default 1 check (max_risk_class between 1 and 5),
  -- COPASST desde 10 trabajadores; vigía por debajo.
  committee             text        not null default 'vigia' check (committee in ('copasst', 'vigia')),
  responsible_user_id   uuid        references public.users(id) on delete set null,
  responsible_name      text        check (responsible_name is null or length(responsible_name) <= 160),
  -- Licencia en SST / curso de 50 horas del responsable.
  responsible_license   text        check (responsible_license is null or length(responsible_license) <= 160),
  arl                   text        check (arl is null or length(arl) <= 80),
  updated_by            uuid        references public.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists public.sst_plan (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       text        not null references public.ba_organization(id) on delete cascade,
  year                  int         not null check (year between 2019 and 2100),
  standard_code         text        not null check (standard_code ~ '^[0-9]+(\.[0-9]+){2}$'),
  title                 text        not null check (length(title) between 3 and 200),
  cycle                 text        not null check (cycle in ('planear', 'hacer', 'verificar', 'actuar')),
  weight                numeric(6,3) not null check (weight >= 0 and weight <= 100),
  status                text        not null default 'pendiente'
                                    check (status in ('pendiente', 'cumple', 'no_cumple', 'no_aplica')),
  justification         text        check (justification is null or length(justification) <= 1000),
  evidence_document_id  uuid        references public.kb_documents(id) on delete set null,
  evidence_url          text        check (evidence_url is null or (length(evidence_url) <= 1000 and evidence_url ~ '^https?://')),
  owner_user_id         uuid        references public.users(id) on delete set null,
  due_date              date,
  commitment_id         uuid        references public.commitments(id) on delete set null,
  evaluated_by          uuid        references public.users(id) on delete set null,
  evaluated_at          timestamptz,
  notes                 text        check (notes is null or length(notes) <= 1000),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists sst_plan_org_year_code_idx
  on public.sst_plan (organization_id, year, standard_code);

create table if not exists public.sst_activities (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       text        not null references public.ba_organization(id) on delete cascade,
  kind                  text        not null check (kind in (
                                      'capacitacion', 'examen_medico', 'inspeccion', 'reunion_copasst', 'reunion_vigia',
                                      'reunion_convivencia', 'simulacro', 'entrega_epp', 'otra')),
  title                 text        not null check (length(title) between 3 and 200),
  planned_date          date,
  done_date             date,
  status                text        not null default 'programada' check (status in ('programada', 'realizada', 'cancelada')),
  participants          int         check (participants is null or participants between 0 and 100000),
  -- Exámenes médicos: a quién y de qué tipo. Nunca el resultado (es historia
  -- clínica y la custodia la IPS).
  employee_id           uuid        references public.employees(id) on delete set null,
  exam_type             text        check (exam_type is null or exam_type in ('ingreso', 'periodico', 'retiro', 'post_incapacidad')),
  standard_code         text        check (standard_code is null or standard_code ~ '^[0-9]+(\.[0-9]+){2}$'),
  evidence_document_id  uuid        references public.kb_documents(id) on delete set null,
  evidence_url          text        check (evidence_url is null or (length(evidence_url) <= 1000 and evidence_url ~ '^https?://')),
  notes                 text        check (notes is null or length(notes) <= 1000),
  commitment_id         uuid        references public.commitments(id) on delete set null,
  created_by            uuid        references public.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint sst_activities_when check (planned_date is not null or done_date is not null),
  constraint sst_activities_done check (status <> 'realizada' or done_date is not null)
);

create index if not exists sst_activities_org_date_idx
  on public.sst_activities (organization_id, coalesce(done_date, planned_date));

create table if not exists public.sst_incidents (
  id                          uuid        primary key default gen_random_uuid(),
  organization_id             text        not null references public.ba_organization(id) on delete cascade,
  kind                        text        not null check (kind in ('accidente', 'incidente', 'enfermedad_laboral')),
  severity                    text        not null default 'leve' check (severity in ('leve', 'grave', 'mortal')),
  occurred_on                 date        not null,
  employee_id                 uuid        references public.employees(id) on delete set null,
  place                       text        check (place is null or length(place) <= 200),
  description                 text        not null check (length(description) between 3 and 2000),
  days_lost                   int         check (days_lost is null or days_lost between 0 and 1000),
  -- Plazos (sst/deadlines.ts): FURAT en 2 días hábiles, investigación en 15.
  furat_due                   date,
  furat_reported_on           date,
  investigation_due           date        not null,
  investigation_done_on       date,
  investigation_document_id   uuid        references public.kb_documents(id) on delete set null,
  ministry_due                date,
  corrective_actions          text        check (corrective_actions is null or length(corrective_actions) <= 2000),
  status                      text        not null default 'abierto' check (status in ('abierto', 'investigado', 'cerrado')),
  furat_commitment_id         uuid        references public.commitments(id) on delete set null,
  investigation_commitment_id uuid        references public.commitments(id) on delete set null,
  reported_by                 uuid        references public.users(id) on delete set null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists sst_incidents_org_date_idx
  on public.sst_incidents (organization_id, occurred_on desc);

comment on table public.sst_plan is
  'La autoevaluación anual del SG-SST por estándar mínimo (Resolución 0312 de 2019) con su peso, estado y evidencia.';
comment on table public.sst_activities is
  'Actividades del SG-SST (capacitaciones, exámenes médicos, inspecciones, COPASST/vigía, simulacros, EPP) programadas y realizadas, con evidencia. Nunca resultados médicos.';
comment on table public.sst_incidents is
  'Accidentes, incidentes y enfermedades laborales con los plazos de FURAT (2 días hábiles) e investigación (15 días), vigilados como vencimientos.';

-- ---------------------------------------------------------------------------
-- 8. Acceso: sólo el servidor
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'payroll_settings', 'employees', 'payroll_periods', 'leave_requests', 'payroll_novelties',
    'payroll_payslips', 'payroll_items', 'sst_settings', 'sst_plan', 'sst_activities', 'sst_incidents'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;
