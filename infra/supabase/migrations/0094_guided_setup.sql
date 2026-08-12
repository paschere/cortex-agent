-- Configurar Cortex contándole cómo funciona la empresa, en vez de llenando
-- formularios.
--
-- ---------------------------------------------------------------------------
-- EL OBSTÁCULO QUE ESTO ATACA, QUE NO ES LA FALTA DE FUNCIONES
-- ---------------------------------------------------------------------------
-- Un producto con vencimientos, rutinas, flujos, clientes y espacios no falla
-- por lo que no tiene: falla porque el primer día nadie sabe cuál de esas cinco
-- cosas configurar primero, ni con qué datos. Contar cómo funciona tu propia
-- empresa, en cambio, es fácil — lo haces todos los días con cada empleado
-- nuevo. Así que la entrevista invierte la carga: la persona cuenta, y el
-- producto traduce eso a objetos suyos.
--
-- Lo que se guarda aquí NO es el producto configurado. El producto configurado
-- vive donde siempre vivió: en `commitments`, `scheduled_jobs`, `pipelines`,
-- `clients`, `kb_collections`. Estas dos tablas son la MEMORIA DE LA DECISIÓN:
-- qué se propuso, qué aceptó una persona, qué se creó y dónde quedó. Sin eso no
-- hay tres cosas que este cambio necesita y que no se pueden reconstruir
-- después:
--
--   1. Deshacer. Un objeto creado por la entrevista es indistinguible de uno
--      creado a mano una vez está en su tabla. La única forma de ofrecer
--      "deshacer" honestamente es haber anotado, en el momento, qué fila se
--      creó y en qué tabla.
--   2. Confirmación real. La propuesta se guarda ANTES de que nadie apruebe
--      nada, y la aprobación sólo puede señalar filas que ya estaban guardadas
--      como propuestas de esa sesión. Un cliente no puede pedir que se cree
--      algo que la entrevista nunca propuso, porque el servidor no lee el
--      cuerpo de la petición: lee esta tabla.
--   3. La pregunta de las dos semanas. Ver abajo.
--
-- ---------------------------------------------------------------------------
-- LA PREGUNTA DE LAS DOS SEMANAS
-- ---------------------------------------------------------------------------
-- La medida de éxito de una herramienta como ésta NO es cuántos objetos creó.
-- Es cuántos siguen ahí dos semanas después y alguien los miró. Un onboarding
-- que genera quince rutinas plausibles y deja al cliente con quince rutinas que
-- limpiar es peor que uno que no genera nada, porque además enseña a
-- desconfiar.
--
-- Por eso cada ítem creado guarda `target_table` y `target_id`: un puntero
-- estable a la fila real. Con eso, `reviewGuidedSetup` puede volver semanas
-- después y preguntarle a cada módulo, con sus propias señales y sin inventar
-- métricas nuevas, si su objeto está vivo:
--
--   commitments      ¿sigue existiendo y no fue descartado?, ¿cambió de estado?
--   scheduled_jobs   ¿tiene filas en `scheduled_job_runs`?
--   pipelines        ¿`times_run` > 0?
--   clients          ¿lo tocaron después de crearlo?
--   kb_collections   ¿le entró algún documento?
--
-- Ninguna de esas cinco señales es nueva: son las que cada módulo ya lleva.
-- Este cambio no añade telemetría, añade el puntero que permite leerla junta.
-- Y como `target_id` es un texto sin llave foránea, borrar el objeto en su
-- módulo no rompe nada: el ítem se queda como el recuerdo de algo que existió
-- y ya no, que es justamente uno de los resultados que hay que poder contar.
--
-- ---------------------------------------------------------------------------
-- POR QUÉ NO HAY LLAVE FORÁNEA A LO CREADO
-- ---------------------------------------------------------------------------
-- Cinco destinos posibles significan o cinco columnas nullables con una
-- restricción cruzada, o un par (tabla, id) sin integridad referencial. La
-- segunda es la correcta aquí porque la relación es DÉBIL a propósito: el ítem
-- describe un hecho histórico ("el 3 de marzo se creó esta rutina desde la
-- entrevista"), no una dependencia. Un vencimiento borrado no debe llevarse por
-- delante el registro de que la entrevista lo propuso y alguien lo aceptó.
--
-- ---------------------------------------------------------------------------
-- 1. LA SESIÓN
-- ---------------------------------------------------------------------------
create table if not exists public.guided_setup_sessions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null
                     references public.ba_organization(id) on delete cascade,
  started_by       uuid references public.users(id) on delete set null,

  -- interviewing  Se está hablando. Puede no llegar a nada, y está bien.
  -- proposed      Hay un plan en `guided_setup_items` esperando a una persona.
  -- applied       Alguien confirmó. Al menos un ítem se intentó crear.
  -- discarded     Alguien miró el plan y dijo que no. Se guarda igual: un plan
  --               rechazado entero es la señal más fuerte de que la entrevista
  --               entendió mal, y borrarlo la perdería.
  status           text not null default 'interviewing'
                     check (status in ('interviewing','proposed','applied','discarded')),

  -- El hilo completo: [{ role: 'person'|'cortex', text, at }]. Se guarda porque
  -- la justificación de cada ítem cita lo que la persona dijo, y una cita sin
  -- el texto original no es una cita.
  transcript       jsonb not null default '[]'::jsonb,

  -- Cuántas preguntas se han hecho ya. La regla de parada vive en el servidor y
  -- se cuenta aquí y no en el cliente, porque un tope que el cliente lleva es
  -- un tope que el cliente puede subir.
  asked_count      integer not null default 0 check (asked_count >= 0),

  -- Lo que la persona pidió y este producto NO sabe hacer, tal como lo dijo.
  -- [{ text, note }]. Es el dato más valioso de toda la tabla y el que más
  -- tentación da de no guardar: es la lista de lo que habría que construir,
  -- dicha por alguien que lo necesitaba de verdad, en el momento en que lo
  -- necesitaba.
  out_of_scope     jsonb not null default '[]'::jsonb,

  -- Lo que el producto SÍ hace pero no se configura hablando: un trámite se
  -- aprende grabando el portal, un encargo se encarga, una fuente se conecta.
  -- [{ kind, want }]. Se guarda con el plan y no se recalcula, porque es parte
  -- de la respuesta que se le dio a esta persona y tiene que sobrevivir a que
  -- recargue la página.
  handoffs         jsonb not null default '[]'::jsonb,

  -- La frase con la que Cortex resume lo que entendió, mostrada encima del plan.
  summary          text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  proposed_at      timestamptz,
  applied_at       timestamptz
);

