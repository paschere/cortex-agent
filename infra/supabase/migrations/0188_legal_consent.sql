-- ===========================================================================
-- LA CAPA LEGAL: AUTORIZACIÓN, CONSULTAS Y RECLAMOS, Y DERECHOS DEL TITULAR
-- ===========================================================================
-- Ley 1581 de 2012 y Decreto 1377 de 2013 (compilado en el DUR 1074 de 2015):
-- quien trata datos personales en Colombia necesita la AUTORIZACIÓN previa,
-- expresa e informada del titular, tiene que poder PROBARLA después, y tiene que
-- atender consultas (10 días hábiles) y reclamos (15 días hábiles). Esta
-- migración guarda las cuatro cosas que eso exige del producto:
--
--   1. `legal_consents` — quién aceptó qué documento, en qué versión, cuándo, y
--      desde dónde (huella de la IP, nunca la IP en claro, y el navegador). Es la
--      prueba de la autorización (art. 9 de la ley; art. 7 del decreto). Una fila
--      por (persona, documento, versión): cambiar la versión del documento deja a
--      todos sin fila para la versión nueva, y la aplicación vuelve a pedirla.
--      Es de la PERSONA (ba_user), no de una empresa: quien está en dos espacios
--      autoriza una vez. `organization_id` sólo dice desde qué espacio aceptó.
--
--   2. `legal_requests` — las consultas y los reclamos del titular, con su plazo
--      legal ya calculado en días hábiles colombianos (`due_on`) y la prórroga
--      que la ley permite (`extended_due_on`: 5 días más para consultas, 8 para
--      reclamos, avisando el motivo). También de la persona. Se conserva aunque
--      la cuenta se borre (`user_id` → null, `requester_email` queda): es la
--      prueba de que la solicitud se atendió.
--
--   3. `data_exports` — «descargar todos los datos»: de la empresa (dueño o
--      administrador) o los propios. Un trabajo de fondo arma un ZIP en
--      app_files y la fila guarda dónde quedó y hasta cuándo se puede bajar.
--
--   4. `organization_deletions` — «eliminar la cuenta de la empresa»: 30 días de
--      gracia cancelables y luego el borrado total. También el espacio personal
--      de quien borra su usuario (sin gracia: era sólo suyo). SIN llave foránea a
--      ba_organization a propósito: la fila tiene que sobrevivir al borrado de la
--      empresa, porque es lo que prueba que se borró, cuándo y a pedido de quién.
--
-- Tenencia (packages/agent-tools/src/tenancy/tables.ts):
--   legal_consents, legal_requests      → shared (son de la persona, como
--                                          ba_two_factor; se leen siempre por el
--                                          id de la sesión).
--   data_exports, organization_deletions → tenant.
-- RLS encendido sin políticas (deny-all), revocado a anon/authenticated y sólo
-- service_role. Idempotente.

-- ---------------------------------------------------------------------------
-- 1. Autorizaciones
-- ---------------------------------------------------------------------------
create table if not exists public.legal_consents (
  id               uuid        primary key default gen_random_uuid(),
  user_id          text        not null references public.ba_user(id) on delete cascade,
  -- Desde qué espacio se aceptó, si había uno (en el registro todavía no hay).
  organization_id  text        references public.ba_organization(id) on delete set null,
  document         text        not null
                               check (document in ('tratamiento', 'terminos', 'privacidad')),
  -- La versión del texto aceptado, p. ej. '2026-10-03'. Ver lib/legal/versions.ts.
  version          text        not null check (length(version) between 1 and 40),
  accepted_at      timestamptz not null default now(),
  -- sha256(salt || ip). Prueba sin guardar la IP en claro.
  ip_hash          text        check (ip_hash is null or length(ip_hash) <= 128),
  user_agent       text        check (user_agent is null or length(user_agent) <= 400),
  -- Dónde se dio: la casilla del registro o el aviso de versión nueva en la app.
  source           text        not null default 'app'
                               check (source in ('registro', 'app')),
  -- Revocar la autorización (art. 8 e) de la ley) deja la fila y marca la hora.
  revoked_at       timestamptz,
  constraint legal_consents_one_per_version unique (user_id, document, version)
);

create index if not exists legal_consents_user_idx
  on public.legal_consents (user_id, document, accepted_at desc);

comment on table public.legal_consents is
  'Prueba de la autorización del titular (Ley 1581 art. 9, Decreto 1377 art. 7): documento, versión, hora, huella de IP y navegador. Una fila por persona, documento y versión.';

-- ---------------------------------------------------------------------------
-- 2. Consultas y reclamos
-- ---------------------------------------------------------------------------
create table if not exists public.legal_requests (
  id                uuid        primary key default gen_random_uuid(),
  -- La persona. `set null`: la solicitud sobrevive a la cuenta como prueba.
  user_id           text        references public.ba_user(id) on delete set null,
  organization_id   text        references public.ba_organization(id) on delete set null,
  requester_email   text        not null check (length(requester_email) between 3 and 320),
  requester_name    text        check (requester_name is null or length(requester_name) <= 200),
  -- Consulta (art. 14): 10 días hábiles. Reclamo (art. 15): 15 días hábiles.
  kind              text        not null check (kind in ('consulta', 'reclamo')),
  -- El derecho que se ejerce (art. 8 de la ley).
  right_invoked     text        not null
                                check (right_invoked in ('conocer', 'actualizar', 'rectificar',
                                                         'suprimir', 'revocar', 'prueba',
                                                         'informacion_uso', 'otro')),
  message           text        not null check (length(btrim(message)) between 10 and 5000),
  status            text        not null default 'recibida'
                                check (status in ('recibida', 'en_tramite', 'prorrogada',
                                                  'respondida', 'cerrada')),
  received_at       timestamptz not null default now(),
  -- Plazo legal en días hábiles colombianos, calculado al recibir.
  due_on            date        not null,
  -- Prórroga legal: consulta +5 hábiles, reclamo +8 hábiles, con motivo.
  extended_due_on   date,
  extension_reason  text        check (extension_reason is null or length(extension_reason) <= 1000),
  response          text        check (response is null or length(response) <= 10000),
  responded_at      timestamptz,
  -- «Reclamo en trámite» (art. 15): marca que debe verse donde está el dato.
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint legal_requests_extension_has_reason
    check (extended_due_on is null or extension_reason is not null),
  constraint legal_requests_answered_has_time
    check (status not in ('respondida', 'cerrada') or responded_at is not null)
);

