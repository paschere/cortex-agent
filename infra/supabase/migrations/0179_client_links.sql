-- ===========================================================================
-- CLIENTES COMO EJE, SEGUNDA PARTE: TODO LO DE LA PLATA Y EL TRABAJO, COLGADO
-- ===========================================================================
-- 0075 le dio a Cortex el sustantivo «cliente» y le colgó correos, reuniones,
-- documentos, grupos y vencimientos. Lo que quedó suelto fue lo que más se
-- pregunta: la plata y el trabajo. Una factura de Siigo, una línea del
-- extracto, un pago, un caso de cobro, una tarea del equipo — cada uno guarda
-- a su contraparte como texto («COLTRANS S.A.S.», «8300252817») y nada los
-- junta. «¿Cómo va Nexa?» seguía siendo un acto de memoria.
--
-- LA REGLA DE 0075 NO CAMBIA: un vínculo que no se ganó es peor que ninguno.
-- Lo que esta migración agrega son los lugares donde guardar los vínculos que
-- SÍ se ganaron, y una forma más de ganarlos:
--
--   1. `client_aliases` — los otros nombres de un cliente, cada uno con la
--      persona que lo afirmó. «"COLTRANS SAS BOGOTA" en el extracto es
--      Coltrans» es la misma clase de frase que «@coltrans.com es Coltrans»
--      (0075 § 4): una vez dicha, repetirla es aplicarla, no adivinar. Por eso
--      el método `alias` aplica solo y `name_exact` sigue proponiendo.
--
--   2. `client_links` acepta más clases de cosa: factura del programa
--      contable, extracción, pago, movimiento del libro, vencimiento, caso,
--      trabajo y acción. Son propuestas («por confirmar») cuando la evidencia
--      es un nombre; al confirmarse, la columna `client_id` de la tabla dueña
--      se llena (packages/agent-tools/src/clients/links.ts).
--
--   3. `ledger_movements.client_id` — el libro de plata (0172) gana la llave
--      que 0075 le dio a `commitments`: un movimiento con contraparte que ES un
--      cliente apunta a él, y `client_matched_by` dice por qué (NIT del campo
--      estructurado, alias confirmado, o una persona). Sin esto no hay «días de
--      pago» ni «facturado 12 meses» por cliente sin recalcular identidades en
--      cada lectura.
--
--   4. `client_notes` — la nota que alguien registra desde la ficha («llamé a
--      Carlos, paga el viernes»). Memoria del espacio, con autor.
--
--   5. `clients.tags`, `clients.source`, `clients.source_detail` — etiquetas
--      para filtrar la lista y DE DÓNDE salió cada cliente: escrito a mano,
--      creado desde el programa contable, separado de otro, etc. Un cliente
--      que Cortex creó solo tiene que poder distinguirse de uno que alguien
--      registró.
--
-- Tenencia: `organization_id` en las tablas nuevas, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts; RLS deny-all + service_role,
-- igual que 0075. Idempotente.

-- ---------------------------------------------------------------------------
-- 1. Los otros nombres de un cliente
-- ---------------------------------------------------------------------------
create table if not exists public.client_aliases (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  text        not null references public.ba_organization(id) on delete cascade,
  client_id        uuid        not null references public.clients(id) on delete cascade,
  alias            text        not null check (length(btrim(alias)) between 2 and 200),
  -- La misma clave estricta que `clients.name_key` (0075 § 2): sin tildes, sin
  -- puntuación, CON sufijo legal. Generada para que no se desfase.
  alias_key        text        generated always as (public.client_name_key(alias)) stored,
  -- manual: alguien lo escribió. confirmation: alguien confirmó «esto es de
  -- este cliente» desde «Por confirmar» y el nombre quedó aprendido. merge: el
  -- nombre del cliente que se unió a éste. accounting: el nombre con el que lo
  -- trae el programa contable.
  source           text        not null default 'manual'
                               check (source in ('manual', 'confirmation', 'merge', 'accounting')),
  -- Quién lo afirmó. Un alias SIN persona sólo ayuda a encontrar (propone);
  -- uno CON persona se aplica solo, como un dominio registrado.
  verified_by      uuid        references public.users(id) on delete set null,
  verified_at      timestamptz,
  created_at       timestamptz not null default now(),
  constraint client_aliases_verified_pair check ((verified_by is null) = (verified_at is null))
);

-- Un nombre, un cliente. Si dos clientes reclaman «COLTRANS SAS BOGOTA», la
-- base rechaza el segundo: el caso ambiguo no puede existir para resolverse
-- mal después.
create unique index if not exists client_aliases_org_key_idx
  on public.client_aliases (organization_id, alias_key);

create index if not exists client_aliases_client_idx
  on public.client_aliases (client_id);

comment on table public.client_aliases is
  'Otros nombres con los que un cliente aparece en extractos, facturas y grupos. Con verified_by es una afirmación de una persona y se aplica sola (método alias); sin él sólo sirve para proponer.';

