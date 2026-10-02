-- ===========================================================================
-- PROGRAMAS CONTABLES, CONECTADOS DIRECTO (Siigo hoy; Alegra y QuickBooks)
-- ===========================================================================
-- «Hagamos un conector directo con Siigo, para traer datos, que aparezca en
-- tablas.» Y enseguida: «también Alegra y QuickBooks, y después otros». Hasta
-- aquí un programa contable sólo podía entrar como un CSV que alguien exportaba
-- o como una API propia armada a mano: la cartera no veía las facturas reales y
-- «plata en riesgo» dependía de que alguien subiera PDFs y los confirmara.
--
-- UNA CAPA, VARIOS PROGRAMAS. `accounting_connections` es la llave de la
-- empresa en UN programa contable (`provider`). Lo que cambia de un programa a
-- otro —cómo se autentica, cómo pagina, cómo llama a sus campos— vive en un
-- archivo por programa (packages/agent-tools/src/accounting/providers/). Lo que
-- no cambia —qué tablas se llenan, cómo se reanuda una carga, cómo entra a la
-- cartera— es uno solo. Sumar Alegra es escribir su archivo y ampliar el
-- `check` de `provider`; ninguna tabla nueva.
--
-- LA LLAVE. Lo que el administrador pega una vez (en Siigo: usuario API y
-- access key, de Siigo Nube → Alianzas → Mi credencial API) se guarda como UN
-- blob cifrado (`credentials_enc`), con la misma llave que los tokens de OAuth
-- (`TOKEN_ENCRYPTION_KEY`, AES-256-GCM, packages/core/src/crypto.ts). El token
-- de sesión del programa (24 h en Siigo) también, en `token_enc`, para no pedir
-- uno por corrida. Ninguna lectura que llegue a una pantalla, a una API o al
-- modelo selecciona esas columnas (ver accounting/store.ts). `account_label`
-- es lo único que se muestra: el usuario API, para saber QUÉ empresa está
-- conectada.
--
-- QUÉ SE TRAE. Cada `interval_minutes` (60 por defecto): clientes, productos,
-- facturas de venta y pagos recibidos —lo que la empresa elija en `entities`—
-- a tablas de la empresa («Facturas (Siigo)»…), identificadas por el id del
-- programa en `tracker_rows.external_key` (0161). La primera vez se trae el
-- último año; después, lo creado o cambiado desde la corrida anterior
-- (`cursors`), y una vez al día se repasan las facturas recientes, porque un
-- abono no siempre marca la factura como modificada.
--
-- LA CARTERA. `accounting_invoices` son las facturas por cobrar tal como las
-- dice el programa contable: total, SALDO y vencimiento. La cartera y «plata en
-- riesgo» las suman junto a las facturas confirmadas a mano (0076), con una
-- regla: el saldo lo pone el programa contable, que ya descontó sus propios
-- recibos, así que a estas facturas no se les resta ningún pago de `payments`
-- (sería descontar dos veces el mismo abono). Una factura que también existe
-- como documento confirmado (mismo número) cuenta UNA vez: la del documento.
--
-- LOS PAGOS que trae el programa, además de su tabla, entran a Pagos por el
-- importador de sistema (payments/import.ts) con `source_system = provider`,
-- idempotentes por su referencia.
--
-- LOS AVISOS DE MORA (0159) se reclamaban por `extraction_id`. Una factura del
-- programa contable no es una extracción, así que `receivable_notices` gana
-- `accounting_invoice_id` y exactamente una de las dos columnas va llena.
--
-- No hay clase de aviso nueva: se reutiliza `table_sync` (0161).
-- Tenencia: `organization_id` en las dos tablas, `tenant()` en tenancy/tables.ts.

