-- ===========================================================================
-- DOCUMENTOS QUE VENCEN
-- ===========================================================================
-- Una empresa colombiana vive rodeada de papeles con fecha de vencimiento: el
-- SOAT y la revisión técnico-mecánica de cada vehículo, las pólizas, las
-- licencias y los permisos de funcionamiento, las habilitaciones del
-- ministerio, los certificados, los contratos con clientes. Casi todos ya
-- están en el Cerebro (subidos, sincronizados de Drive, adjuntos del correo);
-- lo que nadie hace es leerles la fecha y avisar a tiempo.
--
-- Esta migración guarda dos cosas:
--
--   1. `document_expirations` — un papel que vence: qué es (`kind`), de quién
--      o de qué (`subject`: una placa, un cliente, una persona, la empresa),
--      quién lo expidió, su número, desde cuándo y hasta cuándo, con cuánta
--      anticipación hay que renovarlo y quién responde. La fecha leída de un
--      documento viaja SIEMPRE con la frase que la dice (`expires_quote`,
--      `issued_quote`): una fecha sin su cita es indistinguible de una
--      inventada. Lo que no se pudo verificar se guarda sin fecha y con
--      `needs_review`, nunca con una fecha calculada.
--
--      NADA SE VIGILA SIN UNA PERSONA. Igual que en `commitments` (0069), una
--      fecha leída por el modelo es una propuesta: `needs_review = true` hasta
--      que alguien la confirma (`confirmed_by`/`confirmed_at`). Sólo entonces
--      nace su vencimiento en `commitments` (`commitment_id`) con responsable y
--      aviso a `renewal_lead_days`, y desde ahí lo cuidan el vigilante diario,
--      el resumen de vencidos y el piloto automático. Un registro a mano
--      (`source = 'manual'`) nace confirmado por quien lo escribió.
--
--      RENOVAR CIERRA LO VIEJO. Un documento nuevo del mismo tipo y del mismo
--      sujeto con una fecha posterior marca el anterior como `renovado`
--      (`renewed_by_id`) y da por cumplido su vencimiento.
--
--   2. `document_expiration_scans` — qué documentos ya se miraron, con qué
--      resultado y si costó una llamada al modelo. Es lo que hace idempotente
--      la lectura al llegar un documento y el barrido de lo que ya había: un
--      documento mirado no se vuelve a pagar. También lleva la pista de una
--      renovación subida desde la pantalla (`renews_expiration_id`).
--
-- La renovación de la matrícula mercantil (Cámara de Comercio) NO vive aquí:
-- es una fecha del calendario tributario (0180, /impuestos).
--
-- Tenencia: `organization_id` en las dos, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. RLS encendido sin políticas
-- (deny-all) y sólo service_role. Idempotente.

-- ---------------------------------------------------------------------------
-- 1. Los papeles que vencen
-- ---------------------------------------------------------------------------
create table if not exists public.document_expirations (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null references public.ba_organization(id) on delete cascade,
  -- El documento del Cerebro de donde salió (o el que lo respalda, si se
  -- registró a mano). `set null`: si borran el documento, la fecha confirmada
  -- sigue siendo un hecho con su cita guardada aquí.
  document_id         uuid        references public.kb_documents(id) on delete set null,
  -- El fragmento donde está la cita. Sin llave foránea a propósito: los
  -- fragmentos se reemplazan cuando el documento se vuelve a leer.
  chunk_id            uuid,
  -- El espacio del Cerebro del documento, para no enseñarle la cita ni el
  -- título a quien no ve ese espacio.
  space_id            uuid        references public.kb_collections(id) on delete set null,
  source              text        not null default 'documento'
                                  check (source in ('documento', 'manual')),
  kind                text        not null
                                  check (kind in ('poliza', 'soat', 'tecnomecanica', 'licencia',
                                                  'permiso', 'contrato', 'certificado',
                                                  'habilitacion', 'otro')),
  title               text        not null check (length(btrim(title)) between 2 and 200),
  -- De qué o de quién es el papel.
  subject_kind        text        not null default 'empresa'
                                  check (subject_kind in ('vehiculo', 'cliente', 'empleado',
                                                          'empresa', 'otro')),
  subject             text        check (subject is null or length(subject) <= 200),
  -- La misma clave para «WGY 482», «wgy-482» y «WGY482»: así se reconoce la
  -- renovación del mismo sujeto. Generada para que no se desfase.
  subject_key         text        generated always as (
                        lower(regexp_replace(coalesce(subject, ''), '[^[:alnum:]]+', '', 'g'))
                      ) stored,
  vehicle_id          uuid        references public.vehicles(id) on delete set null,
  client_id           uuid        references public.clients(id) on delete set null,
  issuer              text        check (issuer is null or length(issuer) <= 200),
  number              text        check (number is null or length(number) <= 120),
  issued_on           date,
  expires_on          date,
  -- La frase literal del documento que dice cada fecha.
  issued_quote        text        check (issued_quote is null or length(issued_quote) <= 600),
  expires_quote       text        check (expires_quote is null or length(expires_quote) <= 600),
  renewal_lead_days   integer     not null default 30 check (renewal_lead_days between 0 and 365),
  owner_user_id       uuid        references public.users(id) on delete set null,
  -- vigente / por_vencer / vencido se recalculan con la fecha en cada lectura
  -- (esta columna es su caché); renovado y descartado son decisiones.
  status              text        not null default 'vigente'
                                  check (status in ('vigente', 'por_vencer', 'vencido',
                                                    'renovado', 'descartado')),
  -- Calculada por reglas, nunca dicha por el modelo: alta = la cita existe,
  -- dice la fecha y el documento se nombra; media = falta algo de lo demás;
  -- baja = la fecha no se pudo verificar.
  confidence          text        not null default 'baja'
                                  check (confidence in ('alta', 'media', 'baja')),
  needs_review        boolean     not null default true,
  -- Por qué hay que revisarla, en palabras («la cita no dice el año»).
  review_note         text        check (review_note is null or length(review_note) <= 600),
  confirmed_by        uuid        references public.users(id) on delete set null,
  confirmed_at        timestamptz,
  commitment_id       uuid        references public.commitments(id) on delete set null,
  renewed_by_id       uuid        references public.document_expirations(id) on delete set null,
  renewed_at          timestamptz,
  dismissed_reason    text        check (dismissed_reason is null or length(dismissed_reason) <= 500),
  model_id            text,
  extractor_version   text,
  created_by          uuid        references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- Nada sale de revisión sin una persona y sin fecha.
  constraint document_expirations_review_needs_human
    check (needs_review or confirmed_at is not null),
  constraint document_expirations_watched_has_date
    check (needs_review or status in ('renovado', 'descartado') or expires_on is not null),
  -- Una fecha leída de un documento sin confirmar lleva su cita.
  constraint document_expirations_read_date_has_quote
    check (source <> 'documento' or expires_on is null or confirmed_at is not null
           or expires_quote is not null),
  -- Quien confirma deja su hora. (Al revés no: si la persona se borra del
  -- directorio, `confirmed_by` queda nulo y la hora sigue siendo verdad.)
  constraint document_expirations_confirmed_pair
    check (confirmed_by is null or confirmed_at is not null),
  constraint document_expirations_dates_order
    check (issued_on is null or expires_on is null or issued_on <= expires_on)
);

