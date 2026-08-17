-- =============================================================================
-- TRÁMITES QUE SE ENCADENAN, Y EL ÚNICO MOMENTO EN QUE LLAMAN A UNA PERSONA.
-- =============================================================================
--
-- La migración 0087 enseñó a Cortex a hacer un trámite en el portal de otro.
-- Uno. Empezaba en una URL, terminaba en una página de resultados y, si había
-- suerte, bajaba un PDF. Lo que un administrador en Bogotá hace de verdad no
-- es eso: es leer el NIT en un Drive, sacar el certificado en la DIAN con ese
-- NIT, y subir ese certificado al portal del cliente. Tres sistemas, y el dato
-- de cada paso sale del anterior.
--
-- Esta migración es lo que le faltaba a esa cadena. Son tres cosas, y cada una
-- resuelve un eslabón distinto:
--
--   1. LOS DATOS QUE VIAJAN. Las variables de un trámite ya existían (columna
--      `variables`, 0087) pero eran nombre y etiqueta: suficiente cuando una
--      persona las escribe leyendo el rótulo al lado. Dejan de serlo cuando el
--      valor llega de un Drive o de otro trámite, porque entonces NADIE LEE EL
--      RÓTULO. Se añade `type` a cada variable, que es la regla de
--      normalización que convierte `900.123.456-7` en lo que la casilla de la
--      DIAN pide. Ver packages/agent-tools/src/browser/slots.ts.
--
--   2. QUIÉN PUEDE CORRER SOLO. Un encargo (0089) es de sólo lectura por
--      construcción: la lista de herramientas que recibe no contiene nada que
--      escriba. `browser.run_flow` no estaba en esa lista y boundary.ts dejó
--      escrito por qué y qué hacer cuando llegara — no meter la herramienta
--      entera, sino admitir trámites de a uno. `errand_allowed` es ese permiso,
--      por trámite, puesto a mano por un administrador.
--
--   3. DÓNDE SE PARA A PREGUNTAR. Un captcha o un código por SMS no son
--      fallas: son el trámite pidiendo la única cosa que una grabación no
--      puede grabar. `browser_flow_checkpoints` guarda ese punto de espera para
--      que un encargo pueda bloquearse, avisarle a alguien, y seguir cuando
--      conteste — en vez de morirse a mitad de camino.
--
-- -----------------------------------------------------------------------------
-- LA HONESTIDAD SOBRE EL PUNTO 3, ESCRITA AQUÍ Y NO EN UN TICKET
-- -----------------------------------------------------------------------------
-- Un checkpoint apunta a UNA PESTAÑA DE CHROMIUM viva en el servicio de
-- navegador (services/browser). Esa pestaña tiene las cookies, el formulario a
-- medio llenar y el captaba a medio resolver, y NO SOBREVIVE a un reinicio del
-- contenedor ni a más de unos minutos de que nadie venga: `sessionIdleMs` la
-- barre. Eso no se puede arreglar guardando filas, porque lo que hay que
-- guardar es un proceso.
--
-- Entonces la fila NO PROMETE lo que la pestaña no puede cumplir. Lleva su
-- propio `expires_at`, copiado del que dio el servicio, y un checkpoint vencido
-- se lee como vencido: el encargo lo dice, vuelve a arrancar el trámite desde
-- cero y avisa. Un botón que ofrece desbloquear una sesión que ya no existe es
-- peor que no tener botón.
--
-- Lo que sí sobrevive siempre es el caso de OTP-por-texto dentro de la ventana:
-- el código llega en segundos, la persona contesta en el chat, y la pata sigue.
-- Ése es el caso que esta migración cierra de punta a punta.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Los slots tienen tipo
-- -----------------------------------------------------------------------------
--
-- `variables` es jsonb, así que un campo nuevo no necesita DDL. Lo que sí
-- necesita es que el disco y el código digan lo mismo: `variableSchema` da
-- 'text' por defecto, así que un trámite viejo YA se lee como texto. Este
-- backfill escribe ese default para que una consulta a mano sobre la columna
-- vea lo mismo que ve la aplicación, en vez de un campo ausente que hay que
-- saber interpretar.

