-- ===========================================================================
-- ESTADOS FINANCIEROS, PRESUPUESTO E INFORME PARA SOCIOS
-- ===========================================================================
-- Hasta aquí Cortex sabía la CAJA (el libro de plata, 0172; la proyección a 13
-- semanas, 0173) pero no le contestaba al dueño las tres preguntas de cada
-- mes: «¿cómo nos fue?» (estado de resultados y balance, con sus
-- indicadores), «¿cómo vamos contra lo que dijimos?» (presupuesto contra
-- real) y «¿qué le digo a mis socios?» (el informe mensual).
--
-- Los cálculos son puros y viven en el código (packages/agent-tools/src/
-- statements, budget, forecast, board). Esta migración guarda sólo lo que una
-- persona decide o lo que cuesta volver a pedir:
--
--   1. `statement_settings` — cómo se clasifica cada categoría de gasto del
--      libro: costo de ventas, gasto variable, gasto fijo, financiero o
--      impuestos. De ahí salen la utilidad bruta, la operacional, el punto de
--      equilibrio y el EBITDA aproximado. Sin fila, la clasificación por
--      defecto del código (statements/classify.ts). La escribe quien
--      administra o es dueño.
--
--   2. `accounting_report_snapshots` — lo último que devolvió el programa
--      contable (Siigo: balance de prueba; Alegra: balance general y estado de
--      resultados; QuickBooks: BalanceSheet y ProfitAndLoss), ya traducido a
--      una forma común. Pedirlo cuesta segundos (Siigo arma un Excel), así que
--      la pantalla lee la copia y se refresca a pedido. Una fila por programa,
--      clase y período.
--
--   3. `budgets` + `budget_lines` — el presupuesto del año, por versión
--      (borrador, aprobado, archivado), y sus líneas: categoría × mes × monto.
--      Sólo uno aprobado por año. Se crea desde lo real del año anterior ± un
--      porcentaje, o desde cero; se edita en la grilla de /presupuesto.
--
--   4. `board_report_settings` — el informe para socios: si se arma solo el
--      día N de cada mes (una rutina de `scheduled_jobs` que la persona
--      enciende; `job_id`), y a qué correos se manda (siempre con aprobación).
--
--   5. `board_reports` — cada informe mensual, uno por empresa y mes, con sus
--      secciones y cifras (`content`) y el texto (`markdown`). Su enlace para
--      compartir (`share_token`) con contraseña opcional, igual que una vista
--      compartida (0156): el intento se gasta en la base antes de comparar
--      (`board_report_reserve_unlock`) y a la décima fallida se cierra quince
--      minutos.
--
-- Tenencia: `organization_id` en todas, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts; las dos funciones son
-- 'organization' en RPC_TENANCY. RLS encendido sin políticas (deny-all) y
-- sólo service_role. Idempotente.

-- ---------------------------------------------------------------------------
-- 1. Cómo se clasifica cada categoría de gasto
-- ---------------------------------------------------------------------------
create table if not exists public.statement_settings (
  organization_id   text        primary key references public.ba_organization(id) on delete cascade,
  -- { "proveedores": "costo", "arriendo": "fijo", … }. Sólo las que cambian
  -- frente al defecto; el código valida las clases.
  category_classes  jsonb       not null default '{}'::jsonb check (jsonb_typeof(category_classes) = 'object'),
  updated_by        uuid        references public.users(id) on delete set null,
  updated_at        timestamptz not null default now()
);

comment on table public.statement_settings is
  'Cómo clasifica cada empresa sus categorías de gasto para el estado de resultados (costo, variable, fijo, financiero, impuestos). Sin fila, el defecto de statements/classify.ts.';

-- ---------------------------------------------------------------------------
-- 2. Lo último que dijo el programa contable
-- ---------------------------------------------------------------------------
create table if not exists public.accounting_report_snapshots (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  provider          text        not null check (provider in ('siigo', 'alegra', 'quickbooks')),
  kind              text        not null check (kind in ('balance', 'pnl')),
  -- balance: «2026-09-30» (fecha de corte). pnl: «2026-01-01..2026-09-30».
  period_key        text        not null check (char_length(period_key) between 7 and 40),
  payload           jsonb       not null check (jsonb_typeof(payload) = 'object'),
  fetched_at        timestamptz not null default now(),
  fetched_by        uuid        references public.users(id) on delete set null
);

