-- ===========================================================================
-- EL LIBRO DE PLATA: UN SOLO LIBRO DE MOVIMIENTOS PARA TODA LA EMPRESA
-- ===========================================================================
-- Hasta aquí la plata de una empresa vivía en cinco lugares que no se hablaban:
-- las facturas de Siigo/Alegra/QuickBooks (0165), los pagos reportados (0098),
-- los extractos del banco (que sólo guardaban los ABONOS, como pagos), las
-- facturas leídas de documentos (0076 + 0143) y lo que alguien decía en el
-- chat. Cortex podía decir cuánto le debían, pero no cuánto gastó en nómina el
-- mes pasado, cuánta caja hay hoy ni si el mes dejó margen. Este es el libro
-- donde todo eso cae junto, con una regla por cada cosa que puede salir mal.
--
-- 1. CADA FILA DICE DE DÓNDE SALIÓ. `source_kind` (accounting, bank, payment,
--    document, sheet, manual, chat), `source_system` ('siigo', 'extracto ·
--    bancolombia corriente', …; cadena vacía cuando la fuente no tiene sistema)
--    y `source_ref` (la identidad del movimiento EN su fuente). Los tres, con
--    la empresa, son únicos: volver a traer lo mismo actualiza, no duplica. La
--    idempotencia la da la base de datos, no un if() de la aplicación.
--
-- 2. UN MOVIMIENTO REAL CONTADO UNA SOLA VEZ. Un mismo pago puede llegar por
--    dos caminos: el recibo de Siigo y el abono del extracto del banco; la
--    factura de Siigo y la misma factura leída de un PDF; lo que alguien dijo
--    en el chat y la salida del banco de ese día. Ninguna fila se borra: la
--    que sobra apunta a la que manda con `duplicate_of` y deja de contar en
--    toda suma. Quién manda, y cuándo dos filas son la misma, está escrito en
--    packages/agent-tools/src/ledger/dedup.ts y se resume así:
--
--      · Mismo `link_key` = mismo hecho, sin duda. Dos reportes que el módulo
--        de pagos ya enlazó al MISMO pago (`payment:<id>`), o dos facturas con
--        el mismo número del mismo lado (`invoice:in:FE88`).
--      · Sin llave común, sólo se enlaza lo inequívoco: liquidado, mismo
--        sentido, misma moneda, mismo valor exacto, a ±3 días, de fuentes de
--        clase distinta, con la contraparte coincidiendo (NIT o nombre) y UN
--        solo candidato. Dos pagos idénticos el mismo día no se funden.
--      · Manda, para plata que ya se movió: banco > programa contable > pago
--        reportado > documento > hoja > a mano > chat (el banco es donde la
--        plata de verdad pasó). Para facturas: documento confirmado > programa
--        contable > hoja > a mano > chat (la misma regla que ya usa la
--        cartera, 0165: una factura en los dos lados cuenta como la del
--        documento). Lo que el agente anotó leyendo un correo o un PDF
--        (`source_kind = 'document'` con `source_system`) pesa como lo dicho
--        a mano: no pasó por la confirmación campo por campo de la 0076.
--
-- 3. LO QUE NO CUENTA SE QUEDA A LA VISTA. `status = 'cancelled'` (anulada,
--    descartada) y `excluded_reason = 'disputed'` (un pago que dos fuentes
--    cuentan distinto, 0098: no está en ninguna cifra hasta que una persona
--    decida) no entran en ningún total, pero no se borran.
--
-- 4. LA CATEGORÍA LA PONE QUIEN MÁS SABE. `category_source`: 'person' (alguien
--    la corrigió; nada automático la vuelve a tocar), 'rule' (una regla de la
--    empresa o una de las de serie), 'model' (el modelo, para lo que ninguna
--    regla reconoce). Corregir una categoría guarda una regla en
--    `ledger_category_rules` que se aplica a lo que llegue después.
--
-- 5. LA CAJA. `ledger_accounts` son las cuentas propias (banco, efectivo) con
--    su último saldo conocido y de cuándo: el saldo final de un extracto
--    importado, o el que alguien dijo a mano. Un extracto viejo no pisa un
--    saldo más nuevo.
--
-- 6. HASTA DÓNDE SE TRAJO. `ledger_sync_state` guarda, por empresa, los
--    cursores de la ingesta incremental (packages/agent-tools/src/ledger/sync.ts).
--
-- Montos positivos en unidades de la moneda (pesos, no centavos), con
-- `direction` diciendo el sentido. Las monedas no se suman nunca entre sí.
--
-- Tenencia: `organization_id` en las cuatro tablas, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. Sólo service_role.

-- ---------------------------------------------------------------------------
-- Cuentas de caja
-- ---------------------------------------------------------------------------
create table public.ledger_accounts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  name             text not null check (char_length(btrim(name)) between 1 and 80),
  -- El nombre normalizado (minúsculas, espacios simples): «Bancolombia
  -- corriente» y «bancolombia  corriente» son la misma cuenta.
  name_key         text not null check (char_length(name_key) between 1 and 80),
  currency         text not null check (currency ~ '^[A-Z]{3}$'),
  -- Puede ser negativo: un sobregiro es un saldo.
  balance          numeric(18,2) not null default 0,
  balance_at       date not null,
  -- Quién dijo el último saldo: el extracto, una persona o el programa contable.
  balance_source   text not null check (balance_source in ('bank', 'manual', 'accounting')),
  source_kind      text not null check (source_kind in ('accounting','bank','payment','document','sheet','manual','chat')),
  source_system    text not null default '' check (char_length(source_system) <= 80),
  source_ref       text not null check (char_length(source_ref) between 1 and 200),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint ledger_accounts_name_once unique (organization_id, name_key)
);