create index if not exists guided_setup_sessions_org_idx
  on public.guided_setup_sessions (organization_id, created_at desc);

-- Para "¿esta empresa ya hizo la entrevista?", que es una pregunta de cada
-- carga de /onboarding y no debe costar un scan.
create index if not exists guided_setup_sessions_org_applied_idx
  on public.guided_setup_sessions (organization_id, applied_at desc)
  where status = 'applied';

-- ---------------------------------------------------------------------------
-- 2. CADA COSA PROPUESTA, UNA FILA
-- ---------------------------------------------------------------------------
-- La fila existe desde que se PROPONE, no desde que se crea. Ése es el punto:
-- "propuesto" es un estado real del producto, no un paso intermedio en memoria.
create table if not exists public.guided_setup_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null
                     references public.ba_organization(id) on delete cascade,
  session_id       uuid not null
                     references public.guided_setup_sessions(id) on delete cascade,

  -- Sólo estos cinco. La lista es cerrada en la base de datos y no sólo en el
  -- código porque es la promesa central de esta pantalla: la entrevista no
  -- puede ofrecer nada que el producto no sepa crear. Un modelo que se invente
  -- un sexto tipo choca contra un CHECK, que es donde debe chocar.
  kind             text not null
                     check (kind in ('commitment','routine','flow','client','space')),

  title            text not null check (length(btrim(title)) between 1 and 200),

  -- Por qué se propone, citando lo que la persona dijo. Se muestra junto al
  -- ítem: nadie debería tener que aceptar algo sin ver de dónde salió.
  rationale        text not null default '',

  -- Los campos exactos con los que se va a crear, ya validados contra el
  -- catálogo. Se guardan para que la pantalla pueda mostrarlos ANTES de crear
  -- nada, que es la diferencia entre confirmar y firmar en blanco.
  payload          jsonb not null default '{}'::jsonb,

  -- proposed  Esperando a una persona. Nada existe todavía en ningún módulo.
  -- created   Se creó. `target_table`/`target_id` apuntan a la fila.
  -- merged    Había un cliente igual y se actualizó en vez de crear uno nuevo.
  --           Estado propio porque cambia lo que "deshacer" puede prometer:
  --           borrar esa fila destruiría datos que no eran nuestros.
  -- skipped   La persona lo desmarcó. Se guarda: lo que se rechaza enseña.
  -- failed    Se intentó y el módulo dijo que no. `error` dice qué pasó.
  -- undone    Se creó y luego se deshizo.
  status           text not null default 'proposed'
                     check (status in ('proposed','created','merged','skipped','failed','undone')),

  target_table     text,
  target_id        text,
  error            text,

  created_at       timestamptz not null default now(),
  decided_at       timestamptz,
  decided_by       uuid references public.users(id) on delete set null,
  undone_at        timestamptz,

  -- Un ítem 'created' o 'merged' sin puntero es un ítem que nadie podrá
  -- deshacer ni revisar dos semanas después, o sea el bug que esta tabla existe
  -- para hacer imposible.
  constraint guided_setup_items_created_has_target
    check (status not in ('created','merged') or (target_table is not null and target_id is not null))
);

create index if not exists guided_setup_items_session_idx
  on public.guided_setup_items (session_id, created_at);

-- El barrido de "¿se usó?" recorre lo creado de una empresa, sin nombrar sesión.
create index if not exists guided_setup_items_org_created_idx
  on public.guided_setup_items (organization_id, status, created_at desc)
  where status in ('created','merged');
