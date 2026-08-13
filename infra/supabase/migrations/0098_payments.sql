-- Pagos: lo que de verdad entró, dicho por varias fuentes que no siempre están
-- de acuerdo.
--
-- PARA QUÉ ES ESTO. Desde la 0076 Cortex sabe leer una factura: su número, su
-- importe, su moneda, su cliente y su vencimiento. No sabe si está pagada. Sin
-- eso no hay una sola cifra de negocio que dar — ni cartera, ni saldo por
-- cliente, ni "¿quién me debe?" —, porque todas esas preguntas son una resta y
-- aquí sólo existía el minuendo.
--
-- El dueño dijo de dónde saldrían los pagos: «a mano, o a partir de Siigo,
-- World Office, o el contable, o los bancos. Múltiples fuentes.» Ese plural es
-- el problema entero, y es lo que este esquema está construido para aguantar.
--
-- ===========================================================================
-- DOS TABLAS, Y LA SEPARACIÓN ES TODO EL DISEÑO
-- ===========================================================================
--
--   payment_reports   Una fila por lo que DICE una fuente. Es un hecho sobre
--                     una fuente y un momento, no sobre el dinero: "el extracto
--                     de Bancolombia leído el martes trae un abono de
--                     $4.200.000 el 3 de julio con referencia 887123". Append
--                     only. Nada la corrige, nada la borra.
--
--   payments          Una fila por lo que CREEMOS. Es la conclusión, y es lo
--                     único que entra en un total.
--
-- `payment_reports.payment_id` es NULABLE y apunta hacia arriba. Un reporte sin
-- emparejar está a la espera, visible, contable, y no ha cambiado ninguna cifra
-- todavía. Esa nulabilidad es la que permite recibir una fuente antes de saber
-- qué hacer con ella, en vez de tener que decidir en el momento de la lectura.
--
-- Si esto fuera UNA tabla, el día que se conecte el banco encima del contable
-- la cartera se duplicaría en silencio: dos filas, dos importes, un solo pago.
-- Con dos tablas ese mismo día produce dos reportes y UN pago con dos fuentes,
-- que es lo que pasó de verdad.
--
-- ===========================================================================
-- LA PROCEDENCIA ES LA DE LA 0069, PALABRA POR PALABRA
-- ===========================================================================
-- `source_kind` es `manual | system | document`, con las tres mismas CHECK que
-- `commitments` — `_source_manual`, `_source_system`, `_source_document` — y no
-- se inventa ningún valor nuevo. No es purismo: es lo que hace que añadir una
-- fuente mañana no sea nunca una migración destructiva.
--
--   manual    El contable lo escribió. `source_user_id` NOT NULL: la fuente del
--             dato es su palabra, y su palabra está en la fila.
--
--   system    Siigo, World Office, Bancolombia, el archivo que exportó el
--             contador. `source_system` lo nombra y `source_read_at` dice
--             cuándo se leyó, porque un valor importado es un hecho sobre un
--             MOMENTO y no una verdad permanente.
--
--   document  Un comprobante de pago que llegó por correo y entró a Brain
--             Knowledge. Necesita el documento y `source_quote`: la frase
--             literal de la que se leyó el importe. Igual que en la 0069 y en
--             la 0076, y por la misma razón — una paráfrasis y una invención
--             son indistinguibles una vez guardadas.
--
-- Un comprobante NO necesitó nada nuevo aquí: es un tipo más en DOCUMENT_TYPES
-- (`packages/agent-tools/src/documents/types.ts`, `payment_receipt`), y hereda
-- gratis la cita obligatoria, la verificación de verify.ts y la cola de
-- revisión. La 0076 dijo que añadir un tipo debía ser un objeto nuevo en esa
-- lista y no una migración más un despliegue más un backfill; esta es la
-- primera vez que se cobra esa promesa.
--
-- UNA FUENTE NUEVA CUESTA UN IMPORTADOR Y CERO MIGRACIONES. Conectar Siigo
-- mañana es escribir la función que trae sus movimientos y llamarlos
-- `source_kind='system', source_system='siigo'`. Nada de este archivo cambia.
--
-- ===========================================================================
-- EL ÍNDICE MÁS IMPORTANTE DEL MODELO
-- ===========================================================================
--   unique (organization_id, source_kind, source_system, source_ref)
--     where source_ref is not null
--
-- `source_ref` es el identificador que LA FUENTE le dio al movimiento: el
-- consecutivo del recibo de caja de Siigo, el número de transacción del
-- extracto. Con este índice, reimportar el mismo mes de Siigo es un no-op: el
-- segundo INSERT lo rechaza la base de datos, no un `if (!exists)` esperanzado
-- en código que dos importaciones simultáneas ganan siempre. Es exactamente el
-- papel de `commitment_notices_once_idx` en la 0069.
--
-- Va declarado NULLS NOT DISTINCT (Postgres 15) a propósito: `source_system` es
-- nulo en los reportes manuales y de documento, y con la semántica por defecto
-- —donde dos NULL nunca chocan— el índice no protegería justo esos dos casos.
-- Las columnas son las del diseño aprobado; lo único que se añade es que NULL
-- cuente como un valor, que es lo que la frase "reimportar es un no-op" quiere
-- decir.
--
-- ===========================================================================
-- CUANDO DOS FUENTES DISCREPAN
-- ===========================================================================
-- Cinco reglas, en orden, y la base de datos sostiene las que puede sostener:
--
--   1. DOS FUENTES QUE COINCIDEN SUMAN CONFIANZA, NO IMPORTE. El emparejador
--      enlaza el segundo reporte al pago que ya existe y sube `source_count`.
--      No crea una segunda fila. Sin esto, el día que se conecte el banco la
--      cartera se duplica en silencio.
--
--   2. DOS FUENTES QUE DISCREPAN NO SE PROMEDIAN NI SE RESUELVEN POR RANGO. El
--      pago pasa a `state='disputed'`, y un pago en disputa NO ENTRA EN NINGÚN
--      TOTAL. Es la frase de la 0076 una capa más arriba: dinero no
--      reconciliado no llega a un total. No es un número menor: no está en el
--      número.
--
--   3. HAY JERARQUÍA DE FUENTES (banco > sistema contable > comprobante >
--      manual) PERO SÓLO ORDENA LA COLA DE REVISIÓN Y PRESELECCIONA EL VALOR
--      POR DEFECTO EN LA PANTALLA. NUNCA DECIDE. Por eso no hay ninguna columna
--      aquí que guarde un rango: vive en `sourceRank()` en
--      packages/agent-tools/src/payments/shape.ts, del lado de la presentación,
--      donde no puede convertirse en una resolución automática por accidente.
--      En el momento en que el rango resuelve solo, un extracto que
--      malinterpreta una reversión sobreescribe al contable en silencio, y
--      nadie audita un número que ya parece plausible.
--
--   4. LA ÚNICA AUTORIDAD QUE RESUELVE UNA DISPUTA ES UNA PERSONA.
--      `payments_resolved_needs_human` lo hace imposible de otra forma, igual
--      que `document_fields_confirmed_needs_human` en la 0076.
--
--   5. LAS MONEDAS NUNCA SE MEZCLAN. `currency` es NOT NULL y SIN DEFAULT en
--      las dos tablas, el emparejador jamás cruza monedas distintas, y toda
--      agregación hereda la disciplina `${clave}#${moneda}` de
--      `aggregateRecords`. Asumir COP en una factura de importación es un error
--      de 4.000x en la dirección que parece normal.
--
-- ===========================================================================
-- UNA ANULACIÓN ES UN REPORTE NUEVO, NUNCA UNA EDICIÓN
-- ===========================================================================
-- `kind in ('payment','reversal','adjustment')`. Cuando el banco devuelve un
-- cheque, lo que ocurrió no es que el abono del martes dejara de existir: el
-- banco dijo una cosa un martes y otra el jueves, y las dos son ciertas sobre
-- su propio día. Borrar la primera o mutarla pierde ese hecho, y con él la
-- única forma de entender por qué la cifra cambió.
--
-- Así que `amount` es siempre >= 0 y el SIGNO lo pone `kind`: un `reversal`
-- resta, un `payment` y un `adjustment` suman. Ver `signedAmount()` en shape.ts
-- — un único sitio, para que no haya dos convenios de signo.
--
-- ===========================================================================
-- EL CLIENTE, SÓLO SI EL NIT EMPAREJÓ EXACTO
-- ===========================================================================
-- `client_id` NULABLE Y SE QUEDA NULO salvo que el NIT coincida, con
-- `..._client_needs_match` copiada de la 0076. Nunca por nombre. Un pago mal
-- atribuido no es un hueco visible: es un saldo equivocado en dos clientes a la
-- vez, y en una tabla desde la que se reporta.
--
-- ===========================================================================
-- UNA SOLA PUERTA DE ESCRITURA POR TABLA
-- ===========================================================================
--   public.payments         se escribe SÓLO desde `writePayment()`
--   public.payment_reports  se escribe SÓLO desde `recordPaymentReport()`
--
-- Ambas en packages/agent-tools/src/payments/store.ts. `recordPaymentReport()`
-- es además el único emparejador: inserta el reporte y decide, en la misma
-- llamada, si crea un pago, lo enlaza o lo pone en disputa.
-- `resolvePaymentDispute()` es el único otro que llega a `writePayment()`, y
-- exige la persona. Cualquier otra ruta a estas tablas es un error de revisión.
--
-- ===========================================================================
-- TENANCY
-- ===========================================================================
-- `organization_id` NOT NULL en las dos tablas desde la primera línea, ambas
-- registradas como `tenant()` en packages/agent-tools/src/tenancy/tables.ts, y
-- la aplicación sólo sostiene un handle con alcance (0064). RLS deny-all +
-- service_role, igual que la 0069 y la 0076.
--
-- Idempotente de principio a fin.