-- Una lectura por (documento, tipo, sujeto): volver a leer el mismo documento
-- actualiza en vez de duplicar.
create unique index if not exists document_expirations_doc_kind_subject_idx
  on public.document_expirations (organization_id, document_id, kind, subject_key)
  where document_id is not null;

-- La pantalla y «¿qué vence este mes?».
create index if not exists document_expirations_org_expires_idx
  on public.document_expirations (organization_id, expires_on)
  where status not in ('renovado', 'descartado');

-- La cola «por revisar».
create index if not exists document_expirations_review_idx
  on public.document_expirations (organization_id, created_at desc)
  where needs_review and status <> 'descartado';

-- La renovación: lo abierto del mismo tipo y sujeto.
create index if not exists document_expirations_subject_idx
  on public.document_expirations (organization_id, kind, subject_key, expires_on);

create index if not exists document_expirations_vehicle_idx
  on public.document_expirations (vehicle_id) where vehicle_id is not null;
create index if not exists document_expirations_client_idx
  on public.document_expirations (client_id) where client_id is not null;
create index if not exists document_expirations_commitment_idx
  on public.document_expirations (commitment_id) where commitment_id is not null;

comment on table public.document_expirations is
  'Papeles con fecha de vencimiento (SOAT, tecnomecánica, pólizas, licencias, permisos, contratos, certificados, habilitaciones). La fecha leída de un documento lleva su cita (expires_quote) y espera a una persona (needs_review) antes de vigilarse; al confirmarse nace su vencimiento en commitments (commitment_id). Un documento posterior del mismo tipo y sujeto lo marca renovado.';
comment on column public.document_expirations.needs_review is
  'true = propuesta sin confirmar: no se vigila ni avisa. Sale de aquí sólo con confirmed_by/confirmed_at.';
comment on column public.document_expirations.confidence is
  'Calculada por reglas deterministas (cita verificada, fecha escrita en la cita, documento que se nombra), nunca reportada por el modelo.';

-- ---------------------------------------------------------------------------
-- 2. Qué documentos ya se miraron
-- ---------------------------------------------------------------------------
create table if not exists public.document_expiration_scans (
  id                     uuid        primary key default gen_random_uuid(),
  organization_id        text        not null references public.ba_organization(id) on delete cascade,
  document_id            uuid        not null references public.kb_documents(id) on delete cascade,
  -- queued: hay una pista (renovación subida) y aún no se lee.
  -- found: salió al menos un vencimiento. none: se miró y no es un papel que
  -- venza. skipped: no se miró (espacio personal, sin texto). failed: falló.
  outcome                text        not null default 'queued'
                                     check (outcome in ('queued', 'found', 'none', 'skipped', 'failed')),
  model_called           boolean     not null default false,
  detail                 text        check (detail is null or length(detail) <= 600),
  renews_expiration_id   uuid        references public.document_expirations(id) on delete set null,
  extractor_version      text,
  scanned_at             timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create unique index if not exists document_expiration_scans_doc_idx
  on public.document_expiration_scans (organization_id, document_id);

comment on table public.document_expiration_scans is
  'Un documento del Cerebro ya mirado en busca de fechas de vencimiento, con su resultado y si costó una llamada al modelo. Hace idempotentes la lectura al llegar y el barrido de lo que ya había.';

-- ---------------------------------------------------------------------------
-- 3. Acceso: sólo el servicio. La app filtra por empresa (getOrgScopedClient).
-- ---------------------------------------------------------------------------
alter table public.document_expirations      enable row level security;
alter table public.document_expiration_scans enable row level security;

revoke all on table public.document_expirations      from public, anon, authenticated;
revoke all on table public.document_expiration_scans from public, anon, authenticated;

grant select, insert, update, delete on table public.document_expirations      to service_role;
grant select, insert, update, delete on table public.document_expiration_scans to service_role;
