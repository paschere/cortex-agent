-- ===========================================================================
-- WHATSAPP: CADA EMPRESA VINCULA SU PROPIO NÚMERO
-- ===========================================================================
-- Hasta aquí el puente de WhatsApp (services/whatsapp, en Railway) servía UN
-- solo espacio de trabajo, el de su variable WHATSAPP_ORGANIZATION_ID. Para que
-- otra empresa usara WhatsApp había que cambiar esa variable — y la primera
-- dejaba de tenerlo. Con esto un solo proceso sostiene una conexión por cada
-- empresa que vinculó su número (o que lo está vinculando ahora mismo), y la
-- lista la decide Cortex, no una variable.
--
-- QUÉ AGREGA
--   1. `whatsapp_sessions` ya era una fila por empresa (PK organization_id,
--      0068): eso no cambia, y la fila existente sigue sirviendo tal cual. Se le
--      agrega:
--        * `paired` — columna generada: la sesión guardada es de un dispositivo
--          que WhatsApp aceptó (`creds.account`, ver auth-state.ts). Es lo que
--          decide si la empresa necesita conexión permanente. Generada para que
--          nadie tenga que leer `creds` (una credencial) para saberlo.
--        * `owner_instance` + `lease_expires_at` — qué proceso tiene la sesión,
--          hasta cuándo. Dos procesos con la misma sesión de WhatsApp se pelean
--          y WhatsApp los tumba a los dos; pasa justo en un deploy, cuando el
--          contenedor viejo y el nuevo conviven unos segundos. El préstamo
--          (lease) lo impide: sólo lo toma otro proceso cuando venció.
--        * `unlink_requested_at` — un administrador pidió «Desvincular»; el
--          proceso que tiene la sesión cierra el dispositivo en WhatsApp y la
--          borra.
--        * Un número, una empresa: índice único parcial sobre `phone_number`.
--   2. `whatsapp_bridge_instances` — qué procesos hay, en qué modo y cuándo se
--      reportaron. Para operar (y para un futuro reparto horizontal), y para
--      que la pantalla sepa si hay un puente multiempresa vivo.
--   3. Funciones: `whatsapp_bridge_claim` (lista + préstamo, atómico),
--      `whatsapp_bridge_release` (al apagar) y `whatsapp_phone_taken`
--      (¿este número ya es de otra empresa?).
--
-- Tenencia: `whatsapp_sessions` sigue `tenant()`. `whatsapp_bridge_instances`
-- es `shared` (no tiene datos de ninguna empresa: un id de proceso, un modo, un
-- contador). claim/release son `maintenance` (devuelven ids de espacio y un
-- booleano, nunca contenido); phone_taken es `organization`.
-- Sólo `service_role`.
--
-- Idempotente.

-- ---------------------------------------------------------------------------
-- 1. Columnas nuevas en whatsapp_sessions
-- ---------------------------------------------------------------------------
alter table public.whatsapp_sessions
  add column if not exists owner_instance      text
    check (owner_instance is null or owner_instance ~ '^[A-Za-z0-9._:-]{1,128}$'),
  add column if not exists lease_expires_at    timestamptz,
  add column if not exists unlink_requested_at timestamptz;

alter table public.whatsapp_sessions
  add column if not exists paired boolean
    generated always as (coalesce(jsonb_typeof(creds -> 'account') = 'object', false)) stored;

comment on column public.whatsapp_sessions.paired is
  'La sesión guardada es de un dispositivo que WhatsApp aceptó (creds.account). Generada: se sabe sin leer la credencial.';
comment on column public.whatsapp_sessions.owner_instance is
  'Proceso del puente que tiene esta sesión. Sólo otro proceso la toma cuando lease_expires_at venció (0189).';
comment on column public.whatsapp_sessions.lease_expires_at is
  'Hasta cuándo owner_instance tiene la sesión. Se renueva en cada reconciliación del puente (cada ~15 s).';
comment on column public.whatsapp_sessions.unlink_requested_at is
  'Un administrador pidió «Desvincular». El puente cierra el dispositivo en WhatsApp y borra la sesión.';

create index if not exists whatsapp_sessions_owner_idx
  on public.whatsapp_sessions (owner_instance)
  where owner_instance is not null;