-- ===========================================================================
-- 1. Lo que creemos
-- ===========================================================================

create table if not exists public.payments (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,

  -- El dinero -------------------------------------------------------------
  -- Un abono, una devolución, o una corrección de un céntimo mal transcrito.
  -- El signo lo pone esto y no el importe; ver la cabecera.
  kind                text        not null default 'payment'
                                  check (kind in ('payment','reversal','adjustment')),
  amount              numeric(18,2) not null check (amount >= 0),
  -- Tres letras, NOT NULL y SIN DEFAULT. Un importe sin moneda no es un
  -- importe: es un número. Si la fuente no dijo la moneda, el reporte se
  -- rechaza en la aplicación antes de llegar aquí.
  currency            char(3)     not null check (currency ~ '^[A-Z]{3}$'),
  -- El día del abono, no el día en que lo leímos. Fecha de calendario y no
  -- instante, por la razón de la 0069: "pagó hoy" tiene que significar hoy AQUÍ.
  paid_on             date        not null,

  -- Con quién ---------------------------------------------------------------
  client_id           uuid,
  -- El NIT con el que se intentó emparejar, sólo dígitos. Se guarda aunque no
  -- empareje: "leímos 900123456 y ningún cliente lo tiene" es accionable.
  client_nit          text        check (length(client_nit) <= 20),
  client_match_state  text        not null default 'no_nit'
                                  check (client_match_state in ('matched','unmatched','ambiguous','no_nit')),

  -- Qué paga ----------------------------------------------------------------
  -- La factura, cuando se pudo saber cuál. Nulo es normal y frecuente: un
  -- abono a cuenta no nombra ninguna factura, y sigue siendo dinero que entró.
  extraction_id       uuid        references public.document_extractions(id) on delete set null,
  invoice_number      text        check (length(invoice_number) <= 120),

  -- En qué estado está ------------------------------------------------------
  --   reported   Una fuente lo dice y nada lo contradice. Cuenta.
  --   confirmed  Dos fuentes independientes coinciden. Cuenta, y vale más.
  --   disputed   Dos fuentes dicen cosas distintas. NO CUENTA EN NINGÚN TOTAL.
  --   discarded  Una persona dijo que no era real. No cuenta.
  state               text        not null default 'reported'
                                  check (state in ('reported','confirmed','disputed','discarded')),
  -- Cuántas fuentes DISTINTAS han hablado de este pago. Sube al coincidir; el
  -- importe no. Es la regla 1 hecha columna.
  source_count        int         not null default 1 check (source_count >= 0),

  disputed_at         timestamptz,
  -- Qué dijo cada una, en español, para quien tenga que decidir.
  dispute_note        text        check (length(dispute_note) <= 1000),

  resolved_at         timestamptz,
  resolved_by         uuid        references public.users(id) on delete set null,
  resolution_note     text        check (length(resolution_note) <= 1000),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Un vínculo a un cliente sólo es el resultado de un NIT que coincidió.
  constraint payments_client_needs_match check (
    client_id is null or client_match_state = 'matched'
  ),
  -- Una disputa tiene el momento en que se abrió, o no es una disputa.
  constraint payments_disputed_has_time check (
    state <> 'disputed' or disputed_at is not null
  ),
  -- LA REGLA 4, EN LA BASE DE DATOS. No existe la fila que resuelve una disputa
  -- sin nombrar a quién la resolvió, así que no existe el camino de código que
  -- la resuelva sola. Y descartar un pago es siempre un acto de una persona.
  constraint payments_resolved_needs_human check (
    resolved_at is null or resolved_by is not null
  ),
  constraint payments_discarded_needs_human check (
    state <> 'discarded' or (resolved_by is not null and resolved_at is not null)
  )
);