comment on table public.ledger_accounts is
  'Cuentas de caja propias (banco, efectivo) con su último saldo conocido y de cuándo: el saldo final de un extracto importado o el que una persona dijo. Un extracto más viejo no pisa un saldo más nuevo.';

-- ---------------------------------------------------------------------------
-- Reglas de categoría aprendidas de las correcciones
-- ---------------------------------------------------------------------------
create table public.ledger_category_rules (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null,
  -- Dónde se busca el patrón: en la contraparte, en la descripción o en las dos.
  field            text not null default 'any' check (field in ('counterparty', 'description', 'any')),
  -- Texto normalizado (minúsculas, sin tildes, espacios simples) que tiene que
  -- aparecer como palabra o frase completa.
  pattern          text not null check (char_length(pattern) between 2 and 120),
  direction        text not null default 'any' check (direction in ('in', 'out', 'any')),
  category         text not null check (category ~ '^[a-z][a-z0-9_]{1,39}$'),
  created_by       uuid,
  -- Cuántos movimientos ha categorizado; sólo informativo.
  hits             integer not null default 0 check (hits >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint ledger_category_rules_once unique (organization_id, field, pattern, direction)
);

comment on table public.ledger_category_rules is
  'Reglas de la empresa para categorizar movimientos del libro de plata («los pagos a Rappi son mercadeo»). Las crea una corrección de una persona y mandan sobre las reglas de serie y sobre el modelo, nunca sobre una categoría que una persona puso a mano.';

-- ---------------------------------------------------------------------------
-- Los movimientos
-- ---------------------------------------------------------------------------
create table public.ledger_movements (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      text not null,
  direction            text not null check (direction in ('in', 'out')),
  kind                 text not null check (kind in ('income', 'expense', 'receivable', 'payable', 'transfer')),
  status               text not null check (status in ('expected', 'settled', 'cancelled')),
  amount               numeric(18,2) not null check (amount >= 0),
  currency             text not null check (currency ~ '^[A-Z]{3}$'),
  -- Emisión (facturas) o día del movimiento (lo liquidado). Día de Bogotá.
  date                 date not null,
  due_date             date,
  settled_at           date,
  -- Saldo pendiente de una factura; sólo facturas.
  outstanding          numeric(18,2) check (outstanding is null or outstanding >= 0),
  counterparty_name    text check (counterparty_name is null or char_length(counterparty_name) <= 200),
  -- Sólo dígitos (con o sin dígito de verificación, como lo trajo la fuente).
  counterparty_tax_id  text check (counterparty_tax_id is null or counterparty_tax_id ~ '^[0-9]{3,20}$'),
  category             text check (category is null or category ~ '^[a-z][a-z0-9_]{1,39}$'),
  category_source      text check (category_source is null or category_source in ('rule', 'model', 'person')),
  category_rule_id     uuid references public.ledger_category_rules (id) on delete set null,
  description          text not null check (char_length(description) between 1 and 500),
  -- El número de la factura, cuando el movimiento es (o paga) una factura.
  doc_number           text check (doc_number is null or char_length(doc_number) <= 120),
  account_id           uuid references public.ledger_accounts (id) on delete set null,
  source_kind          text not null check (source_kind in ('accounting','bank','payment','document','sheet','manual','chat')),
  source_system        text not null default '' check (char_length(source_system) <= 80),
  source_ref           text not null check (char_length(source_ref) between 1 and 200),
  -- La identidad del HECHO compartida entre fuentes ('payment:<uuid>',
  -- 'invoice:in:FE88'). Mismo link_key = mismo movimiento real.
  link_key             text check (link_key is null or char_length(link_key) <= 200),
  -- La fila que manda cuando ésta es el mismo movimiento real llegado por otra
  -- fuente. Una fila con duplicate_of no cuenta en ninguna suma.
  duplicate_of         uuid references public.ledger_movements (id) on delete set null,
  -- 'disputed': un pago que dos fuentes cuentan distinto (0098). No cuenta.
  excluded_reason      text check (excluded_reason is null or excluded_reason in ('disputed')),
  recorded_by          uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint ledger_movements_source_once unique (organization_id, source_kind, source_system, source_ref),
  constraint ledger_movements_not_self_duplicate check (duplicate_of is null or duplicate_of <> id),
  constraint ledger_movements_outstanding_invoices check (
    outstanding is null or kind in ('receivable', 'payable')
  ),
  constraint ledger_movements_category_pair check (
    (category is null) = (category_source is null)
  )
);

-- Lo que cuenta, por fecha: la lectura de toda suma.
create index ledger_movements_counted_idx
  on public.ledger_movements (organization_id, date desc)
  where duplicate_of is null and status <> 'cancelled' and excluded_reason is null;

-- Lo que está por cobrar / por pagar, por vencimiento (la proyección de caja).
create index ledger_movements_expected_idx
  on public.ledger_movements (organization_id, due_date)
  where status = 'expected' and duplicate_of is null;

-- Encontrar a los hermanos de un mismo hecho.
create index ledger_movements_link_idx
  on public.ledger_movements (organization_id, link_key)
  where link_key is not null;

create index ledger_movements_category_idx
  on public.ledger_movements (organization_id, category, date desc);

create index ledger_movements_account_idx
  on public.ledger_movements (organization_id, account_id, date desc)
  where account_id is not null;

comment on table public.ledger_movements is
  'El libro de plata: lo que entró y salió (settled) y lo que va a entrar o salir (expected), venga de donde venga — programa contable, extracto del banco, pagos reportados, documentos, hojas, el chat — y cada fila dice de dónde salió. Una fila con duplicate_of, cancelada o en disputa no cuenta en ninguna suma. Se escribe desde packages/agent-tools/src/ledger/store.ts.';
comment on column public.ledger_movements.source_ref is
  'La identidad del movimiento EN su fuente. Con organization_id, source_kind y source_system es única: re-ingerir lo mismo actualiza la fila, no la duplica.';
comment on column public.ledger_movements.link_key is
  'La identidad del hecho real compartida entre fuentes: payment:<uuid> (dos reportes del mismo pago, 0098) o invoice:<in|out>:<contraparte>:<número>. Las filas con la misma llave son un solo movimiento: una manda y las demás llevan duplicate_of.';
comment on column public.ledger_movements.duplicate_of is
  'La fila que manda cuando ésta es el mismo movimiento real llegado por otra fuente (el recibo de Siigo y el abono del banco del mismo pago). No se borra: deja de contar. Reglas en ledger/dedup.ts.';
comment on column public.ledger_movements.category_source is
  'person: una persona la puso y nada automático la toca. rule: una regla de la empresa o de serie. model: el modelo, para lo que ninguna regla reconoce.';

-- ---------------------------------------------------------------------------
-- Hasta dónde se trajo
-- ---------------------------------------------------------------------------
create table public.ledger_sync_state (
  organization_id  text primary key,
  -- { "accounting_invoices": "<synced_at>", "payment_reports": "<created_at>", … }
  cursors          jsonb not null default '{}'::jsonb check (jsonb_typeof(cursors) = 'object'),
  last_run_at      timestamptz,
  last_status      text check (last_status is null or last_status in ('ok', 'partial', 'error')),
  last_error       text check (last_error is null or char_length(last_error) <= 500),
  -- { "accounting": 12, "bank": 3, "categorized_model": 8, … }
  last_counts      jsonb not null default '{}'::jsonb check (jsonb_typeof(last_counts) = 'object'),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.ledger_sync_state is
  'Por empresa, hasta dónde trajo la ingesta del libro de plata cada fuente (cursores) y cómo le fue a la última corrida.';

-- ---------------------------------------------------------------------------
-- Acceso
-- ---------------------------------------------------------------------------
alter table public.ledger_accounts        enable row level security;
alter table public.ledger_category_rules  enable row level security;
alter table public.ledger_movements       enable row level security;
alter table public.ledger_sync_state      enable row level security;

revoke all on table public.ledger_accounts        from public, anon, authenticated;
revoke all on table public.ledger_category_rules  from public, anon, authenticated;
revoke all on table public.ledger_movements       from public, anon, authenticated;
revoke all on table public.ledger_sync_state      from public, anon, authenticated;

grant select, insert, update, delete on table public.ledger_accounts        to service_role;
grant select, insert, update, delete on table public.ledger_category_rules  to service_role;
grant select, insert, update, delete on table public.ledger_movements       to service_role;
grant select, insert, update, delete on table public.ledger_sync_state      to service_role;