create unique index if not exists accounting_report_snapshots_key_idx
  on public.accounting_report_snapshots (organization_id, provider, kind, period_key);

comment on table public.accounting_report_snapshots is
  'Balance general y estado de resultados leídos del programa contable (Siigo, Alegra, QuickBooks) en una forma común, con su fecha de lectura. Copia para no pedirlos en cada visita.';

-- ---------------------------------------------------------------------------
-- 3. El presupuesto
-- ---------------------------------------------------------------------------
create table if not exists public.budgets (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  year              int         not null check (year between 2020 and 2100),
  version           int         not null default 1 check (version between 1 and 99),
  name              text        not null check (char_length(btrim(name)) between 1 and 120),
  status            text        not null default 'borrador'
                                check (status in ('borrador', 'aprobado', 'archivado')),
  -- De dónde salió: lo real del año anterior ± un porcentaje, o desde cero.
  basis             text        not null default 'desde_cero'
                                check (basis in ('ultimo_anio', 'desde_cero', 'copia')),
  growth_pct        numeric(7,2) check (growth_pct is null or growth_pct between -95 and 500),
  currency          text        not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  notes             text        check (notes is null or char_length(notes) <= 2000),
  created_by        uuid        references public.users(id) on delete set null,
  approved_by       uuid        references public.users(id) on delete set null,
  approved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint budgets_approved_pair check (status <> 'aprobado' or approved_at is not null)
);

create unique index if not exists budgets_org_year_version_idx
  on public.budgets (organization_id, year, version);

-- Un solo presupuesto aprobado por año: el que se compara contra lo real.
create unique index if not exists budgets_one_approved_idx
  on public.budgets (organization_id, year) where status = 'aprobado';

comment on table public.budgets is
  'El presupuesto anual de cada empresa, por versión (borrador, aprobado, archivado). Uno solo aprobado por año: es el que se compara contra lo real.';

create table if not exists public.budget_lines (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  budget_id         uuid        not null references public.budgets(id) on delete cascade,
  -- Una categoría del libro de plata (ventas, otros_ingresos, nomina,
  -- arriendo…) o una propia en minúsculas con guion bajo.
  category          text        not null check (category ~ '^[a-z0-9_]{2,60}$'),
  kind              text        not null check (kind in ('ingreso', 'gasto')),
  month             int         not null check (month between 1 and 12),
  amount            numeric(18,2) not null default 0 check (amount >= 0 and amount < 1e15),
  updated_by        uuid        references public.users(id) on delete set null,
  updated_at        timestamptz not null default now()
);

create unique index if not exists budget_lines_cell_idx
  on public.budget_lines (budget_id, category, month);
create index if not exists budget_lines_org_idx
  on public.budget_lines (organization_id, budget_id);

comment on table public.budget_lines is
  'Cada celda del presupuesto: categoría × mes × monto (positivo; `kind` dice si es ingreso o gasto).';

-- ---------------------------------------------------------------------------
-- 4. El informe para socios: la configuración
-- ---------------------------------------------------------------------------
create table if not exists public.board_report_settings (
  organization_id   text        primary key references public.ba_organization(id) on delete cascade,
  -- Encendido = existe la rutina (`job_id`) que lo arma el día `day_of_month`.
  enabled           boolean     not null default false,
  day_of_month      int         not null default 5 check (day_of_month between 1 and 28),
  hour              int         not null default 7 check (hour between 0 and 23),
  -- A quién se le manda (siempre con aprobación de una persona).
  recipients        jsonb       not null default '[]'::jsonb
                                check (jsonb_typeof(recipients) = 'array' and jsonb_array_length(recipients) <= 25),
  job_id            uuid        references public.scheduled_jobs(id) on delete set null,
  updated_by        uuid        references public.users(id) on delete set null,
  updated_at        timestamptz not null default now()
);

comment on table public.board_report_settings is
  'El informe mensual para socios de cada empresa: si se arma solo (rutina job_id el día day_of_month) y a qué correos se manda con aprobación.';