-- La pantalla y las sumas: qué hay en este espacio de trabajo, lo más reciente
-- primero.
create index if not exists payments_org_state_paid_idx
  on public.payments (organization_id, state, paid_on desc);

-- "¿Cuánto me ha pagado este cliente?" — la resta que hace la cartera. Sólo lo
-- que cuenta: un pago en disputa no está en el índice porque no está en la
-- cifra.
create index if not exists payments_org_client_paid_idx
  on public.payments (organization_id, client_id, paid_on)
  where state in ('reported','confirmed');

-- De una factura a lo que se ha abonado contra ella.
create index if not exists payments_org_extraction_idx
  on public.payments (organization_id, extraction_id)
  where extraction_id is not null;

-- La cola de revisión: lo que está en disputa, lo que lleva más tiempo así
-- primero.
create index if not exists payments_org_disputed_idx
  on public.payments (organization_id, disputed_at)
  where state = 'disputed';

comment on table public.payments is
  'Lo que creemos que se pagó: una fila por pago, sea cual sea el número de fuentes que lo digan. Dos fuentes que coinciden suben source_count y no crean una segunda fila; dos que discrepan dejan el pago en state=disputed, y un pago en disputa no entra en ningún total. Se escribe únicamente desde writePayment() en packages/agent-tools/src/payments/store.ts.';

