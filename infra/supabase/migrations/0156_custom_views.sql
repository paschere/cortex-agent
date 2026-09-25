-- ===========================================================================
-- VISTAS: PANTALLAS QUE LA EMPRESA SE ARMA HABLANDO
-- ===========================================================================
-- La 0115 dejó que cada espacio se inventara sus tablas. Faltaba la otra
-- mitad: MIRARLAS. Hasta aquí una tabla sólo se veía en el panel del chat, con
-- cinco columnas y sin formato. «Quiero un tablero de remates con el total por
-- ciudad y los que vencen esta semana», «un portal para que el cliente vea sus
-- contenedores», «un formulario para que los conductores reporten novedades»
-- — eso es una PANTALLA, y hasta hoy una pantalla era trabajo de un
-- desarrollador.
--
-- ---------------------------------------------------------------------------
-- UNA VISTA ES UNA LISTA DE BLOQUES, NO CÓDIGO
-- ---------------------------------------------------------------------------
-- `spec` es JSON declarativo: texto, cifra, tabla, gráfico, tablero por
-- estado y formulario, cada uno apuntando a una tabla inventada por su slug.
-- NO hay HTML ni JavaScript generado por el modelo. Es la decisión que hace
-- posible lo demás: una vista se puede abrir desde afuera (enlace, contraseña)
-- precisamente porque no puede ejecutar nada; lo peor que hace un spec mal
-- escrito es mostrar un bloque que dice «este campo no existe». El contrato
-- lo valida zod en packages/agent-tools/src/views/spec.ts; la base sólo
-- garantiza lo que puede sola: que hay entre 1 y 24 bloques.
--
-- ---------------------------------------------------------------------------
-- CADA CAMBIO ES UNA VERSIÓN
-- ---------------------------------------------------------------------------
-- La vista se edita con texto («quita el gráfico», «agrupa por ciudad»). Un
-- editor que no se puede deshacer es un editor al que nadie se atreve a
-- hablarle, así que cada guardado escribe una fila en `custom_view_versions`
-- con el spec entero y la frase que lo produjo. Restaurar es copiar una
-- versión vieja como versión nueva: la historia no se reescribe.
--
-- ---------------------------------------------------------------------------
-- TRES PUERTAS, Y LA BASE SABE CUÁL ESTÁ ABIERTA
-- ---------------------------------------------------------------------------
--   'workspace'  sólo miembros del espacio, dentro de la app.
--   'link'       quien tenga el enlace, sin cuenta.
--   'password'   el enlace más una contraseña (scrypt, nunca el texto).
--
-- Los CHECK impiden los estados a medias: un enlace sin token, un token en
-- una vista interna, una contraseña sin hash. `pinned` es aparte: una vista
-- fijada aparece en Inicio, esté o no compartida afuera.
--
-- Contra la fuerza bruta: `custom_view_reserve_unlock` GASTA el intento antes
-- de comparar la contraseña, dentro de un `for update`. Cien peticiones en
-- paralelo no pasan cien veces por el mismo «todavía no está bloqueada»;
-- pasan en fila, y a la décima la vista se cierra quince minutos.
--
-- ---------------------------------------------------------------------------
-- LOS FORMULARIOS DE AFUERA DEJAN HUELLA
-- ---------------------------------------------------------------------------
-- Un bloque de formulario en una vista compartida deja que alguien sin cuenta
-- escriba una fila. `custom_view_submissions` guarda cuál fila entró por qué
-- vista y cuándo, que es lo que el código cuenta para el tope por hora, y lo
-- que permite contestar «¿esto quién lo metió?».
--
-- Tenencia: `organization_id` en cada fila, registrada como `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. RLS deny-all + service_role.

create table public.custom_views (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     text not null,
  slug                text not null,
  name                text not null,
  description         text not null default '',
  spec                jsonb not null,
  version             integer not null default 1,

  visibility          text not null default 'workspace',
  share_token         text,
  share_expires_at    timestamptz,
  share_views         integer not null default 0,
  password_hash       text,
  failed_unlocks      integer not null default 0,
  locked_until        timestamptz,

  pinned              boolean not null default false,

  created_by          uuid,
  updated_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz,

  constraint custom_views_slug_shape check (slug ~ '^[a-z][a-z0-9_]{1,47}$'),
  constraint custom_views_name_len check (char_length(btrim(name)) between 1 and 80),
  constraint custom_views_description_len check (char_length(description) <= 500),
  constraint custom_views_version_positive check (version >= 1),
  constraint custom_views_visibility check (visibility in ('workspace', 'link', 'password')),
  constraint custom_views_has_blocks check (
    coalesce(jsonb_typeof(spec -> 'blocks'), '') = 'array'
    and jsonb_array_length(spec -> 'blocks') between 1 and 24
  ),
  -- Afuera sólo se sale con token; adentro no hay token que filtrar.
  constraint custom_views_token_matches_visibility check (
    (visibility = 'workspace') = (share_token is null)
  ),
  constraint custom_views_expiry_needs_token check (
    share_token is not null or share_expires_at is null
  ),
  -- La contraseña existe exactamente cuando la puerta la pide.
  constraint custom_views_password_matches_visibility check (
    (visibility = 'password') = (password_hash is not null)
  ),
  constraint custom_views_password_hash_shape check (
    password_hash is null or password_hash ~ '^scrypt\$[A-Za-z0-9_-]{16,64}\$[A-Za-z0-9_-]{64,128}$'
  )
);

create unique index custom_views_org_slug_idx
  on public.custom_views (organization_id, slug)
  where archived_at is null;

create unique index custom_views_share_token_idx
  on public.custom_views (share_token)
  where share_token is not null;

create index custom_views_org_updated_idx
  on public.custom_views (organization_id, updated_at desc)
  where archived_at is null;

create index custom_views_org_pinned_idx
  on public.custom_views (organization_id)
  where pinned and archived_at is null;

comment on table public.custom_views is
  'Una pantalla que el espacio se armó hablando: bloques declarativos sobre sus tablas inventadas. Puede quedarse adentro, salir por enlace o por enlace con contraseña, y fijarse en Inicio.';

comment on column public.custom_views.spec is
  'Los bloques de la vista. JSON declarativo validado por packages/agent-tools/src/views/spec.ts; nunca HTML ni código.';

create table public.custom_view_versions (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     text not null,
  view_id             uuid not null references public.custom_views (id) on delete cascade,
  version             integer not null,
  name                text not null,
  spec                jsonb not null,
  -- La frase que produjo este cambio, si vino de una. Es lo que la historia
  -- muestra: «agrupa por ciudad» se entiende; un diff de JSON no.
  prompt              text check (prompt is null or char_length(prompt) <= 2000),
  created_by          uuid,
  created_at          timestamptz not null default now(),

  constraint custom_view_versions_unique unique (view_id, version)
);

create index custom_view_versions_org_view_idx
  on public.custom_view_versions (organization_id, view_id, version desc);

comment on table public.custom_view_versions is
  'Cada guardado de una vista, con el spec entero y la frase que lo produjo. Restaurar copia una versión vieja como versión nueva.';

create table public.custom_view_submissions (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     text not null,
  view_id             uuid not null references public.custom_views (id) on delete cascade,
  block_id            text not null check (char_length(block_id) between 1 and 40),
  tracker_row_id      uuid references public.tracker_rows (id) on delete set null,
  -- Quién, si era alguien del espacio; null cuando entró por el enlace.
  submitted_by        uuid,
  created_at          timestamptz not null default now()
);

create index custom_view_submissions_org_view_idx
  on public.custom_view_submissions (organization_id, view_id, created_at desc);

comment on table public.custom_view_submissions is
  'Qué fila entró por el formulario de qué vista y cuándo. El código cuenta estas filas para el tope por hora de envíos desde afuera.';

alter table public.custom_views             enable row level security;
alter table public.custom_view_versions     enable row level security;
alter table public.custom_view_submissions  enable row level security;

revoke all on table public.custom_views             from public, anon, authenticated;
revoke all on table public.custom_view_versions     from public, anon, authenticated;
revoke all on table public.custom_view_submissions  from public, anon, authenticated;

grant select, insert, update, delete on table public.custom_views            to service_role;
grant select, insert, update, delete on table public.custom_view_versions    to service_role;
grant select, insert, update, delete on table public.custom_view_submissions to service_role;

-- ===========================================================================
-- Gastar el intento ANTES de comparar
-- ===========================================================================
-- Devuelve el hash para que el código compare en tiempo constante, o
-- 'locked' si la vista está cerrada por intentos. El intento se descuenta
-- aquí, bajo el candado de la fila; si la contraseña resulta buena, el código
-- llama `custom_view_clear_unlocks` y el contador vuelve a cero.
create function public.custom_view_reserve_unlock(p_organization_id text, p_view_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.custom_views;
begin
  select * into v from public.custom_views
   where id = p_view_id and organization_id = p_organization_id
     and archived_at is null and visibility = 'password'
   for update;
  if not found then return null; end if;
  if v.locked_until is not null and v.locked_until > now() then
    return jsonb_build_object('locked', true, 'until', v.locked_until);
  end if;
  if v.failed_unlocks + 1 >= 10 then
    update public.custom_views
       set failed_unlocks = 0, locked_until = now() + interval '15 minutes'
     where id = v.id;
  else
    update public.custom_views
       set failed_unlocks = v.failed_unlocks + 1, locked_until = null
     where id = v.id;
  end if;
  return jsonb_build_object('locked', false, 'hash', v.password_hash);
end $$;

create function public.custom_view_clear_unlocks(p_organization_id text, p_view_id uuid)
returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.custom_views
     set failed_unlocks = 0, locked_until = null
   where id = p_view_id and organization_id = p_organization_id;
$$;

revoke all on function public.custom_view_reserve_unlock(text, uuid) from public, anon, authenticated;
revoke all on function public.custom_view_clear_unlocks(text, uuid) from public, anon, authenticated;
grant execute on function public.custom_view_reserve_unlock(text, uuid) to service_role;
grant execute on function public.custom_view_clear_unlocks(text, uuid) to service_role;