create table public.accounting_connections (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     text not null,
  provider            text not null check (provider in ('siigo', 'alegra', 'quickbooks')),
  -- Quien la conectó: con su nombre se crean las filas y a su campana llegan
  -- los avisos. Debe ser administrador del espacio (lo exige la pantalla).
  created_by          uuid not null,
  -- Lo que identifica la cuenta conectada sin ser secreto (el usuario API).
  account_label       text not null check (char_length(account_label) between 1 and 200),
  -- JSON cifrado con los campos de la llave del programa. Nunca en claro.
  credentials_enc     text not null check (char_length(credentials_enc) between 20 and 8000),
  token_enc           text check (token_enc is null or char_length(token_enc) <= 12000),
  token_expires_at    timestamptz,
  entities            text[] not null default '{customers,products,invoices,payments}' check (
                        cardinality(entities) between 1 and 4
                        and entities <@ array['customers', 'products', 'invoices', 'payments']::text[]
                      ),
  -- { "invoices": "<tracker uuid>", ... } — las tablas que esta conexión llena.
  trackers            jsonb not null default '{}'::jsonb check (jsonb_typeof(trackers) = 'object'),
  -- Hasta dónde se trajo cada cosa: { "invoices": { "since": "...", "full_at":
  -- "...", "resume": {...} } }. Lo escribe sólo el motor (accounting/sync.ts).
  cursors             jsonb not null default '{}'::jsonb check (jsonb_typeof(cursors) = 'object'),
  interval_minutes    integer not null default 60 check (interval_minutes between 15 and 1440),
  notify              boolean not null default true,
  enabled             boolean not null default true,
  next_run_at         timestamptz not null default now(),
  last_run_at         timestamptz,
  -- 'partial': la corrida se quedó sin tiempo y sigue enseguida (la primera
  -- carga de una empresa grande).
  last_status         text check (last_status is null or last_status in ('ok', 'partial', 'error')),
  last_error          text check (last_error is null or char_length(last_error) <= 500),
  -- { "invoices": { "fetched": 120, "inserted": 3, "updated": 9 }, ... }
  last_counts         jsonb not null default '{}'::jsonb check (jsonb_typeof(last_counts) = 'object'),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint accounting_connections_one_per_provider unique (organization_id, provider)
);

create index accounting_connections_due_idx
  on public.accounting_connections (next_run_at) where enabled;

comment on table public.accounting_connections is
  'La conexión directa de una empresa con un programa contable (Siigo, Alegra, QuickBooks): llave cifrada, qué se trae (clientes, productos, facturas, pagos), cada cuánto y hasta dónde se trajo. Llena tablas de la empresa y la cartera.';

create table public.accounting_invoices (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     text not null,
  -- El programa del que vino ('siigo', 'alegra', 'quickbooks').
  source_system       text not null check (source_system ~ '^[a-z][a-z0-9_-]{1,39}$'),
  -- El id que el programa le da a la factura. Con `source_system` es la
  -- identidad: traerla otra vez actualiza, no duplica.
  source_ref          text not null check (char_length(source_ref) between 1 and 200),
  doc_number          text not null check (char_length(doc_number) between 1 and 120),
  -- Sólo dígitos, sin dígito de verificación: lo mismo que `clients.tax_id`.
  client_nit          text check (client_nit is null or char_length(client_nit) <= 20),
  client_id           uuid,
  counterparty_name   text check (counterparty_name is null or char_length(counterparty_name) <= 200),
  currency            text not null check (currency ~ '^[A-Z]{3}$'),
  total               numeric(18,2) not null check (total >= 0),
  -- Lo que el programa dice que falta por pagar. Manda sobre todo lo demás:
  -- ya descontó los recibos del propio programa.
  balance             numeric(18,2) not null check (balance >= 0),
  issued_on           date not null,
  due_on              date,
  annulled            boolean not null default false,
  public_url          text check (public_url is null or char_length(public_url) <= 1000),
  synced_at           timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint accounting_invoices_source_once unique (organization_id, source_system, source_ref)
);

create index accounting_invoices_open_idx
  on public.accounting_invoices (organization_id, due_on)
  where balance > 0 and not annulled;

create index accounting_invoices_number_idx
  on public.accounting_invoices (organization_id, doc_number);

comment on table public.accounting_invoices is
  'Facturas por cobrar tal como las dice un programa contable conectado (Siigo, Alegra, QuickBooks): total, saldo y vencimiento. La cartera y la plata en riesgo las suman con su saldo, sin restarles pagos otra vez.';

alter table public.accounting_connections enable row level security;
alter table public.accounting_invoices    enable row level security;

revoke all on table public.accounting_connections from public, anon, authenticated;
revoke all on table public.accounting_invoices    from public, anon, authenticated;

grant select, insert, update, delete on table public.accounting_connections to service_role;
grant select, insert, update, delete on table public.accounting_invoices    to service_role;

-- Los avisos de mora, también para facturas de un programa contable.
alter table public.receivable_notices
  alter column extraction_id drop not null;

alter table public.receivable_notices
  add column accounting_invoice_id uuid
    references public.accounting_invoices (id) on delete cascade;

alter table public.receivable_notices
  add constraint receivable_notices_one_invoice
    check (num_nonnulls(extraction_id, accounting_invoice_id) = 1);

create unique index receivable_notices_accounting_once
  on public.receivable_notices (organization_id, accounting_invoice_id, stage)
  where accounting_invoice_id is not null;