comment on column public.payments.currency is
  'Tres letras, NOT NULL y sin default. Nunca se asume COP: un abono de una factura de importación leído como pesos está equivocado por un factor de cuatro mil, en la dirección que sigue pareciendo un número plausible. Las monedas distintas no se suman nunca.';

comment on column public.payments.state is
  'reported: una fuente lo dice. confirmed: dos fuentes independientes coinciden. disputed: discrepan, y entonces NO ENTRA EN NINGÚN TOTAL — no es una cifra menor, no está en la cifra. discarded: una persona dijo que no era real.';

comment on column public.payments.source_count is
  'Cuántas fuentes distintas han hablado de este pago. Dos fuentes que coinciden suman confianza, no importe: esto sube y amount no se toca.';

comment on column public.payments.client_id is
  'Se pone sólo cuando el NIT coincidió exacto con un cliente. Nunca por nombre. Un pago mal atribuido no es un hueco visible, es un saldo equivocado en dos clientes a la vez.';

comment on column public.payments.kind is
  'payment suma, reversal resta, adjustment suma. amount es siempre positivo y el signo lo pone esto, en un único sitio (signedAmount() en payments/shape.ts). Una anulación es una fila NUEVA de kind=reversal, nunca una edición del abono original.';

-- ===========================================================================
-- 2. Lo que dice cada fuente
-- ===========================================================================
-- Append-only. Un reporte es un hecho sobre una fuente y un momento; corregirlo
-- sería reescribir lo que el banco dijo el martes. Lo único que cambia después
-- de escrito es `payment_id`, que es el emparejamiento, no el contenido.