-- Un número, una empresa. Antes de crear el índice se resuelven duplicados
-- que el modo de una sola empresa pudo dejar: «mover» el número de espacio
-- (cambiar WHATSAPP_ORGANIZATION_ID) dejaba la fila vieja con el mismo número.
-- Se queda con el número la fila conectada / vista más recientemente; a las
-- demás se les quita el número y se deja dicho por qué. Sus credenciales no se
-- tocan aquí: si el dispositivo viejo sigue vivo, al conectarse choca con este
-- índice y el puente lo desvincula (ver /api/whatsapp/bridge/heartbeat).
with ranked as (
  select organization_id,
         row_number() over (
           partition by phone_number
           order by (status = 'connected') desc,
                    last_seen_at desc nulls last,
                    updated_at desc
         ) as rn
    from public.whatsapp_sessions
   where phone_number is not null
)
update public.whatsapp_sessions s
   set phone_number = null,
       last_error = 'Este número quedó vinculado a otro espacio de trabajo. Vincula aquí un número dedicado distinto.'
  from ranked r
 where r.organization_id = s.organization_id
   and r.rn > 1;

create unique index if not exists whatsapp_sessions_phone_unique
  on public.whatsapp_sessions (phone_number)
  where phone_number is not null;

-- ---------------------------------------------------------------------------
-- 2. Procesos del puente
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_bridge_instances (
  instance_id  text primary key check (instance_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  -- 'single': fijado a una empresa por WHATSAPP_ORGANIZATION_ID (como antes).
  -- 'multi':  sirve a todas las empresas que Cortex le presta.
  mode         text not null check (mode in ('single', 'multi')),
  max_sessions integer not null default 50 check (max_sessions between 1 and 1000),
  running      integer not null default 0 check (running >= 0),
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

comment on table public.whatsapp_bridge_instances is
  'Procesos del puente de WhatsApp vivos o recientes: modo, techo de sesiones y última señal. Sin datos de ninguna empresa (0189).';

-- ---------------------------------------------------------------------------
-- 3. Funciones
-- ---------------------------------------------------------------------------

-- La reconciliación del puente, en una sola llamada atómica:
--   * registra el proceso;
--   * calcula qué empresas necesitan conexión — sesión emparejada, o una
--     petición de vincular viva (la misma ventana de 3 min de 0169) — o, en
--     modo de una empresa, sólo esa;
--   * presta a este proceso las que estén libres, sean ya suyas o tengan el
--     préstamo vencido, hasta su techo, primero las que ya tenía y luego las
--     emparejadas (necesitan estar conectadas para recibir);
--   * suelta las que tenía y ya no le tocan.
-- `for update skip locked`: dos procesos reconciliando a la vez nunca se
-- llevan la misma fila.
create or replace function public.whatsapp_bridge_claim(
  p_instance            text,
  p_mode                text,
  p_max_sessions        integer,
  p_lease_seconds       integer,
  p_organization_id     text default null,
  p_pairing_ttl_seconds integer default 180
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now     timestamptz := now();
  v_lease   interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 60), 15));
  v_ttl     interval := make_interval(secs => greatest(coalesce(p_pairing_ttl_seconds, 180), 1));
  v_max     integer := greatest(least(coalesce(p_max_sessions, 50), 1000), 1);
  v_claimed text[];
  v_waiting integer := 0;