-- ---------------------------------------------------------------------------
-- 2. Notas de la ficha
-- ---------------------------------------------------------------------------
create table if not exists public.client_notes (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  text        not null references public.ba_organization(id) on delete cascade,
  client_id        uuid        not null references public.clients(id) on delete cascade,
  body             text        not null check (length(btrim(body)) between 1 and 4000),
  created_by       uuid        references public.users(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists client_notes_client_idx
  on public.client_notes (client_id, created_at desc);

comment on table public.client_notes is
  'Lo que alguien anotó en la ficha de un cliente («llamé a Carlos, paga el viernes»). Sale en la línea de tiempo con su autor.';

-- ---------------------------------------------------------------------------
-- 3. Etiquetas y origen del cliente
-- ---------------------------------------------------------------------------
alter table public.clients
  add column if not exists tags text[] not null default '{}'::text[];

alter table public.clients
  add column if not exists source text not null default 'manual';

alter table public.clients
  add column if not exists source_detail text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'clients_source_check_0179') then
    alter table public.clients
      add constraint clients_source_check_0179
      check (source in ('manual', 'accounting', 'invoice', 'chat', 'split', 'import'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'clients_source_detail_len') then
    alter table public.clients
      add constraint clients_source_detail_len check (source_detail is null or length(source_detail) <= 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'clients_tags_sane') then
    -- Pocas y cortas: una etiqueta es para filtrar, no para escribir notas.
    alter table public.clients
      add constraint clients_tags_sane check (cardinality(tags) <= 20);
  end if;
end $$;

create index if not exists clients_org_tags_idx on public.clients using gin (tags);

comment on column public.clients.source is
  'De dónde salió el cliente: manual (alguien lo registró), accounting/invoice (Cortex lo creó desde el programa contable porque faltaba), chat, split (se separó de otro), import.';

-- ---------------------------------------------------------------------------
-- 4. Más clases de cosa en client_links, y dos métodos más
-- ---------------------------------------------------------------------------
-- Los check de 0075 se escribieron en línea, así que Postgres los nombró
-- `client_links_entity_kind_check` y `client_links_method_check`. Se cambian
-- por versiones con nombre propio que incluyen lo nuevo.
alter table public.client_links drop constraint if exists client_links_entity_kind_check;
alter table public.client_links drop constraint if exists client_links_entity_kind_check_0179;
alter table public.client_links
  add constraint client_links_entity_kind_check_0179 check (entity_kind in (
    'document', 'meeting', 'whatsapp_group', 'email_thread', 'vehicle', 'contact',
    'invoice', 'extraction', 'payment', 'ledger_movement', 'commitment', 'case',
    'work_item', 'action'
  ));

-- alias         un nombre que una persona confirmó para este cliente. APLICA.
-- contact_name  el nombre de un contacto del cliente aparece (p. ej. entre los
--               asistentes de una reunión). PROPONE: dos personas se llaman
--               igual más seguido de lo que parece.
alter table public.client_links drop constraint if exists client_links_method_check;
alter table public.client_links drop constraint if exists client_links_method_check_0179;
alter table public.client_links
  add constraint client_links_method_check_0179 check (method in (
    'email_domain', 'contact_email', 'tax_id', 'name_exact', 'name_partial', 'manual', 'inherited',
    'alias', 'contact_name'
  ));

-- ---------------------------------------------------------------------------
-- 5. El libro de plata sabe de qué cliente es cada movimiento
-- ---------------------------------------------------------------------------
alter table public.ledger_movements
  add column if not exists client_id uuid references public.clients(id) on delete set null;

alter table public.ledger_movements
  add column if not exists client_matched_by text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ledger_movements_client_matched_by_check') then
    alter table public.ledger_movements
      add constraint ledger_movements_client_matched_by_check
      check (client_matched_by is null or client_matched_by in ('tax_id', 'alias', 'person'));
  end if;
  -- Con cliente, siempre se dice por qué; sin cliente, no hay porqué.
  if not exists (select 1 from pg_constraint where conname = 'ledger_movements_client_pair') then
    alter table public.ledger_movements
      add constraint ledger_movements_client_pair
      check ((client_id is null) = (client_matched_by is null));
  end if;
end $$;

create index if not exists ledger_movements_org_client_idx
  on public.ledger_movements (organization_id, client_id, date desc)
  where client_id is not null;

comment on column public.ledger_movements.client_id is
  'El cliente de este movimiento, cuando la contraparte ES un cliente: por NIT del campo estructurado (tax_id), por un alias confirmado (alias) o porque una persona lo dijo (person). Null es legítimo: un proveedor no es cliente.';

-- ---------------------------------------------------------------------------
-- 6. Acceso
-- ---------------------------------------------------------------------------
alter table public.client_aliases enable row level security;
alter table public.client_notes   enable row level security;

revoke all on table public.client_aliases from public, anon, authenticated;
revoke all on table public.client_notes   from public, anon, authenticated;

grant select, insert, update, delete on table public.client_aliases to service_role;
grant select, insert, update, delete on table public.client_notes   to service_role;