create table if not exists public.payment_reports (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,

  -- Nulo = a la espera. No ha movido ninguna cifra todavía y está a la vista.
  payment_id          uuid        references public.payments(id) on delete set null,

  kind                text        not null default 'payment'
                                  check (kind in ('payment','reversal','adjustment')),
  amount              numeric(18,2) not null check (amount >= 0),
  currency            char(3)     not null check (currency ~ '^[A-Z]{3}$'),
  paid_on             date        not null,

  client_id           uuid,
  client_nit          text        check (length(client_nit) <= 20),
  client_match_state  text        not null default 'no_nit'
                                  check (client_match_state in ('matched','unmatched','ambiguous','no_nit')),

  extraction_id       uuid        references public.document_extractions(id) on delete set null,
  invoice_number      text        check (length(invoice_number) <= 120),

  -- Lo que la fuente escribió al lado del movimiento, tal cual, para que una
  -- persona reconozca el apunte en su propio sistema.
  reference           text        check (length(reference) <= 200),
  note                text        check (length(note) <= 1000),

  -- DE DÓNDE VIENE. Vocabulario de la 0069, sin inventar valores. ----------
  source_kind         text        not null check (source_kind in ('manual','system','document')),
  source_system       text        check (length(source_system) <= 60),
  source_read_at      timestamptz,
  source_user_id      uuid        references public.users(id) on delete set null,
  source_document_id  uuid        references public.kb_documents(id) on delete set null,
  source_chunk_id     uuid        references public.kb_chunks(id) on delete set null,
  source_quote        text        check (length(source_quote) <= 600),
  -- El identificador que LA FUENTE le dio a este movimiento. La clave de la
  -- reimportación; ver la cabecera y el índice de más abajo.
  source_ref          text        check (length(source_ref) <= 200),

  created_by          uuid        references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),

  -- --- Las tres de la 0069, palabra por palabra ---------------------------
  constraint payment_reports_source_manual check (
    source_kind <> 'manual' or source_user_id is not null
  ),
  constraint payment_reports_source_system check (
    source_kind <> 'system' or (source_system is not null and source_read_at is not null)
  ),
  -- Ocho caracteres no es un juicio sobre la prosa: es el suelo que impide que
  -- "n/a" y "-" pasen por cita.
  constraint payment_reports_source_document check (
    source_kind <> 'document'
    or (source_document_id is not null
        and source_quote is not null
        and length(btrim(source_quote)) >= 8)
  ),
  constraint payment_reports_client_needs_match check (
    client_id is null or client_match_state = 'matched'
  )
);

-- EL ÍNDICE MÁS IMPORTANTE DEL MODELO. Reimportar Siigo es un no-op.
-- NULLS NOT DISTINCT porque source_system es nulo en manual y document, y sin
-- eso el índice protegería sólo el caso que ya está protegido.
create unique index if not exists payment_reports_source_once_idx
  on public.payment_reports (organization_id, source_kind, source_system, source_ref)
  nulls not distinct
  where source_ref is not null;