-- ---------------------------------------------------------------------------
-- 5. Cada informe
-- ---------------------------------------------------------------------------
create table if not exists public.board_reports (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  -- El mes que informa: «2026-09».
  period            text        not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status            text        not null default 'borrador' check (status in ('borrador', 'enviado')),
  title             text        not null check (char_length(btrim(title)) between 3 and 200),
  -- Secciones, cifras (con su display) y lo que faltó leer. Ver board/shape.ts.
  content           jsonb       not null check (jsonb_typeof(content) = 'object'),
  markdown          text        not null check (char_length(markdown) <= 60000),
  -- El resumen lo escribió la plantilla y no el modelo (no contestó o inventó).
  fallback          boolean     not null default false,
  generated_by      uuid        references public.users(id) on delete set null,
  generated_at      timestamptz not null default now(),
  -- La puerta de afuera, como una vista compartida (0156).
  visibility        text        not null default 'privado'
                                check (visibility in ('privado', 'enlace', 'contrasena')),
  share_token       text        unique check (share_token is null or share_token ~ '^[A-Za-z0-9_-]{32,64}$'),
  share_expires_at  timestamptz,
  share_views       int         not null default 0,
  password_hash     text,
  failed_unlocks    int         not null default 0,
  locked_until      timestamptz,
  sent_at           timestamptz,
  sent_to           jsonb       not null default '[]'::jsonb check (jsonb_typeof(sent_to) = 'array'),
  sent_by           uuid        references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint board_reports_door check (
    (visibility = 'privado' and share_token is null and password_hash is null)
    or (visibility = 'enlace' and share_token is not null and password_hash is null)
    or (visibility = 'contrasena' and share_token is not null and password_hash is not null)
  ),
  constraint board_reports_sent_pair check (status <> 'enviado' or sent_at is not null)
);

create unique index if not exists board_reports_org_period_idx
  on public.board_reports (organization_id, period);

comment on table public.board_reports is
  'El informe mensual para socios: secciones y cifras sacadas sólo de los datos (content), su texto, y su enlace para compartir con contraseña opcional.';

-- ---------------------------------------------------------------------------
-- 6. La contraseña del enlace: gastar el intento antes de comparar
-- ---------------------------------------------------------------------------
create or replace function public.board_report_reserve_unlock(p_organization_id text, p_report_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.board_reports;
begin
  select * into r from public.board_reports
   where id = p_report_id and organization_id = p_organization_id
     and visibility = 'contrasena'
   for update;
  if not found then return null; end if;
  if r.locked_until is not null and r.locked_until > now() then
    return jsonb_build_object('locked', true, 'until', r.locked_until);
  end if;
  if r.failed_unlocks + 1 >= 10 then
    update public.board_reports
       set failed_unlocks = 0, locked_until = now() + interval '15 minutes'
     where id = r.id;
  else
    update public.board_reports
       set failed_unlocks = r.failed_unlocks + 1, locked_until = null
     where id = r.id;
  end if;
  return jsonb_build_object('locked', false, 'hash', r.password_hash);
end $$;

create or replace function public.board_report_clear_unlocks(p_organization_id text, p_report_id uuid)
returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.board_reports
     set failed_unlocks = 0, locked_until = null
   where id = p_report_id and organization_id = p_organization_id;
$$;

revoke all on function public.board_report_reserve_unlock(text, uuid) from public, anon, authenticated;
revoke all on function public.board_report_clear_unlocks(text, uuid) from public, anon, authenticated;
grant execute on function public.board_report_reserve_unlock(text, uuid) to service_role;
grant execute on function public.board_report_clear_unlocks(text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Acceso: sólo el servidor
-- ---------------------------------------------------------------------------
alter table public.statement_settings          enable row level security;
alter table public.accounting_report_snapshots enable row level security;
alter table public.budgets                     enable row level security;
alter table public.budget_lines                enable row level security;
alter table public.board_report_settings       enable row level security;
alter table public.board_reports               enable row level security;

revoke all on table public.statement_settings          from public, anon, authenticated;
revoke all on table public.accounting_report_snapshots from public, anon, authenticated;
revoke all on table public.budgets                     from public, anon, authenticated;
revoke all on table public.budget_lines                from public, anon, authenticated;
revoke all on table public.board_report_settings       from public, anon, authenticated;
revoke all on table public.board_reports               from public, anon, authenticated;

grant select, insert, update, delete on table public.statement_settings          to service_role;
grant select, insert, update, delete on table public.accounting_report_snapshots to service_role;
grant select, insert, update, delete on table public.budgets                     to service_role;
grant select, insert, update, delete on table public.budget_lines                to service_role;
grant select, insert, update, delete on table public.board_report_settings       to service_role;
grant select, insert, update, delete on table public.board_reports               to service_role;
