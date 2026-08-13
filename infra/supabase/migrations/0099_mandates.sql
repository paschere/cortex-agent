-- Mandatos: lo que una empresa decide que Cortex puede hacer sin preguntarle.
--
-- ---------------------------------------------------------------------------
-- LO QUE FALTABA, Y POR QUÉ ES LA DECISIÓN MÁS PELIGROSA DEL PRODUCTO
-- ---------------------------------------------------------------------------
-- Hasta aquí la autonomía de Cortex era binaria y la elegía el producto: una
-- herramienta pedía confirmación o no la pedía. Un dueño que quiere decir
-- «puedes mandarles correos a los clientes sin preguntarme» o «puedes aprobar
-- hasta $500.000» no tenía dónde decirlo, y la única alternativa que existía
-- —apagar `external_send_requires_confirmation` en `security_policies`— lo
-- apaga para TODO el espacio de trabajo, para todas las herramientas y para
-- siempre. Eso no es delegar; es dejar de mirar.
--
-- Un mandato es una excepción NOMBRADA, ACOTADA y CADUCA sobre la doctrina de
-- la casa. Y es, con diferencia, lo más peligroso que hay en el esquema: es la
-- única fila del producto cuya lectura puede convertir un `confirm` en un
-- `allow`. Todo lo que sigue está escrito desde ahí.
--
-- ---------------------------------------------------------------------------
-- LA INVARIANTE QUE ESTA MIGRACIÓN NO PUEDE ROMPER
-- ---------------------------------------------------------------------------
-- `block` ENTRA, `block` SALE. En packages/agent-tools/src/registry.ts la rama
-- de `block` se evalúa antes de mirar `opts.confirmed` y no la consulta: hoy un
-- `critical` no lo desbloquea ni una persona pulsando confirmar ni una rutina
-- desatendida. Nada de esta migración crea esa invariante; todo lo de esta
-- migración existe para NO abrir un camino que la rodee.
--
-- La única transición implementada es `confirm -> allow`. `allow -> confirm` y
-- `allow -> block` caben en el tipo y NO se implementan: las deny-lists de
-- equipo (`team_tool_permissions`) ya restringen, y dos mecanismos que
-- restringen acaban divergiendo, y el día que divergen nadie sabe cuál contestó.
--
-- ---------------------------------------------------------------------------
-- LA REGLA SE ESCRIBE DOS VECES
-- ---------------------------------------------------------------------------
-- `max_risk_level` lleva un CHECK que excluye `critical`, y el mismo límite está
-- otra vez en TypeScript (`isDelegatable`, en security/mandate.ts). No es
-- duplicación por descuido: un mandato crítico NO DEBE PODER EXISTIR como fila,
-- y además no debe ser obedecido si alguien la escribiera por otro camino —un
-- script, un `psql`, una migración futura distraída—. La segunda copia es la
-- que sigue de pie cuando la primera falla.
--
-- ---------------------------------------------------------------------------
-- LOS PATRONES SE GUARDAN, PERO MANDA LA INSTANTÁNEA
-- ---------------------------------------------------------------------------
-- `tool_patterns` guarda lo que la persona escribió (`gmail.*`) porque es lo que
-- la pantalla enseña y lo que se puede discutir. Pero el conjunto EFECTIVO es su
-- intersección con `covered_tool_ids`, una instantánea de ids resueltos en el
-- momento de conceder.
--
-- Para CAPACIDAD, `gmail.*` incluyendo lo que todavía no existe es lo correcto y
-- registry.ts:60 lo argumenta bien: un agente que lista familias una a una
-- pierde silenciosamente cada integración nueva. Para AUTONOMÍA es exactamente
-- al revés: una herramienta que se despliegue el mes que viene quedaría
-- autodelegada sin que nadie lo hubiera decidido, y nadie lo sabría hasta que
-- actuara. Por lo mismo `*` a secas se rechaza (CHECK), y `custom_tools`
-- (migración 0067) no es delegable en absoluto: su radio de acción lo describe
-- una fila que se puede EDITAR después de concedido el mandato, así que la
-- instantánea seguiría diciendo el mismo id mientras la URL detrás cambió.
--
-- ---------------------------------------------------------------------------
-- VIGENCIA: `expires_at` ES NOT NULL A PROPÓSITO
-- ---------------------------------------------------------------------------
-- 90 días por defecto, renovable con dos clics. El argumento es de una línea:
-- EL PASO DEL TIEMPO SOLO PUEDE HACER QUE CORTEX HAGA MENOS. Un permiso que no
-- caduca sobrevive a la persona que lo concedió, al proyecto que lo justificaba
-- y al puesto de quien lo pidió; el que caduca obliga a que alguien vuelva a
-- decir que sí, que es el único momento en que un permiso se revisa de verdad.
--
-- ---------------------------------------------------------------------------
-- EL TECHO MONETARIO Y SU CONFESIÓN
-- ---------------------------------------------------------------------------
-- `classify()` no extrae cifras de ningún sitio, y leer «$1.200.000» del cuerpo
-- de un correo para decidir si cabe bajo un techo es poco fiable justo en la
-- dirección peligrosa: el falso negativo (no la encuentro, luego cabe) autoriza.
--
-- Así que un techo SOLO se aplica a herramientas cuyo esquema de entrada declara
-- importe y moneda tipados (`ToolDef.declaredAmount`). Si la herramienta no lo
-- declara, si el importe no viene, si no trae moneda o si trae una que la
-- concesión no nombra, el mandato NO aplica y la llamada se para a preguntar. Es
-- el espejo de dos reglas que ya existen: `currency` nunca se asume COP
-- (migración 0076) y `aggregateRecords` nunca mezcla monedas.
--
-- Hoy casi ninguna herramienta declara importe, y las columnas van desde el día
-- uno igualmente, nulables. Un techo sobre una herramienta que no sabe declarar
-- cuánto mueve no delega nada, que es exactamente lo que debe pasar.
--
-- `amount_ceiling` y `currency` son un PAR (CHECK): un techo sin moneda compara
-- pesos contra dólares y una moneda sin techo no limita nada.
--
-- ---------------------------------------------------------------------------
-- LO DESATENDIDO
-- ---------------------------------------------------------------------------
-- `applies_unattended` existe y nace en `false`. Conviene decir en voz alta lo
-- que NO habilita: `surface='schedule'` añade la señal `unattended` en
-- `classify()`, y esa señal convierte cualquier `external_send` en `critical`,
-- que se bloquea. O sea que ni con la bandera encendida puede un mandato hacer
-- que Cortex le mande un correo a un cliente a las 3 de la mañana por su cuenta.
--
-- ---------------------------------------------------------------------------
-- ATENCIÓN AL ESCRIBIR: LA LECCIÓN DE LA 0064 -> 0095, OTRA VEZ
-- ---------------------------------------------------------------------------
-- Las dos tablas nacen con `organization_id NOT NULL` desde la primera línea, y
-- cada una tiene UNA SOLA función de escritura en todo el producto:
--
--   mandates        apps/web/lib/mandates/store.ts — `grantMandate()` es el
--                   único INSERT y `revokeMandate()` el único UPDATE. La
--                   pantalla y la API pasan por ahí y no tocan la tabla.
--   mandate_uses    packages/agent-tools/src/security/mandate-store.ts —
--                   `recordMandateUse()`, y se llama ANTES de ejecutar.
--
-- Si algún día se le añade una columna obligatoria a cualquiera de las dos, esos
-- son los únicos dos sitios que hay que revisar, y ese «únicos» es la mitad del
-- valor del diseño.
--
-- `mandate_uses` se escribe ANTES de ejecutar por una razón concreta: si se
-- escribiera después, una caída a mitad de la ejecución dejaría un correo
-- enviado y ningún rastro de que un mandato lo autorizó, y el presupuesto del
-- día se habría gastado sin constar. Anotando antes, lo peor que pasa es que
-- conste un uso de algo que quizá no llegó a ocurrir: un presupuesto que se
-- equivoca hacia arriba pregunta de más; uno que se equivoca hacia abajo
-- autoriza de más.

