-- ===========================================================================
-- QUIÉN VE QUÉ EN EL CEREBRO: espacios con acceso por equipo y por persona
-- ===========================================================================
--
-- LO QUE HABÍA. Desde la 0049 un espacio tenía exactamente dos formas: `global`
-- (lo ve toda la organización) o `user` (lo ve una sola persona). En medio no
-- había nada. La 0049 lo dice sin rodeos en su propio encabezado: había un
-- `scope = 'team'` y lo plegó a global porque no tenía pantalla ni reglas. Lo
-- que se perdió al plegarlo es el caso más común que existe en una empresa:
--
--     «Tarifas 2026 la consulta Comercial, la mantiene Finanzas,
--      y el resto de la empresa no tiene por qué verla.»
--
-- Hoy eso sólo se puede expresar publicándola a todo el mundo o guardándosela
-- uno mismo. Las dos respuestas son falsas, y la que la gente elige bajo
-- presión es la primera.
--
-- ---------------------------------------------------------------------------
-- LA IDEA: LA VISIBILIDAD SE CONCEDE, NO SE DEDUCE DEL `scope`
-- ---------------------------------------------------------------------------
-- La tentación era añadir un tercer valor a `kb_scope` — 'shared' — y volver a
-- tener tres formas cerradas en vez de dos. No se hace, por dos razones:
--
--   1. Añadir un valor a un enum y usarlo en la misma migración no se puede
--      (es la lección de la 0081, y la 0121/0122 tuvo que partirse en dos por
--      eso mismo). Un problema evitable no hay que resolverlo, hay que
--      evitarlo.
--   2. Y sobre todo: «tres formas» se queda corto otra vez el día que alguien
--      pida la cuarta. Lo que hace falta no es una forma más, es que la
--      pregunta cambie. `scope` deja de contestar «quién lo ve» y pasa a
--      contestar sólo «de quién es»:
--
--        scope = 'user'   -> el cuaderno de una persona. Es suyo.
--        scope = 'global' -> un espacio de la organización. Es de la empresa.
--
--      y QUIÉN LO VE se responde en un único sitio nuevo, `kb_space_grants`:
--      una fila por «a este espacio, este sujeto, con este nivel».
--
-- Con eso, «lo ve toda la empresa» deja de ser una propiedad estructural y pasa
-- a ser una concesión más — la de sujeto `everyone` — que se puede quitar. Ése
-- es exactamente el interruptor «Toda la empresa: apagado» de la pantalla, y
-- es el mismo mecanismo que da acceso a un equipo o a una persona. Un solo
-- mecanismo que apagar es un mecanismo que se puede auditar; dos que se
-- solapan no.
--
-- ---------------------------------------------------------------------------
-- LOS TRES NIVELES, Y POR QUÉ TRES
-- ---------------------------------------------------------------------------
--   view        busca y lee. Es lo que necesita quien consulta.
--   contribute  además guarda documentos ahí. Es lo que necesita quien mantiene.
--   admin       además reparte el acceso, renombra y borra.
--
-- Dos niveles no alcanzaban porque no dejan delegar: el que crea el espacio se
-- queda de portero para siempre y el producto se llena de espacios huérfanos
-- cuando esa persona se va. Cuatro sobran: nadie ha pedido nunca «puede añadir
-- pero no leer».
--
-- ---------------------------------------------------------------------------
-- LO QUE NO CAMBIA, Y ES LO MÁS IMPORTANTE DE ESTE ARCHIVO
-- ---------------------------------------------------------------------------
-- `kb_visible_space_ids` sigue siendo LA ÚNICA definición de «de qué espacios
-- puede recuperar esta persona», sigue derivando la organización de
-- `public.users` en vez de aceptarla como argumento (0064 § 11), y sigue
-- fallando cerrada con un usuario nulo o desconocido. Todo lo que recupera del
-- cerebro pasa por ella — `kb_search_scoped`, `kb_brain_graph`,
-- `kb_conflict_candidates` — así que todos heredan los permisos nuevos sin que
-- haya que tocarlos, igual que heredaron el aislamiento entre empresas.
--
-- Y sigue sin haber una rama que le deje a nadie leer las notas personales de
-- otro. Un administrador de la organización administra los espacios DE LA
-- ORGANIZACIÓN — incluidos los que no se ha concedido a sí mismo, porque si no
-- un espacio mal repartido no lo puede arreglar nadie. El cuaderno de una
-- persona no está en ese conjunto y no hay rol que lo meta: sólo su dueño
-- reparte acceso a lo suyo.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. La tabla: una fila por «este sujeto, en este espacio, con este nivel»
-- ---------------------------------------------------------------------------
-- `subject_id` es un uuid sin clave foránea porque apunta a dos tablas
-- distintas según `subject_kind` — `users` o `teams` — y a ninguna cuando el
-- sujeto es «todo el mundo». Lo que en otra tabla haría la clave foránea aquí
-- lo hace la guarda de más abajo, que además comprueba lo que una clave foránea
-- no puede: que el sujeto viva en la MISMA organización que el espacio.
create table if not exists public.kb_space_grants (
  id               uuid primary key default gen_random_uuid(),
  -- Redundante con la del espacio a propósito, como en `team_members` (0064
  -- § 5): esta tabla también se lee al revés — «qué espacios ve esta persona» —
  -- sin un espacio en la mano, y sin la columna esa consulta tendría que pasar
  -- por `kb_collections` para poder acotarse a la empresa.
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  space_id         uuid not null references public.kb_collections(id) on delete cascade,
  subject_kind     text not null check (subject_kind in ('everyone', 'team', 'user')),
  subject_id       uuid,
  level            text not null default 'view'
                     check (level in ('view', 'contribute', 'admin')),
  -- Quién lo concedió, que es la mitad de la pregunta cuando alguien descubre
  -- que ve algo que no esperaba ver. `set null` y no cascada: el hecho de que
  -- se concedió sobrevive a que esa persona se vaya.
  granted_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- «Todo el mundo» no tiene id, y un equipo o una persona siempre lo tienen.
  -- Escrito como una igualdad entre dos condiciones para que las dos mitades no
  -- puedan divergir.
  constraint kb_space_grants_subject_shape
    check ((subject_kind = 'everyone') = (subject_id is null))
);