-- De un pago a todo lo que se ha dicho de él, que es lo que se le enseña a
-- quien tiene que resolver una disputa.
create index if not exists payment_reports_payment_idx
  on public.payment_reports (payment_id, created_at);

-- Lo que llegó y no emparejó con nada: la otra cola de trabajo.
create index if not exists payment_reports_org_waiting_idx
  on public.payment_reports (organization_id, created_at)
  where payment_id is null;

create index if not exists payment_reports_org_client_idx
  on public.payment_reports (organization_id, client_id, paid_on);

comment on table public.payment_reports is
  'Una fila por lo que DICE una fuente sobre un pago: el contable a mano, un movimiento de Siigo o del banco, un comprobante leído de un documento. Append-only: una anulación es un reporte nuevo de kind=reversal, nunca una edición. payment_id nulo significa que todavía no se ha emparejado con ningún pago. Se escribe únicamente desde recordPaymentReport() en packages/agent-tools/src/payments/store.ts.';

comment on column public.payment_reports.source_kind is
  'manual | system | document, el mismo vocabulario que public.commitments (0069) y con las mismas tres CHECK. Nunca nulo y nunca por defecto: un pago cuyo origen no se puede rastrear es exactamente lo que esta tabla existe para no guardar. Conectar Siigo mañana usa system y no cambia el esquema.';

comment on column public.payment_reports.source_ref is
  'El identificador que la propia fuente le dio al movimiento — el consecutivo del recibo de Siigo, el número de la transacción bancaria. Junto con payment_reports_source_once_idx es lo que hace que reimportar el mismo periodo no duplique nada, en la base de datos y no en un if() de la aplicación.';

comment on column public.payment_reports.source_quote is
  'La frase literal del comprobante de la que se leyó el importe, para los reportes de origen document. Verificada verbatim contra el documento en documents/verify.ts antes de llegar aquí: un candidato cuya cita no aparece se descarta en vez de guardarse parafraseado.';

comment on column public.payment_reports.payment_id is
  'El pago al que este reporte contribuye, o nulo mientras está a la espera. Dos reportes que coinciden apuntan al MISMO pago: enlazar es lo que impide que la cartera se duplique el día que se conecte una segunda fuente.';

-- ===========================================================================
-- 3. El vínculo con clientes, en cualquier orden de migraciones
-- ===========================================================================
-- public.clients llegó en la 0075, que ya está aplicada en cualquier base que
-- llegue hasta aquí. La clave ajena se añade igual de forma condicional, con la
-- misma forma que usa la 0076, para que una base reconstruida a mano o una
-- rama que reordene migraciones no falle en este archivo.

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'clients'
  ) then
    if not exists (select 1 from pg_constraint where conname = 'payments_client_id_fkey') then
      alter table public.payments
        add constraint payments_client_id_fkey
        foreign key (client_id) references public.clients(id) on delete set null;
    end if;
    if not exists (select 1 from pg_constraint where conname = 'payment_reports_client_id_fkey') then
      alter table public.payment_reports
        add constraint payment_reports_client_id_fkey
        foreign key (client_id) references public.clients(id) on delete set null;
    end if;
  end if;
end $$;

-- ===========================================================================
-- 4. Acceso
-- ===========================================================================
-- Deny-all + service_role, igual que la 0069 y la 0076. La frontera de
-- inquilino es createOrgScopedClient, no una política contra auth.uid().

alter table public.payments        enable row level security;
alter table public.payment_reports enable row level security;

revoke all on table public.payments        from public, anon, authenticated;
revoke all on table public.payment_reports from public, anon, authenticated;

grant select, insert, update, delete on table public.payments        to service_role;
grant select, insert, update, delete on table public.payment_reports to service_role;