-- ===========================================================================
-- 1. Las concesiones
-- ===========================================================================

create table if not exists public.mandates (
  id                  uuid primary key default gen_random_uuid(),

  -- El espacio de trabajo. TEXT y no uuid porque los ids de better-auth lo son,
  -- igual que en todas las tablas desde la 0064. Un mandato pertenece a la
  -- empresa que lo declaró y no se lee jamás fuera de ella.
  organization_id     text        not null
                        references public.ba_organization(id) on delete cascade,

  -- Cómo se llama esto en la pantalla y en la frase que Cortex le dice a la
  -- persona cuando actúa sin preguntar («…está dentro del mandato "Correos a
  -- clientes"»). Not null: una delegación anónima no se puede explicar.
  label               text        not null,

  -- Para qué se concedió, en palabras de quien lo concedió. Es lo único de la
  -- fila que sirve dentro de seis meses para decidir si renovarlo.
  reason              text        not null default '',

  -- QUIÉN LO DECLARÓ. Not null, y con `on delete restrict`: mismo criterio que
  -- `client_domains.verified_by` en la 0075. Una declaración sin autor es justo
  -- lo que no puede existir — un permiso que nadie concedió es un permiso que
  -- nadie puede defender, y borrar a la persona no puede dejar huérfano el
  -- permiso que sigue actuando en su nombre.
  granted_by          uuid        not null references public.users(id) on delete restrict,

  -- Lo que la persona escribió: 'gmail.*', 'clients.update'. Nunca '*'.
  tool_patterns       text[]      not null,

  -- La instantánea de ids resueltos al conceder. Es la que manda.
  covered_tool_ids    text[]      not null,

  -- El techo de riesgo. `critical` NO CABE, y el CHECK es la mitad de la regla:
  -- la otra mitad está en TypeScript.
  max_risk_level      text        not null default 'medium',

  -- Techo monetario y su moneda. Par: los dos, o ninguno.
  amount_ceiling      numeric(18,2),
  currency            char(3),

  -- ¿Vale también cuando no hay nadie delante? Nace apagado.
  applies_unattended  boolean     not null default false,

  -- Presupuesto diario de usos. Null = sin tope.
  max_uses_per_day    integer,

  starts_at           timestamptz not null default now(),
  expires_at          timestamptz not null,

  revoked_at          timestamptz,
  revoked_by          uuid        references public.users(id) on delete set null,

  created_at          timestamptz not null default now(),

  -- Un mandato crítico no puede existir como fila. Ver la cabecera.
  constraint mandates_max_risk_level_check
    check (max_risk_level in ('low', 'medium', 'high')),

  -- El par monetario, o nada.
  constraint mandates_money_pair
    check ((amount_ceiling is null) = (currency is null)),
  constraint mandates_money_shape
    check (currency is null or (currency ~ '^[A-Z]{3}$' and amount_ceiling > 0)),

  -- Un mandato sin patrones no delega nada, y uno con '*' delega lo que todavía
  -- no existe. Ninguno de los dos debe poder guardarse.
  --
  -- `cardinality()` y NO `array_length(x, 1)`: sobre un array vacío
  -- `array_length` devuelve NULL, `NULL >= 1` es NULL, y un CHECK que evalúa a
  -- NULL PASA. Escrito con array_length, este constraint dejaba entrar
  -- exactamente la fila que existe para prohibir — una instantánea vacía— y no
  -- lo habría contado ningún tipo, ninguna prueba de TypeScript y ninguna
  -- revisión: solo un INSERT contra la base de verdad.
  constraint mandates_patterns_present
    check (cardinality(tool_patterns) >= 1),
  constraint mandates_no_bare_star
    check (not ('*' = any(tool_patterns))),
  constraint mandates_snapshot_present
    check (cardinality(covered_tool_ids) >= 1),

  constraint mandates_window
    check (expires_at > starts_at),
  constraint mandates_uses_positive
    check (max_uses_per_day is null or max_uses_per_day > 0),

  -- Revocar es un acto con autor, igual que conceder.
  constraint mandates_revocation_complete
    check ((revoked_at is null) = (revoked_by is null))
);

comment on table public.mandates is
  'Excepciones nombradas, acotadas y caducas sobre la doctrina de seguridad: lo que esta empresa decidió que Cortex puede hacer sin preguntar. Solo puede convertir un confirm en un allow; nunca desbloquea un block ni un critical.';

comment on column public.mandates.covered_tool_ids is
  'Instantánea de ids resueltos AL CONCEDER. El conjunto efectivo es su intersección con tool_patterns: para autonomía, una herramienta desplegada después no puede quedar autodelegada.';

comment on column public.mandates.max_risk_level is
  'Techo de riesgo. Nunca critical: la misma regla está escrita en TypeScript (isDelegatable), a propósito.';

comment on column public.mandates.applies_unattended is
  'Si vale para surface=schedule. Aun encendida, classify() convierte cualquier external_send desatendido en critical, que se bloquea.';

comment on column public.mandates.expires_at is
  'Not null a propósito: el paso del tiempo solo puede hacer que Cortex haga menos.';

-- La lectura caliente: «concesiones vigentes de este espacio que nombran esta
-- herramienta». El índice GIN sobre la instantánea es el que sostiene el
-- `covered_tool_ids @> {tool_id}` de cada llamada que iba a pararse.
create index if not exists mandates_live_idx
  on public.mandates (organization_id, expires_at desc)
  where revoked_at is null;

create index if not exists mandates_covered_idx
  on public.mandates using gin (covered_tool_ids);

-- ===========================================================================
-- 2. Los usos
-- ===========================================================================

create table if not exists public.mandate_uses (
  id               uuid primary key default gen_random_uuid(),

  organization_id  text        not null
                     references public.ba_organization(id) on delete cascade,

  -- `cascade`: si la concesión desaparece, su consumo no significa nada. Lo que
  -- queda para siempre es la fila de `audit_events`, que sobrevive a las dos.
  mandate_id       uuid        not null references public.mandates(id) on delete cascade,

  tool_id          text        not null,

  -- Quién estaba pidiendo cuando el mandato respondió. Nullable: una rutina
  -- desatendida corre en nombre del espacio, no de una persona.
  user_id          uuid        references public.users(id) on delete set null,
  agent_id         uuid,

  surface          text,

  -- El nivel REAL de la llamada, no el techo del mandato. Guardar el techo haría
  -- que esta tabla mintiera sobre lo que la llamada era.
  risk_level       text        not null,

  -- El importe tipado, cuando lo hubo. Es lo que permite contestar «¿cuánto
  -- dinero movió Cortex por su cuenta este mes?» sin releer los payloads.
  amount           numeric(18,2),
  currency         char(3),

  input_digest     text,

  used_at          timestamptz not null default now(),

  constraint mandate_uses_money_pair
    check ((amount is null) = (currency is null))
);

comment on table public.mandate_uses is
  'Una fila por cada vez que un mandato levantó una pregunta. Se escribe ANTES de ejecutar: una caída a mitad tiene que dejar rastro, y el presupuesto diario tiene que fallar cerrado.';

-- Sostiene el presupuesto diario: usos de estas concesiones desde la medianoche
-- de Bogotá.
create index if not exists mandate_uses_budget_idx
  on public.mandate_uses (mandate_id, used_at desc);

create index if not exists mandate_uses_org_idx
  on public.mandate_uses (organization_id, used_at desc);

-- ===========================================================================
-- 3. La auditoría registra LAS DOS COSAS
-- ===========================================================================
-- El mandato NO muta la clasificación. Si bajara el riesgo para justificarse,
-- `audit_events.risk_level` empezaría a mentir sobre lo que la llamada era —y
-- ese es justo el dato por el que alguien abre la auditoría—. Así que la fila
-- conserva su `risk_level` real y añade dos cosas: `decision = 'delegated'`
-- (valor nuevo junto a allowed | flagged | blocked | confirmed, ver la 0042) y
-- el `mandate_id` que respondió.
--
-- `on delete set null`: revocar o borrar un mandato no puede reescribir la
-- historia de lo que ya pasó. La fila de auditoría sigue diciendo 'delegated'
-- aunque la concesión ya no exista, que es exactamente lo que un auditor
-- necesita ver.

alter table public.audit_events
  add column if not exists mandate_id uuid references public.mandates(id) on delete set null;

alter table public.security_events
  add column if not exists mandate_id uuid references public.mandates(id) on delete set null;

comment on column public.audit_events.mandate_id is
  'La concesión que autorizó esta llamada sin preguntar. Va JUNTO al risk_level real, nunca en su lugar.';

create index if not exists audit_events_mandate_idx
  on public.audit_events (mandate_id, created_at desc)
  where mandate_id is not null;

create index if not exists security_events_mandate_idx
  on public.security_events (mandate_id, created_at desc)
  where mandate_id is not null;