create index if not exists legal_requests_user_idx
  on public.legal_requests (user_id, received_at desc);
create index if not exists legal_requests_open_idx
  on public.legal_requests (due_on) where status in ('recibida', 'en_tramite', 'prorrogada');

-- ---------------------------------------------------------------------------
-- 3. Exportaciones
-- ---------------------------------------------------------------------------
create table if not exists public.data_exports (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  text        not null references public.ba_organization(id) on delete cascade,
  -- 'empresa': todo el espacio (dueño o administrador). 'personal': lo de una
  -- persona dentro del espacio, más su cuenta.
  scope            text        not null check (scope in ('empresa', 'personal')),
  requested_by     uuid        references public.users(id) on delete set null,
  -- La persona (ba_user) que la pidió: para la exportación personal y el aviso.
  requested_by_account text    not null,
  status           text        not null default 'pendiente'
                               check (status in ('pendiente', 'generando', 'lista',
                                                 'fallida', 'vencida')),
  file_bucket      text,
  file_path        text,
  size_bytes       bigint      check (size_bytes is null or size_bytes >= 0),
  tables_count     integer,
  rows_count       bigint,
  files_count      integer,
  error            text        check (error is null or length(error) <= 2000),
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  -- Pasada esta hora el ZIP se borra y el enlace deja de servir.
  expires_at       timestamptz,
  constraint data_exports_ready_has_file
    check (status <> 'lista' or (file_bucket is not null and file_path is not null
                                 and expires_at is not null))
);

create index if not exists data_exports_org_idx
  on public.data_exports (organization_id, created_at desc);
-- Una sola exportación en curso por espacio y alcance a la vez.
create unique index if not exists data_exports_one_running_uidx
  on public.data_exports (organization_id, scope, requested_by_account)
  where status in ('pendiente', 'generando');

-- ---------------------------------------------------------------------------
-- 4. Borrado de la empresa
-- ---------------------------------------------------------------------------
create table if not exists public.organization_deletions (
  id                 uuid        primary key default gen_random_uuid(),
  -- SIN llave foránea: esta fila es el acta del borrado y debe sobrevivirlo.
  organization_id    text        not null,
  organization_name  text        not null,
  requested_by_account text      not null,
  requested_by_email text        not null,
  requested_at       timestamptz not null default now(),
  -- 'empresa': el dueño pidió borrar la empresa (30 días de gracia).
  -- 'cuenta_personal': la persona borró su usuario y este espacio era sólo
  -- suyo (su espacio personal): no hay a quién proteger con la gracia.
  reason             text        not null default 'empresa'
                                 check (reason in ('empresa', 'cuenta_personal')),
  -- Desde cuándo se puede purgar.
  purge_after        timestamptz not null,
  status             text        not null default 'programada'
                                 check (status in ('programada', 'cancelada', 'purgando',
                                                   'purgada', 'fallida')),
  cancelled_at       timestamptz,
  cancelled_by_email text,
  purge_started_at   timestamptz,
  purged_at          timestamptz,
  -- Cuántas filas salieron de cada tabla y qué conexiones se revocaron.
  report             jsonb,
  error              text        check (error is null or length(error) <= 2000),
  constraint organization_deletions_grace
    check (reason <> 'empresa' or purge_after >= requested_at + interval '29 days'),
  constraint organization_deletions_cancel_has_time
    check (status <> 'cancelada' or cancelled_at is not null)
);

-- Un solo borrado vivo por empresa.
create unique index if not exists organization_deletions_live_uidx
  on public.organization_deletions (organization_id)
  where status in ('programada', 'purgando');
create index if not exists organization_deletions_due_idx
  on public.organization_deletions (purge_after) where status = 'programada';

-- ---------------------------------------------------------------------------
-- Acceso: sólo el servidor
-- ---------------------------------------------------------------------------
alter table public.legal_consents         enable row level security;
alter table public.legal_requests         enable row level security;
alter table public.data_exports           enable row level security;
alter table public.organization_deletions enable row level security;

revoke all on table public.legal_consents         from public, anon, authenticated;
revoke all on table public.legal_requests         from public, anon, authenticated;
revoke all on table public.data_exports           from public, anon, authenticated;
revoke all on table public.organization_deletions from public, anon, authenticated;

grant select, insert, update, delete on table public.legal_consents         to service_role;
grant select, insert, update, delete on table public.legal_requests         to service_role;
grant select, insert, update, delete on table public.data_exports           to service_role;
grant select, insert, update, delete on table public.organization_deletions to service_role;
