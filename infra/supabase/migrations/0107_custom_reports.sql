-- ===========================================================================
-- INFORMES DE LO QUE SEA: LA RECETA SE MUDA FUERA DEL CHECK
-- ===========================================================================
-- La 0079 escribió «Three, and only three. A fourth is a code change plus a
-- migration, which is the correct amount of friction». La 0088 pagó esa
-- fricción por 'chart', la 0100 por 'weekly' y la 0103 por 'answer'. Tres veces
-- en cuatro migraciones es el dato: la fricción dejó de ser correcta y pasó a
-- ser el techo del producto. «Que se puedan pedir informes de lo que sea» no
-- cabe en una lista que crece a mano, un informe cada vez.
--
-- ---------------------------------------------------------------------------
-- POR QUÉ EL CHECK NO SE VA
-- ---------------------------------------------------------------------------
-- La salida obvia es quitarlo y dejar `kind` en texto libre. Eso pierde la
-- única cosa que el CHECK daba —que la lista de informes sea una lista y no una
-- acumulación— y no resuelve nada, porque el problema nunca fue el CHECK: fue
-- que `kind` hacía dos trabajos.
--
-- Decía DE QUÉ TRATA el informe ('expiries', 'fleet', 'client_activity') y a la
-- vez DE DÓNDE VINO la fila ('chart' y 'answer' no son asuntos, son
-- procedencias — la propia pantalla de /reports lo dice en un comentario). El
-- primero de los dos trabajos es el que no cabe en una lista cerrada. El
-- segundo sí: de dónde puede venir una fila es una pregunta con pocas
-- respuestas y no crece cuando crece el catálogo de informes.
--
-- Así que el ASUNTO se muda a `report_recipes` —una fila con nombre y una lista
-- de bloques con sus parámetros— y `kind` se queda con la procedencia y recibe
-- su último valor: 'custom'. Es el valor que hace que la lista deje de crecer,
-- porque a partir de aquí un informe nuevo es una fila en una tabla y no un
-- valor nuevo en un CHECK. Si esta lista vuelve a crecer, algo se hizo mal.
--
-- ---------------------------------------------------------------------------
-- QUÉ IMPIDE AHORA QUE HAYA CUATRO INFORMES QUE SON EL MISMO
-- ---------------------------------------------------------------------------
-- Conviene ser exacto sobre cuánto impedía el CHECK: lo impedía entre
-- desarrolladores, obligando a una migración y por tanto a una revisión. Entre
-- usuarios no impedía nada, porque un usuario nunca pudo crear un tipo. Ahora
-- sí puede crear un informe, así que la garantía tiene que ser más fuerte justo
-- donde antes no existía:
--
--   `report_recipes_fingerprint_idx`  único por (organization_id, fingerprint).
--   La huella es el sha256 de la lista canónica de bloques y parámetros
--   normalizados, SIN el nombre. Dos recetas que calculan exactamente lo mismo
--   chocan aunque se llamen distinto, y el código devuelve la que ya existe.
--
--   `report_recipes_name_idx`  único por (organization_id, lower(name)), para
--   que la lista se pueda leer y para que «el de cartera» sea uno solo.
--
-- El orden de los bloques entra en la huella a propósito: dos informes con los
-- mismos bloques en otro orden son dos informes distintos, porque el orden de
-- lectura es parte de lo que un informe dice.
--
-- ---------------------------------------------------------------------------
-- LA FOTOGRAFÍA NO SE TOCA
-- ---------------------------------------------------------------------------
-- Una receta es una PREGUNTA GUARDADA y se vuelve a correr. Un informe es una
-- FOTOGRAFÍA y no se vuelve a correr nunca. Cada corrida de una receta escribe
-- una fila NUEVA en `reports` con su documento resuelto y su `content_hash`,
-- exactamente igual que los tres de siempre. `reports.recipe_id` dice de qué
-- pregunta salió esa foto; NO es un puntero a algo que haya que volver a
-- ejecutar para leerla. Abrir el informe de julio en noviembre sigue sin correr
-- una sola consulta.
--
-- Por eso el borrado de una receta es `restrict` y no `set null`: una foto sin
-- linaje sigue siendo una foto correcta, pero deja de poder decir de qué
-- pregunta salió, y ése es un dato que no se recupera. Las recetas se archivan
-- (`archived_at`), no se borran.
--
-- ---------------------------------------------------------------------------
-- LO QUE NO SALE POR UN ENLACE PÚBLICO
-- ---------------------------------------------------------------------------
-- Mientras hubo tres informes, compartir fue una decisión sin matices: los tres
-- hablaban de papeles y de terceros y ninguno nombraba a un empleado. Un
-- informe a la medida sí puede — hay un bloque que lista qué quedó de hacer
-- cada persona del equipo —, y el enlace de la 0079 no pide contraseña: quien
-- lo tenga, entra.
--
-- `reports.restricted` lo marca, y el CHECK
-- `restricted = false or share_token is null` lo impide. No es una regla del
-- código que haya que recordar en cada pantalla que comparte: es un estado que
-- la base no acepta guardar. El código de `shareReport` sólo existe para dar la
-- razón en español antes de llegar aquí.
--
-- Va en la FILA y no dentro de `document` a propósito. Un campo nuevo dentro
-- del documento le cambiaría la serialización canónica a todos los informes ya
-- guardados y por tanto su `content_hash`, y el día del despliegue todos
-- empezarían a decir «alguien tocó esto». La postura de compartir es un dato
-- sobre el artefacto, no sobre lo que el artefacto dice.
--
-- ---------------------------------------------------------------------------
-- PROGRAMARLOS: NO HAY SUPERFICIE NUEVA
-- ---------------------------------------------------------------------------
-- No hay nada de agenda en esta migración y es deliberado. `scheduled_jobs`
-- (0026) ya sabe correr una herramienta con su entrada, validada contra el
-- esquema de esa herramienta al crearse. «Mándame este informe cada lunes» es
-- una rutina `kind = 'tool'` sobre `reports.run` con el id de la receta. No
-- hacía falta un programador de informes; hacía falta un informe que un
-- programador pudiera correr, y eso es lo que es una receta.
--
-- Tenencia: `organization_id` en cada fila, registrada como `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. RLS deny-all + service_role,
-- igual que la 0079. Idempotente de arriba abajo.

-- ===========================================================================
-- 1. Las recetas
-- ===========================================================================

create table if not exists public.report_recipes (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null,

  -- Cómo lo llama la gente. Único por espacio de trabajo, insensible a
  -- mayúsculas, porque «Cartera» y «cartera» son el mismo informe.
  name                text        not null check (length(btrim(name)) between 1 and 120),

  -- Lo que el informe dice de sí mismo en su encabezado. Separado de `name`
  -- porque el nombre es para encontrarlo en una lista y el título es para
  -- leerlo en un papel que alguien manda por correo.
  title               text        not null check (length(btrim(title)) between 1 and 300),
  subtitle            text        check (length(subtitle) <= 600),
  period_label        text        not null check (length(btrim(period_label)) between 1 and 200),

  -- { "blocks": [ { "block": "...", "params": {...} }, ... ] }
  -- El contenido de cada bloque lo valida zod en
  -- packages/agent-tools/src/reports/recipe.ts. Lo que la base garantiza es lo
  -- único que puede garantizar sola: que hay al menos un bloque y no más de
  -- seis.
  spec                jsonb       not null,

  -- sha256 de la lista canónica de bloques y parámetros NORMALIZADOS, sin el
  -- nombre. Ver el índice único de abajo.
  fingerprint         text        not null check (fingerprint ~ '^[0-9a-f]{64}$'),

  -- True cuando algún bloque nombra a alguien de la empresa. Se copia a cada
  -- informe que la receta produce.
  restricted          boolean     not null default false,

  created_by          uuid        references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  last_run_at         timestamptz,

  -- Archivar, no borrar: una receta borrada se lleva por delante el linaje de
  -- todos los informes que produjo.
  archived_at         timestamptz,

  -- UNA RECETA SIN BLOQUES NO ES UNA RECETA, Y HAY QUE ESCRIBIRLO ENTERO.
  --
  -- `jsonb_array_length(spec->'blocks') >= 1` a secas NO sirve, y falla del peor
  -- modo posible: si la clave 'blocks' no está, `spec->'blocks'` es NULL,
  -- `jsonb_array_length(NULL)` es NULL, y UN CHECK QUE DA NULL PASA. O sea que
  -- la restricción dejaría entrar precisamente `{}`, que es el caso que existe
  -- para rechazar. Es el mismo tropiezo que `array_length('{}', 1)`, que
  -- también da NULL en vez de 0.
  --
  -- `coalesce(jsonb_typeof(...), '')` cierra las dos puertas de una vez: la
  -- clave ausente y la clave que no es un arreglo. Sólo entonces se puede
  -- preguntar por la longitud.
  constraint report_recipes_has_blocks check (
    coalesce(jsonb_typeof(spec -> 'blocks'), '') = 'array'
    and jsonb_array_length(spec -> 'blocks') between 1 and 6
  )
);

-- LA GARANTÍA QUE SUSTITUYE AL CHECK DE `kind`. Dos recetas que calculan lo
-- mismo son la misma receta, se llamen como se llamen.
create unique index if not exists report_recipes_fingerprint_idx
  on public.report_recipes (organization_id, fingerprint)
  where archived_at is null;

-- Y que la lista se pueda leer.
create unique index if not exists report_recipes_name_idx
  on public.report_recipes (organization_id, lower(btrim(name)))
  where archived_at is null;

create index if not exists report_recipes_org_idx
  on public.report_recipes (organization_id, created_at desc)
  where archived_at is null;

comment on table public.report_recipes is
  'Una pregunta guardada: qué bloques componen un informe y con qué parámetros. La receta se vuelve a correr; el informe que produce, no. Ver la cabecera de packages/agent-tools/src/reports/recipe.ts.';

comment on column public.report_recipes.spec is
  'Los bloques y sus parámetros. Los ids de bloque son una unión cerrada en código (reports/blocks.ts): la base guarda la combinación, no inventa cálculos. Un bloque nuevo es una función, no una migración.';

comment on column public.report_recipes.fingerprint is
  'sha256 de la lista canónica de bloques y parámetros normalizados, SIN el nombre. Es lo que impide que haya cuatro recetas que son la misma con nombres distintos — una garantía que el CHECK de reports.kind nunca dio, porque un usuario jamás pudo crear un kind.';

comment on column public.report_recipes.restricted is
  'True cuando algún bloque nombra a alguien de la empresa. Se copia a cada informe que produce, y allí un CHECK impide que ese informe tenga enlace público.';

comment on column public.report_recipes.archived_at is
  'Las recetas se archivan, no se borran: borrarlas se llevaría por delante el linaje de los informes que produjeron, y una foto que no puede decir de qué pregunta salió no lo recupera nunca.';

alter table public.report_recipes enable row level security;
revoke all on table public.report_recipes from public, anon, authenticated;
grant select, insert, update, delete on table public.report_recipes to service_role;

-- ===========================================================================
-- 2. El informe sabe de qué pregunta salió
-- ===========================================================================

alter table public.reports
  add column if not exists recipe_id uuid;

alter table public.reports
  add column if not exists restricted boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'reports_recipe_fk'
  ) then
    alter table public.reports
      add constraint reports_recipe_fk
      foreign key (recipe_id) references public.report_recipes(id) on delete restrict;
  end if;
end $$;

create index if not exists reports_recipe_idx
  on public.reports (organization_id, recipe_id, generated_at desc)
  where recipe_id is not null;

comment on column public.reports.recipe_id is
  'De qué receta salió esta fotografía. NO es un puntero a algo que haya que volver a ejecutar para leer el informe: el documento resuelto sigue estando entero en `document`. Es linaje, y por eso el borrado es restrict.';

comment on column public.reports.restricted is
  'True cuando el informe nombra a alguien de la empresa. Un CHECK impide que una fila así tenga share_token: adentro se ve entero, afuera no sale.';

-- ===========================================================================
-- 3. El sexto y último valor de `kind`
-- ===========================================================================

alter table public.reports
  drop constraint if exists reports_kind_check;

alter table public.reports
  add constraint reports_kind_check
  check (kind in ('expiries', 'fleet', 'client_activity', 'chart', 'weekly', 'answer', 'custom'));

-- Un informe a la medida sin receta no puede decir de qué pregunta salió, y
-- una receta sólo produce informes a la medida. La implicación va en los dos
-- sentidos porque los dos huecos son igual de silenciosos.
alter table public.reports
  drop constraint if exists reports_custom_needs_recipe;

alter table public.reports
  add constraint reports_custom_needs_recipe
  check ((kind = 'custom') = (recipe_id is not null));

comment on column public.reports.kind is
  'De dónde vino la fila, que es una lista cerrada de verdad y por eso ya no crece. Los tres primeros son recetas fijas que el constructor computa; ''chart'' y ''answer'' son procedencias (algo rescatado de una conversación); ''weekly'' es una cadencia; ''custom'' es una receta de bloques guardada en report_recipes, y es el valor que hace que esta lista deje de crecer — de qué TRATA un informe a la medida lo dice su receta, no esta columna.';

-- ===========================================================================
-- 4. Lo que no sale por la puerta de afuera
-- ===========================================================================
-- Se comprueba también contra las filas que ya existen: todas tienen
-- restricted = false por el default, así que ninguna puede fallar. Escrito con
-- `not valid` + `validate` habría sido más barato y menos honesto — si algún
-- día una fila existente violara esto, es exactamente el día en que hay que
-- enterarse.

alter table public.reports
  drop constraint if exists reports_restricted_never_shared;

alter table public.reports
  add constraint reports_restricted_never_shared
  check (restricted = false or share_token is null);

comment on constraint reports_restricted_never_shared on public.reports is
  'Un informe que nombra a personas del equipo no puede tener enlace público. El enlace de la 0079 no pide contraseña: quien lo tenga, entra. Esto no es una regla del código que haya que recordar en cada pantalla que comparte — es un estado que la base no acepta guardar.';