begin
  if p_instance is null or p_instance !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'whatsapp_bridge_claim: invalid instance id';
  end if;
  if p_mode is null or p_mode not in ('single', 'multi') then
    raise exception 'whatsapp_bridge_claim: invalid mode';
  end if;
  if p_mode = 'single' and p_organization_id is null then
    raise exception 'whatsapp_bridge_claim: single mode needs its organization';
  end if;

  insert into public.whatsapp_bridge_instances (instance_id, mode, max_sessions, last_seen_at)
  values (p_instance, p_mode, v_max, v_now)
  on conflict (instance_id) do update
     set mode = excluded.mode,
         max_sessions = excluded.max_sessions,
         last_seen_at = excluded.last_seen_at;

  with wanted as (
    select s.organization_id,
           s.paired,
           coalesce(s.pairing_requested_at > v_now - v_ttl, false) as pairing_requested
      from public.whatsapp_sessions s
     where case
             when p_mode = 'single' then s.organization_id = p_organization_id
             else s.paired or coalesce(s.pairing_requested_at > v_now - v_ttl, false)
           end
  ), candidates as (
    select s.organization_id
      from public.whatsapp_sessions s
      join wanted w on w.organization_id = s.organization_id
     where s.owner_instance is null
        or s.owner_instance = p_instance
        or s.lease_expires_at is null
        or s.lease_expires_at < v_now
     order by (s.owner_instance is not distinct from p_instance) desc,
              w.paired desc,
              s.pairing_requested_at desc nulls last,
              s.organization_id
     limit v_max
     for update of s skip locked
  ), claimed as (
    update public.whatsapp_sessions s
       set owner_instance = p_instance,
           lease_expires_at = v_now + v_lease
      from candidates c
     where s.organization_id = c.organization_id
    returning s.organization_id
  )
  select coalesce(array_agg(organization_id), '{}'::text[]) into v_claimed from claimed;

  -- Lo que este proceso tenía y ya no le toca (desvinculada, petición vencida,
  -- techo más bajo) queda libre al instante, no cuando venza.
  update public.whatsapp_sessions
     set owner_instance = null, lease_expires_at = null
   where owner_instance = p_instance
     and not (organization_id = any (v_claimed));

  if p_mode = 'multi' then
    select count(*) into v_waiting
      from public.whatsapp_sessions s
     where (s.paired or coalesce(s.pairing_requested_at > v_now - v_ttl, false))
       and not (s.organization_id = any (v_claimed));
  end if;

  update public.whatsapp_bridge_instances
     set running = coalesce(array_length(v_claimed, 1), 0)
   where instance_id = p_instance;

  return jsonb_build_object(
    'sessions', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'organizationId', s.organization_id,
                 'paired', s.paired,
                 'pairingRequested', coalesce(s.pairing_requested_at > v_now - v_ttl, false)
               )
               order by s.paired desc, s.organization_id
             )
        from public.whatsapp_sessions s
       where s.organization_id = any (v_claimed)
    ), '[]'::jsonb),
    'waiting', v_waiting,
    'leaseMs', (extract(epoch from v_lease) * 1000)::bigint
  );
end;
$$;

-- Al apagarse un proceso: suelta todo lo suyo para que el siguiente lo tome ya.
create or replace function public.whatsapp_bridge_release(p_instance text)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_released integer;
begin
  update public.whatsapp_sessions
     set owner_instance = null, lease_expires_at = null
   where owner_instance = p_instance;
  get diagnostics v_released = row_count;
  delete from public.whatsapp_bridge_instances where instance_id = p_instance;
  return v_released;
end;
$$;

-- ¿Este número ya es de OTRA empresa? Conectado allá, o en un intento de
-- vincular con código que sigue vivo. Sólo sí o no: nunca cuál empresa.
create or replace function public.whatsapp_phone_taken(p_organization_id text, p_phone text)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(p_phone, '') ~ '^[0-9]{8,15}$'
     and exists (
       select 1
         from public.whatsapp_sessions s
        where s.organization_id <> p_organization_id
          and (
            s.phone_number = p_phone
            or (s.pairing_phone = p_phone and s.pairing_requested_at > now() - interval '3 minutes')
          )
     );
$$;

-- ---------------------------------------------------------------------------
-- 4. Acceso: sólo el servidor
-- ---------------------------------------------------------------------------
alter table public.whatsapp_sessions         enable row level security;
alter table public.whatsapp_session_keys     enable row level security;
alter table public.whatsapp_bridge_instances enable row level security;

revoke all on table public.whatsapp_sessions         from public, anon, authenticated;
revoke all on table public.whatsapp_session_keys     from public, anon, authenticated;
revoke all on table public.whatsapp_bridge_instances from public, anon, authenticated;

grant select, insert, update, delete on table public.whatsapp_sessions         to service_role;
grant select, insert, update, delete on table public.whatsapp_session_keys     to service_role;
grant select, insert, update, delete on table public.whatsapp_bridge_instances to service_role;

revoke all on function public.whatsapp_bridge_claim(text, text, integer, integer, text, integer) from public, anon, authenticated;
revoke all on function public.whatsapp_bridge_release(text) from public, anon, authenticated;
revoke all on function public.whatsapp_phone_taken(text, text) from public, anon, authenticated;
grant execute on function public.whatsapp_bridge_claim(text, text, integer, integer, text, integer) to service_role;
grant execute on function public.whatsapp_bridge_release(text) to service_role;
grant execute on function public.whatsapp_phone_taken(text, text) to service_role;