comment on table public.kb_space_grants is
  'Quién ve cada espacio del cerebro y con qué nivel. Una fila por (espacio, sujeto): el sujeto es toda la empresa, un equipo o una persona. Es el ÚNICO sitio donde se concede visibilidad — kb_collections.scope ya sólo dice de quién es el espacio, no quién lo ve. Nivel: view (busca y lee), contribute (además guarda), admin (además reparte, renombra y borra).';
comment on column public.kb_space_grants.subject_kind is
  '''everyone'' = toda la organización (subject_id nulo); ''team'' = subject_id es teams.id; ''user'' = subject_id es users.id. Sin clave foránea porque apunta a dos tablas; lo comprueba el disparador kb_space_grants_guard, que además exige que el sujeto sea de la misma organización que el espacio.';
comment on column public.kb_space_grants.level is
  'view < contribute < admin. Cuando a alguien le llegan varios niveles por caminos distintos (su equipo y él mismo, por ejemplo) gana el más alto; lo ordena kb_grant_rank.';

create unique index if not exists kb_space_grants_subject_idx
  on public.kb_space_grants (space_id, subject_kind, subject_id)
  where subject_id is not null;

-- Un espacio no puede estar abierto a toda la empresa dos veces. Índice parcial
-- aparte porque el de arriba no ve las filas de sujeto nulo.
create unique index if not exists kb_space_grants_everyone_idx
  on public.kb_space_grants (space_id)
  where subject_kind = 'everyone';

-- La consulta al revés: «qué espacios alcanza este sujeto». Es la que corre en
-- cada búsqueda del cerebro, dentro de kb_visible_space_ids.
create index if not exists kb_space_grants_subject_lookup_idx
  on public.kb_space_grants (subject_kind, subject_id);

create index if not exists kb_space_grants_org_idx
  on public.kb_space_grants (organization_id);

alter table public.kb_space_grants enable row level security;
-- Sin políticas, como el resto del esquema: sólo la llave de servicio entra, y
-- toda la lógica de acceso vive en las funciones de más abajo y en kb/spaces.ts.

-- ---------------------------------------------------------------------------
-- 1bis. `everyone`: la única concesión que también se guarda en el espacio
-- ---------------------------------------------------------------------------
-- Es un espejo, con un solo escritor: el disparador de más abajo. Existe porque
-- «¿esto lo ve toda la empresa?» es parte de la IDENTIDAD del espacio y se
-- pregunta en todas partes — al listarlos, al pintar una etiqueta, y sobre todo
-- dentro de `kb_search_scoped`, donde cada resultado tiene que poder decir si
-- viene de conocimiento de la empresa, de un espacio repartido o del cuaderno
-- de uno. Deducirlo con un EXISTS en cada uno de esos sitios sería una consulta
-- más por fila recuperada, y en el sitio que importa —la búsqueda— ni siquiera
-- habría dónde meterla.
--
-- Un espejo puede mentir, y por eso tiene exactamente un escritor y ninguna
-- puerta trasera: la aplicación no escribe esta columna nunca, ni al crear el
-- espacio. Se enciende y se apaga poniendo o quitando la concesión, que es la
-- misma acción que hace el usuario en la pantalla.
alter table public.kb_collections
  add column if not exists everyone boolean not null default false;

comment on column public.kb_collections.everyone is
  'Espejo de "existe una concesión de sujeto everyone sobre este espacio" (migración 0123). Lo escribe ÚNICAMENTE el disparador kb_space_grants_mirror; la aplicación no lo toca. Falso siempre en un espacio personal, porque un cuaderno no se abre a la empresa.';

-- ---------------------------------------------------------------------------
-- 2. La guarda
-- ---------------------------------------------------------------------------
-- Tres invariantes que ninguna restricción de columna puede expresar, porque
-- las tres dependen del espacio al que apunta la fila.
create or replace function public.kb_space_grants_guard()
returns trigger
language plpgsql
as $$
declare
  s record;
begin
  select c.id, c.scope, c.scope_id, c.organization_id
    into s
  from public.kb_collections c
  where c.id = new.space_id;

  if s.id is null then
    raise exception 'Ese espacio ya no existe.';
  end if;

  -- La organización de una concesión NO se acepta: se deriva del espacio. Es la
  -- misma decisión que la 0064 tomó con kb_visible_space_ids — un dato que el
  -- llamador puede escribir es un dato que el llamador puede escribir mal, y
  -- aquí escribirlo mal sería conceder acceso a través de una frontera de
  -- empresa.
  new.organization_id := s.organization_id;

  if s.scope = 'user' then
    -- Un cuaderno personal se puede prestar, pero no se delega: quien reparte
    -- acceso a las notas de alguien es ese alguien y nadie más. Sin esto,
    -- prestar una nota a un compañero le daría el poder de prestársela a un
    -- tercero, que no es lo que nadie quiere decir al compartir una nota.
    if new.level = 'admin' then
      raise exception 'Un espacio personal no delega su administración: sus notas las reparte únicamente su dueño.';
    end if;
    -- Y no se publica a toda la empresa de un tirón. Para eso está mover el
    -- documento a un espacio común, que es una decisión visible y reversible.
    if new.subject_kind = 'everyone' then
      raise exception 'Un espacio personal no se abre a toda la empresa. Mueve el documento a un espacio común si eso es lo que quieres.';
    end if;
  end if;

  -- El sujeto vive en la misma organización que el espacio. Es lo que una clave
  -- foránea no habría podido comprobar, y es la única de las tres invariantes
  -- cuyo incumplimiento sería una fuga entre empresas y no un error de producto.
  if new.subject_kind = 'user' then
    if not exists (
      select 1 from public.users u
      where u.id = new.subject_id and u.organization_id = s.organization_id
    ) then
      raise exception 'Esa persona no está en este espacio de trabajo.';
    end if;
  elsif new.subject_kind = 'team' then
    if not exists (
      select 1 from public.teams t
      where t.id = new.subject_id and t.organization_id = s.organization_id
    ) then
      raise exception 'Ese equipo no está en este espacio de trabajo.';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists kb_space_grants_guard_trg on public.kb_space_grants;
create trigger kb_space_grants_guard_trg
  before insert or update on public.kb_space_grants
  for each row execute function public.kb_space_grants_guard();

-- ---------------------------------------------------------------------------
-- 3. El relleno: nadie deja de ver hoy lo que veía ayer
-- ---------------------------------------------------------------------------
-- Todo espacio que hoy es global lo es porque alguien decidió que lo viera la
-- empresa entera. Esa decisión se conserva tal cual, escrita ahora en el idioma
-- nuevo. Si este INSERT no corre, la pantalla se queda vacía para todo el mundo
-- salvo los administradores: es un relleno que no se puede saltar, y por eso va
-- en la misma migración que la tabla y no en un script aparte.
insert into public.kb_space_grants (organization_id, space_id, subject_kind, subject_id, level)
select c.organization_id, c.id, 'everyone', null, 'view'
from public.kb_collections c
where c.scope = 'global'
on conflict do nothing;

-- Y el espejo, de una vez para todo el corpus. A partir de aquí lo mantiene el
-- disparador.
update public.kb_collections c
set everyone = exists (
  select 1 from public.kb_space_grants g
  where g.space_id = c.id and g.subject_kind = 'everyone'
)
where c.everyone is distinct from exists (
  select 1 from public.kb_space_grants g
  where g.space_id = c.id and g.subject_kind = 'everyone'
);

-- ---------------------------------------------------------------------------
-- 3bis. El disparador que mantiene el espejo
-- ---------------------------------------------------------------------------
-- Se recalcula desde las concesiones en vez de encenderse y apagarse a mano:
-- un recálculo no puede desfasarse aunque una fila se borre por la cascada del
-- espacio o por la mano de alguien en una consola.
create or replace function public.kb_space_grants_mirror()
returns trigger
language plpgsql
as $$
declare
  target uuid := coalesce(new.space_id, old.space_id);
begin
  update public.kb_collections c
  set everyone = exists (
        select 1 from public.kb_space_grants g
        where g.space_id = c.id and g.subject_kind = 'everyone'
      )
  where c.id = target;
  return null;
end;
$$;

drop trigger if exists kb_space_grants_mirror_trg on public.kb_space_grants;
create trigger kb_space_grants_mirror_trg
  after insert or update or delete on public.kb_space_grants
  for each row execute function public.kb_space_grants_mirror();

-- ---------------------------------------------------------------------------
-- 4. El orden de los niveles
-- ---------------------------------------------------------------------------
-- Inmutable y en la base de datos porque quien decide el nivel efectivo es la
-- base de datos: si el orden viviera en TypeScript, la función de más abajo
-- tendría que devolver una lista y dejar que el llamador la ordene, y el
-- llamador que se equivoque concede de más.
create or replace function public.kb_grant_rank(p_level text)
returns int
language sql
immutable
as $$
  select case p_level
    when 'admin' then 3
    when 'contribute' then 2
    when 'view' then 1
    else 0
  end;
$$;

-- ---------------------------------------------------------------------------
-- 5. El nivel efectivo de una persona sobre un espacio
-- ---------------------------------------------------------------------------
-- Null cuando no lo ve — y «no lo ve» incluye «es de otra empresa», que es lo
-- primero que se comprueba y lo único que no tiene excepción.
create or replace function public.kb_space_level(p_user_id uuid, p_space_id uuid)
returns text
language sql
stable
as $$
  with me as (
    select u.id, u.organization_id, u.role
    from public.users u
    where u.id = p_user_id
  ),
  space as (
    select c.id, c.scope, c.scope_id
    from public.kb_collections c
    join me on me.organization_id = c.organization_id
    where c.id = p_space_id
  ),
  levels as (
    -- El dueño de un cuaderno lo administra. Siempre, y sin que nadie se lo
    -- conceda.
    select 'admin'::text as level
    from space
    where space.scope = 'user' and space.scope_id = p_user_id

    union all

    -- Un administrador administra los espacios de la organización. Incluidos
    -- los que no se concedió a sí mismo: si no, un espacio repartido mal se
    -- queda sin nadie que lo pueda arreglar. Nunca alcanza a un scope='user'.
    select 'admin'
    from space, me
    where space.scope = 'global' and me.role = 'org_admin'

    union all

    -- Y lo que se haya concedido: a todo el mundo, a un equipo suyo, o a ella.
    select g.level
    from public.kb_space_grants g, space, me
    where g.space_id = space.id
      and (
        g.subject_kind = 'everyone'
        or (g.subject_kind = 'user' and g.subject_id = me.id)
        or (g.subject_kind = 'team' and exists (
              select 1 from public.team_members tm
              where tm.team_id = g.subject_id and tm.user_id = me.id
            ))
      )
  )
  select level from levels order by public.kb_grant_rank(level) desc limit 1;
$$;

comment on function public.kb_space_level(uuid, uuid) is
  'El nivel efectivo de una persona sobre un espacio: ''admin'', ''contribute'', ''view'', o null cuando no lo ve. Cuando le llegan varios por caminos distintos gana el más alto. Un usuario nulo, desconocido, o de otra organización, obtiene null — falla cerrada.';

-- ---------------------------------------------------------------------------
-- 6. `kb_visible_space_ids`, reescrita sobre las concesiones
-- ---------------------------------------------------------------------------
-- Misma firma, mismo contrato, misma manera de derivar la organización de
-- `public.users` en vez de aceptarla (0064 § 11). Lo único que cambia es la
-- cláusula del medio: donde decía «c.scope = 'global'» — o sea, todo espacio
-- común de la empresa, sin más — ahora dice «alguien te lo concedió».
create or replace function public.kb_visible_space_ids(p_user_id uuid)
returns table (space_id uuid)
language sql
stable
as $$
  select c.id
  from public.kb_collections c
  join public.users u on u.id = p_user_id
  where p_user_id is not null
    and c.organization_id = u.organization_id
    and (
      (c.scope = 'user' and c.scope_id = p_user_id)
      or (c.scope = 'global' and u.role = 'org_admin')
      or exists (
        select 1
        from public.kb_space_grants g
        where g.space_id = c.id
          and (
            g.subject_kind = 'everyone'
            or (g.subject_kind = 'user' and g.subject_id = u.id)
            or (g.subject_kind = 'team' and exists (
                  select 1 from public.team_members tm
                  where tm.team_id = g.subject_id and tm.user_id = u.id
                ))
          )
      )
    )
$$;

comment on function public.kb_visible_space_ids(uuid) is
  'La única definición de "de qué espacios puede recuperar esta persona": sus propios espacios personales, más todo espacio de SU organización que se le haya concedido — a ella, a un equipo suyo, o a toda la empresa (kb_space_grants, migración 0123) — más, si es administradora de la organización, todos los espacios comunes de esa organización. La organización se lee de public.users en vez de pasarse como argumento (0064 § 11), así que no hay inquilino que confundir. Un id de usuario nulo o desconocido no une con nada y devuelve cero filas: quien pierde la cuenta de para quién pregunta, falla cerrada. Sigue sin haber rama que le permita a nadie leer el cuaderno personal de otro.';

-- ---------------------------------------------------------------------------
-- 7. Las dos listas que necesita la pantalla
-- ---------------------------------------------------------------------------
-- Van aquí y no en TypeScript porque las dos son la misma pregunta que ya
-- contesta esta migración, y contestarla dos veces en dos idiomas es como se
-- desincronizan. `kb_spaces_for` es la lista de la izquierda; `kb_space_access`
-- es el panel «quién ve esto».
create or replace function public.kb_spaces_for(p_user_id uuid)
returns table (
  id uuid,
  name text,
  scope kb_scope,
  scope_id uuid,
  description text,
  created_by uuid,
  created_at timestamptz,
  level text,
  everyone boolean,
  grant_count int
)
language sql
stable
as $$
  select c.id,
         c.name,
         c.scope,
         c.scope_id,
         c.description,
         c.created_by,
         c.created_at,
         public.kb_space_level(p_user_id, c.id),
         c.everyone,
         (
           select count(*)::int from public.kb_space_grants g
           where g.space_id = c.id and g.subject_kind <> 'everyone'
         )
  from public.kb_collections c
  join public.kb_visible_space_ids(p_user_id) v on v.space_id = c.id
  order by c.scope, c.name;
$$;

comment on function public.kb_spaces_for(uuid) is
  'Los espacios que esta persona ve, cada uno con su nivel efectivo, si está abierto a toda la empresa, y a cuántos sujetos más se concedió. Se apoya en kb_visible_space_ids, así que no puede devolver un espacio que la búsqueda no devolvería.';

-- Lleva el usuario dentro, y no por cortesía: sin él sería una función que
-- toma un id de espacio suelto y cuenta quién tiene acceso a lo que sea. Con
-- él, quien no administra el espacio recibe cero filas — la misma respuesta que
-- recibiría si el espacio no existiera. Es la segunda valla; la primera es
-- `assertCanAdminSpace` en kb/spaces.ts, y este archivo entero existe porque
-- una sola valla en la frontera de acceso acaba teniéndose que reparar.
-- Y la misma fila, para un solo espacio. Existe porque «tráeme este espacio» y
-- «¿qué puedo hacer en él?» son SIEMPRE la misma pregunta hecha seguida —
-- `getVisibleSpace` en kb/spaces.ts es literalmente eso — y partirla en dos
-- viajes es pagar dos veces por una respuesta, en un camino por el que pasa
-- cada lectura de cada documento. Devuelve cero filas cuando la persona no ve
-- el espacio, que es la misma respuesta que si no existiera.
create or replace function public.kb_space_for(p_user_id uuid, p_space_id uuid)
returns table (
  id uuid,
  name text,
  scope kb_scope,
  scope_id uuid,
  description text,
  created_by uuid,
  created_at timestamptz,
  level text,
  everyone boolean,
  grant_count int
)
language sql
stable
as $$
  select * from public.kb_spaces_for(p_user_id) f where f.id = p_space_id;
$$;

comment on function public.kb_space_for(uuid, uuid) is
  'Un espacio con el nivel de quien pregunta, en un solo viaje. Cero filas si no lo ve. Se apoya en kb_spaces_for para que no exista una segunda definición de la visibilidad.';

create or replace function public.kb_space_access(p_user_id uuid, p_space_id uuid)
returns table (
  grant_id uuid,
  subject_kind text,
  subject_id uuid,
  subject_name text,
  level text,
  granted_at timestamptz
)
language sql
stable
as $$
  select g.id,
         g.subject_kind,
         g.subject_id,
         case g.subject_kind
           when 'everyone' then 'Toda la empresa'
           when 'team' then (select t.name from public.teams t where t.id = g.subject_id)
           when 'user' then (select coalesce(nullif(btrim(u.name), ''), u.email)
                             from public.users u where u.id = g.subject_id)
         end,
         g.level,
         g.created_at
  from public.kb_space_grants g
  where g.space_id = p_space_id
    and public.kb_space_level(p_user_id, p_space_id) = 'admin'
  order by case g.subject_kind when 'everyone' then 0 when 'team' then 1 else 2 end,
           g.created_at;
$$;

comment on function public.kb_space_access(uuid, uuid) is
  'Quién tiene acceso a un espacio, con el nombre del equipo o de la persona ya resuelto — y cero filas si quien pregunta no administra ese espacio. Segunda valla: la primera es assertCanAdminSpace en kb/spaces.ts.';

-- ---------------------------------------------------------------------------
-- 8. Nadie más que la llave de servicio
-- ---------------------------------------------------------------------------
-- PostgREST publica toda función de `public` bajo /rpc/, y estas cuatro toman
-- un id de usuario o de espacio como argumento suelto: sin esto, cualquiera con
-- una llave anon podría preguntarlas por otra persona.
revoke all on function public.kb_space_level(uuid, uuid) from public, anon, authenticated;
revoke all on function public.kb_spaces_for(uuid) from public, anon, authenticated;
revoke all on function public.kb_space_for(uuid, uuid) from public, anon, authenticated;
revoke all on function public.kb_space_access(uuid, uuid) from public, anon, authenticated;
revoke all on function public.kb_grant_rank(text) from public, anon, authenticated;
grant execute on function public.kb_space_level(uuid, uuid) to service_role;
grant execute on function public.kb_spaces_for(uuid) to service_role;
grant execute on function public.kb_space_for(uuid, uuid) to service_role;
grant execute on function public.kb_space_access(uuid, uuid) to service_role;
grant execute on function public.kb_grant_rank(text) to service_role;

comment on column public.kb_collections.scope is
  'De QUIÉN es el espacio, ya no quién lo ve (migración 0123). global = de la organización; user = el cuaderno de la persona en scope_id. Quién lo ve se responde en kb_space_grants.';