update public.browser_flows
set variables = (
  select jsonb_agg(
    case
      when v ? 'type' then v
      else v || '{"type":"text"}'::jsonb
    end
    order by ord
  )
  from jsonb_array_elements(variables) with ordinality as t(v, ord)
)
where jsonb_typeof(variables) = 'array'
  and jsonb_array_length(variables) > 0
  and exists (
    select 1 from jsonb_array_elements(variables) as e(v) where not (v ? 'type')
  );

-- Lo mismo en el historial de versiones: una versión anterior que se restaure
-- tiene que traer variables con la misma forma que las de hoy.
update public.browser_flow_versions
set variables = (
  select jsonb_agg(
    case
      when v ? 'type' then v
      else v || '{"type":"text"}'::jsonb
    end
    order by ord
  )
  from jsonb_array_elements(variables) with ordinality as t(v, ord)
)
where jsonb_typeof(variables) = 'array'
  and jsonb_array_length(variables) > 0
  and exists (
    select 1 from jsonb_array_elements(variables) as e(v) where not (v ? 'type')
  );


-- -----------------------------------------------------------------------------
-- 2. Qué trámites puede correr un encargo por su cuenta
-- -----------------------------------------------------------------------------

alter table public.browser_flows
  add column if not exists errand_allowed boolean not null default false;

comment on column public.browser_flows.errand_allowed is
  'Este trámite puede correr DENTRO de un encargo, sin nadie mirando. Falso por defecto y siempre puesto a mano por un administrador: la lista de herramientas de un encargo es de ids exactos justamente para que ampliarla sea un diff que alguien defiende, y esto es esa misma regla un nivel más abajo — el permiso es por trámite, no por herramienta. Sólo tiene efecto sobre trámites de tipo read: uno que escribe en el portal ajeno pasa por Aprobaciones, esté marcado o no. Ver packages/agent-tools/src/errands/boundary.ts.';

-- Un trámite que escribe no puede quedar admitido, ni por error ni por una
-- pantalla que no filtró. La regla vive en la tabla porque una regla que sólo
-- vive en el código de la pantalla es una regla que la próxima pantalla se
-- salta.
alter table public.browser_flows
  drop constraint if exists browser_flows_errand_allowed_reads_only;
alter table public.browser_flows
  add constraint browser_flows_errand_allowed_reads_only
  check (errand_allowed = false or effect = 'read');

create index if not exists browser_flows_errand_allowed_idx
  on public.browser_flows (organization_id, errand_allowed)
  where errand_allowed = true;


-- -----------------------------------------------------------------------------
-- 3. El punto donde el trámite se para a pedir una persona
-- -----------------------------------------------------------------------------

create table if not exists public.browser_flow_checkpoints (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,

  flow_id uuid not null references public.browser_flows (id) on delete cascade,
  -- La corrida que se detuvo. `set null` y no `cascade`: si alguien purga el
  -- historial de corridas, el checkpoint sigue siendo una cosa que existe y
  -- que hay que vencer o resolver.
  run_id uuid references public.browser_flow_runs (id) on delete set null,

  -- La pestaña viva en services/browser. No es un uuid: lo acuña el servicio
  -- (`s_<base36>_<random>`) y aquí sólo se guarda.
  session_id text not null,

  -- 'bot-check'    el portal preguntó si somos un robot. La respuesta es un
  --                acto en la pestaña, no un valor: alguien tiene que mirar la
  --                pantalla y hacer clic.
  -- 'input-needed' el trámite declaró un paso `pause`. La respuesta es un
  --                texto — el código que llegó al celular — y `fills` dice en
  --                qué slot entra.
  reason text not null check (reason in ('bot-check', 'input-needed')),

  -- La pregunta, en las palabras de quien enseñó el trámite. Guardada y no
  -- derivada porque tiene que decir lo mismo en la pantalla del trámite, en el
  -- chat y en la pregunta del encargo.
  ask text not null,

  -- El slot que llena la respuesta. Null para un bot-check, que no llena nada.
  fills text,

  -- El paso desde el que sigue. Ya viene descontado el paso `pause` mismo.
  from_index integer not null check (from_index >= 0),

  -- Los datos de la corrida, YA REDACTADOS por `safeInputs`: sin secretos de
  -- credencial y con los slots de tipo `code` en '***'. Se guardan para poder
  -- reanudar sin volver a pedirlos, y el que NO se guarda es justamente el que
  -- esta pausa está esperando.
  inputs jsonb not null default '{}'::jsonb,

  -- Cuando la pausa ocurre dentro de un encargo, estas dos columnas son el
  -- puente: la pata queda bloqueada en `errand_questions` como cualquier otra
  -- pregunta, y contestarla es lo que reanuda la pestaña.
  errand_id uuid references public.errands (id) on delete cascade,
  errand_question_id uuid references public.errand_questions (id) on delete set null,

  state text not null default 'open'
    check (state in ('open', 'resumed', 'expired', 'cancelled')),

  -- Copiado del handoff que dio el servicio. La fila NO decide cuánto vive la
  -- pestaña; sólo recuerda lo que el servicio dijo. Ver la nota de arriba.
  expires_at timestamptz not null,

  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,

  -- Un bot-check no llena nada; una pausa declarada siempre llena algo. Si no,
  -- la respuesta de la persona no tendría dónde entrar y el trámite seguiría
  -- exactamente igual de trancado un paso más allá.
  constraint browser_flow_checkpoints_fills_shape check (
    (reason = 'bot-check' and fills is null)
    or (reason = 'input-needed' and fills is not null and length(fills) > 0)
  ),

  -- Un final tiene fecha. Sin esto, un checkpoint 'resumed' sin `resolved_at`
  -- es indistinguible de uno que nadie tocó.
  constraint browser_flow_checkpoints_resolution check (
    (state = 'open' and resolved_at is null)
    or (state <> 'open' and resolved_at is not null)
  )
);

comment on table public.browser_flow_checkpoints is
  'Un trámite parado esperando a una persona: un captcha, o el código que llegó al celular. Apunta a una pestaña VIVA en services/browser, que se barre a los pocos minutos — por eso la fila lleva su propio expires_at y un checkpoint vencido se lee como vencido en vez de ofrecer un botón que no funciona.';

-- Un trámite parado se parece a un trámite trabajando desde afuera, así que la
-- consulta que importa es «¿qué hay abierto en este espacio de trabajo?», y la
-- hace tanto la pantalla como el barrido que vence los viejos.
create index if not exists browser_flow_checkpoints_open_idx
  on public.browser_flow_checkpoints (organization_id, state, expires_at)
  where state = 'open';

-- El encargo llega por su lado: «esta pata se bloqueó, ¿en qué pestaña iba?».
create index if not exists browser_flow_checkpoints_errand_idx
  on public.browser_flow_checkpoints (errand_id)
  where errand_id is not null;

-- UNA CORRIDA SE PARA EN UN SOLO SITIO A LA VEZ. Sin este índice, un segundo
-- worker que reintentara la misma corrida abriría un segundo checkpoint sobre
-- la misma pestaña, y contestar uno dejaría el otro colgado para siempre —
-- exactamente la forma del índice de una-pregunta-abierta que ya protege a los
-- encargos (0089).
create unique index if not exists browser_flow_checkpoints_one_open_idx
  on public.browser_flow_checkpoints (run_id)
  where state = 'open' and run_id is not null;

alter table public.browser_flow_checkpoints enable row level security;

drop policy if exists browser_flow_checkpoints_service_only on public.browser_flow_checkpoints;
create policy browser_flow_checkpoints_service_only on public.browser_flow_checkpoints
  for all to service_role using (true) with check (true);
