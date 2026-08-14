-- Metas: el número contra el que se compara todo lo demás.
--
-- PARA QUÉ ES ESTO. En noventa y nueve migraciones y noventa tablas no hay una
-- sola cosa que diga «esto debería ser así». Hay tareas, vencimientos, pagos,
-- lecturas de documentos y acciones — todos hechos sueltos, y ninguno con nada
-- contra lo cual medirse. Lo único que en este producto compara «usado contra
-- límite» es la facturación del propio SaaS (0085), que mide a Cortex y no al
-- negocio de quien lo usa.
--
-- El dueño lo dijo en una frase: «la cartera no debe pasar de 45 días», y que
-- avise cuando se desvíe. Eso son tres cosas que aquí no existían: una cifra
-- fijada por alguien, una lectura periódica de la realidad, y un aviso cuando
-- las dos dejan de coincidir. Una por tabla.
--
-- ===========================================================================
-- LA REGLA QUE SOSTIENE TODO EL DISEÑO
-- ===========================================================================
-- UNA META SIN DATOS QUE LA ALIMENTEN ES UNA CASILLA VACÍA, Y UNA CASILLA VACÍA
-- RESTA MÁS CONFIANZA DE LA QUE SUMA.
--
-- Un tablero con seis metas de las cuales cuatro dicen «—» no enseña que faltan
-- datos: enseña que el producto no funciona, y contagia esa lectura a las dos
-- que sí traen número. No se arregla con un mejor mensaje de estado vacío. Se
-- arregla NO DEJANDO CREAR LA META.
--
-- Por eso `metric_key` no es una lista de valores en un CHECK aquí. Es un
-- registro cerrado en TypeScript —packages/agent-tools/src/goals/catalog.ts,
-- con la forma de DOCUMENT_TYPES (0076) y GENERATED_REPORT_KINDS (0079)— y cada
-- métrica declara, además de su nombre en español, su unidad y su dirección, un
-- predicado `available(db)` que consulta ESTE espacio de trabajo. Una métrica
-- que este espacio no puede calcular hoy no aparece en el selector, y el
-- selector dice por qué: «para medir cartera necesito que conectes Siigo o que
-- empieces a registrar pagos».
--
-- El CHECK de aquí es sólo de forma (`^[a-z][a-z0-9_]{2,39}$`), igual que
-- `document_extractions.doc_type`, para que añadir una métrica mañana sea un
-- objeto más en esa lista y no una migración más un despliegue más un backfill.
-- La lista canónica vive en TypeScript porque el predicado que la hace útil
-- —«¿puede este espacio calcularla?»— es una consulta, no una constante.
--
-- ===========================================================================
-- LA SEGUNDA REGLA: UNA LECTURA ES UNA FOTOGRAFÍA, NO UN MARCADOR
-- ===========================================================================
-- `goal_readings` guarda UNA FILA POR PERÍODO, CONGELADA. Es literalmente el
-- argumento de la 0079 sobre los informes, un piso más abajo: si el histórico
-- se recalcula al leerlo, la fila de julio se convierte en septiembre con el
-- título de julio, y nadie puede notarlo porque las dos versiones parecen
-- correctas. Una meta cuya historia se mueve no es una meta: es una consulta
-- con nombre bonito.
--
-- Así que cada lectura guarda su Figure entero —`value`, `display`, `unit`,
-- `source_id` y `method`, la misma forma que `figureSchema` en
-- packages/agent-tools/src/reports/document.ts—, y `method` es la frase que
-- dice cómo se hizo la aritmética, que es lo que alguien necesita para
-- rehacerla a mano meses después. Guarda además `target_value` y `direction`
-- COPIADOS de la meta en ese momento: si mañana alguien baja el objetivo de 45
-- a 40 días, la lectura de julio sigue diciendo contra qué se juzgó en julio.
--
-- Y LA CONGELACIÓN ESTÁ EN LA BASE DE DATOS, NO EN UNA COSTUMBRE. Dos cosas:
--
--   `goal_readings_once` (unique sobre goal_id, period_start) hace que el cron
--   sea idempotente por el mismo mecanismo de siempre — el segundo INSERT lo
--   rechaza Postgres, no un `if (!exists)` esperanzado que dos ejecuciones
--   simultáneas ganan siempre.
--
--   A `goal_readings` NO SE LE CONCEDE UPDATE. Ni a service_role. Una lectura
--   escrita no se corrige: se corrige la meta hacia adelante, o se borra la
--   fila entera y se ve en el diff. Un `grant` que falta es más difícil de
--   deshacer por accidente que un comentario que pide que no se haga.
--
-- ===========================================================================
-- LO QUE DELIBERADAMENTE NO HAY
-- ===========================================================================
-- No hay pronóstico, ni tendencia, ni «en riesgo». Un cruce de umbral es
-- verificable: el número estuvo de este lado o del otro, y la fila lo dice con
-- su método al lado. Una predicción no lo es, y una predicción equivocada no se
-- equivoca sola — desacredita los umbrales correctos que están a su lado, que
-- son justamente los que sí funcionaban. `status` tiene tres valores y ninguno
-- mira hacia adelante: `met`, `breached` y `unmeasurable`.
--
-- `unmeasurable` importa tanto como los otros dos. Un período en el que no
-- había nada que medir NO es un incumplimiento y no manda ningún correo; es un
-- hueco, y decir «no lo sé» es la única respuesta que no enseña a desconfiar
-- del resto de la columna.
--
-- ===========================================================================
-- LOS AVISOS, Y POR QUÉ SON DOS CLASES
-- ===========================================================================
-- `goal_notices` tiene `breached` y `recovered`, con índice único por (meta,
-- período, clase). El aviso de incumplimiento es evidente. El de recuperación
-- es el que convierte esto en un gerente y no en una alarma: alguien que sólo
-- avisa cuando algo se rompe entrena a la gente a temer sus correos; alguien
-- que además dice «esto ya volvió a su sitio» cierra el lazo. Cuesta una fila y
-- una clase más en un CHECK.
--
-- El índice único es el de `commitment_notices_once_idx` (0069) palabra por
-- palabra: la claim decide «¿ya dijimos esto?», y la decide la base de datos.
-- Correr el cron diez veces manda un correo.
--
-- ===========================================================================
-- UNA SOLA PUERTA DE ESCRITURA POR TABLA
-- ===========================================================================
--   public.goals          se escribe SÓLO desde `writeGoal()`
--                         (`archiveGoal()` no inserta nada: sólo pone
--                          state='archived' con el nombre de quien la retiró)
--   public.goal_readings  se escribe SÓLO desde `recordGoalReading()`
--                         (y nadie la actualiza: no se concede UPDATE)
--   public.goal_notices   se escribe SÓLO desde `claimGoalNotice()`
--                         (`settleGoalNotice()` únicamente cierra la fila que
--                          esa claim acaba de crear, y no inserta ninguna)
--
-- Las tres en packages/agent-tools/src/goals/store.ts. Cualquier otra ruta a
-- estas tablas es un error de revisión.
--
-- LA LECCIÓN CARA QUE ESTO EVITA: la 0064 añadió una columna NOT NULL y no tocó
-- la función que escribía en esa tabla. Durante semanas no se guardó ni una
-- memoria y nadie se enteró, porque la LECTURA seguía funcionando. Con una sola
-- puerta por tabla, «¿quién más escribe aquí?» tiene una respuesta y no una
-- búsqueda.
--
-- ===========================================================================
-- TENANCY
-- ===========================================================================
-- `organization_id` NOT NULL en las tres desde la primera línea, las tres
-- registradas como `tenant()` en packages/agent-tools/src/tenancy/tables.ts EN
-- ESTE MISMO COMMIT —el cliente con alcance rechaza una tabla sin clasificar, y
-- la primera consulta fallaría en desarrollo—, y RLS deny-all + service_role
-- igual que la 0069, la 0076 y la 0098.
--
-- Idempotente de principio a fin.

-- ===========================================================================
-- 1. La meta que alguien fijó
-- ===========================================================================

create table if not exists public.goals (
  id              uuid        primary key default gen_random_uuid(),
  organization_id text        not null references public.ba_organization(id) on delete cascade,

  -- QUÉ SE MIDE. Slug de METRIC_CATALOG (goals/catalog.ts). El CHECK es de
  -- forma y no de valor, a propósito: ver la cabecera. Lo que impide que aquí
  -- entre una métrica inventada no es este patrón, es que `writeGoal()` la
  -- busca en el registro y además exige que su `available(db)` diga que sí en
  -- ESTE espacio de trabajo.
  metric_key      text        not null check (metric_key ~ '^[a-z][a-z0-9_]{2,39}$'),

  -- Cómo la llama quien la fijó. Se copia de la métrica y se puede reescribir:
  -- «cartera a 45 días» dice más en una lista que «Días de cartera».
  label           text        not null check (length(btrim(label)) between 3 and 120),

  -- Cada cuánto se congela una lectura. Dos, y no más: una meta que se lee a
  -- diario es un panel, y un panel no es una meta.
  cadence         text        not null check (cadence in ('week','month')),

  -- EL NÚMERO. 45 días, 95 por ciento, 0 acciones sin respuesta.
  target_value    numeric(14,4) not null,
  -- Se copian del catálogo al crear la meta para que la fila sea legible sin
  -- cargar TypeScript, y para que cada lectura pueda congelarlas.
  direction       text        not null check (direction in ('lower_is_better','higher_is_better')),
  unit            text        not null check (unit in ('percent','days','count')),

  -- Activa o retirada. Nunca se borra: sus lecturas son historia, y una meta
  -- borrada dejaría un histórico sin la declaración que lo explicaba.
  state           text        not null default 'active' check (state in ('active','archived')),

  -- QUIÉN LA FIJÓ. NOT NULL, y es la mitad del punto de esta tabla: una meta es
  -- una declaración, y una declaración sin autor es exactamente lo que no puede
  -- existir. «Alguien decidió que 45» y «el sistema dice 45» son cosas
  -- distintas, y sólo la primera se puede discutir en una reunión.
  --
  -- `on delete cascade` como `actions.user_id` (0077), que es el otro NOT NULL
  -- a una persona en este esquema: es la única forma de que la columna siga
  -- siendo NOT NULL sin bloquear la baja de alguien.
  created_by      uuid        not null references public.users(id) on delete cascade,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  archived_at     timestamptz,
  archived_by     uuid        references public.users(id) on delete set null,

  -- Retirar una meta es un acto de una persona, con su nombre, igual que
  -- resolver una disputa de pago (0098) o confirmar una lectura (0076).
  constraint goals_archived_needs_human check (
    state <> 'archived' or (archived_at is not null and archived_by is not null)
  )
);

-- Una misma métrica con la misma cadencia dos veces activa serían dos cifras
-- distintas para la misma pregunta, y quien las lea creerá que una de las dos
-- está mal. Parcial sobre las activas: retirar una y fijar otra es lo normal.
create unique index if not exists goals_active_metric_idx
  on public.goals (organization_id, metric_key, cadence)
  where state = 'active';

create index if not exists goals_org_state_idx
  on public.goals (organization_id, state, created_at desc);

comment on table public.goals is
  'La cifra que alguien de la empresa fijó y contra la que se compara la realidad. metric_key sale de METRIC_CATALOG en packages/agent-tools/src/goals/catalog.ts, un registro cerrado en TypeScript donde cada métrica declara un predicado available(db): una métrica que este espacio de trabajo no puede calcular hoy no se puede elegir, porque una meta sin datos que la alimenten resta más confianza de la que suma. Se escribe únicamente desde writeGoal().';

comment on column public.goals.metric_key is
  'Slug del catálogo (goals/catalog.ts). El CHECK es de forma y no de valor a propósito, igual que document_extractions.doc_type: añadir una métrica debe ser un objeto más en esa lista y no una migración. Lo que impide una métrica inventada es writeGoal(), que la busca en el registro y exige que su available(db) diga que sí en este espacio.';

comment on column public.goals.created_by is
  'Quién fijó la meta. NOT NULL: una meta es una declaración, y una declaración sin autor no se puede discutir con nadie. La diferencia entre «alguien decidió que 45 días» y «el sistema dice 45 días» es toda la diferencia.';

comment on column public.goals.direction is
  'lower_is_better para cartera o backlog, higher_is_better para cumplimiento. Se copia del catálogo, y cada lectura la vuelve a copiar: si alguien cambia el objetivo mañana, la lectura de julio sigue diciendo contra qué se juzgó en julio.';

-- ===========================================================================
-- 2. La lectura de un período, congelada
-- ===========================================================================
-- Una fila por meta y por período CERRADO. Sólo se escribe cuando el período ya
-- terminó: una lectura de un período en curso cambiaría cada mañana, que es
-- justo el marcador que esta tabla existe para no ser.
--
-- No hay backfill, y la ausencia es deliberada. Rellenar hacia atrás sería
-- calcular hoy, con los datos de hoy, un número que se presentaría como el de
-- marzo — la fotografía volvería a ser un marcador, sólo que con fecha vieja.
-- Una meta empieza a tener historia el primer período que cierra después de
-- fijarla, y la primera fila lo dice sola.

create table if not exists public.goal_readings (
  id              uuid        primary key default gen_random_uuid(),
  organization_id text        not null references public.ba_organization(id) on delete cascade,
  goal_id         uuid        not null references public.goals(id) on delete cascade,

  -- El período, en días de calendario colombianos. Fecha y no instante por la
  -- razón de la 0069: «este mes» tiene que significar este mes AQUÍ.
  period_start    date        not null,
  period_end      date        not null,

  -- EL FIGURE, ENTERO Y CONGELADO. Misma forma que figureSchema en
  -- packages/agent-tools/src/reports/document.ts.
  --   value      El número sin formato, para ordenar y dibujar. Nulo sólo
  --              cuando no hubo nada que medir; ver el CHECK de más abajo.
  --   display    Ya formateado para Colombia. Formatear al leer significaría
  --              que la fila puede cambiar de cifra el día que cambie una regla
  --              de locale, que es exactamente la deriva que esto evita.
  --   source_id  De qué lectura del sistema salió.
  --   method     La aritmética en una frase, para rehacerla a mano.
  value           numeric(14,4),
  display         text        not null check (length(btrim(display)) between 1 and 60),
  unit            text        not null check (unit in ('percent','days','count')),
  source_id       text        not null check (length(btrim(source_id)) between 1 and 60),
  method          text        not null check (length(btrim(method)) between 12 and 600),

  -- CONTRA QUÉ SE JUZGÓ, copiado de la meta en el momento de la lectura.
  target_value    numeric(14,4) not null,
  direction       text        not null check (direction in ('lower_is_better','higher_is_better')),

  -- Sobre cuántas filas está hecha la cifra. La honestidad de la 0098:
  -- «cumplimiento del 100%» sobre dos compromisos no es la misma frase que
  -- sobre doscientos, y quien la lea tiene derecho a saber cuál está leyendo.
  sample_size     int         not null default 0 check (sample_size >= 0),

  -- Tres, y ninguno mira hacia adelante. Ver la cabecera.
  status          text        not null check (status in ('met','breached','unmeasurable')),

  computed_at     timestamptz not null default now(),

  constraint goal_readings_period_ordered check (period_end >= period_start),

  -- «No se pudo medir» y «se midió y dio cero» son cosas opuestas, y la fila
  -- tiene que distinguirlas o la columna entera deja de significar algo.
  constraint goal_readings_value_matches_status check (
    (status = 'unmeasurable' and value is null)
    or (status <> 'unmeasurable' and value is not null)
  ),

  -- EL ÍNDICE QUE HACE EL CRON IDEMPOTENTE. El segundo INSERT del mismo período
  -- lo rechaza Postgres. Ver la cabecera.
  constraint goal_readings_once unique (goal_id, period_start)
);

create index if not exists goal_readings_org_goal_idx
  on public.goal_readings (organization_id, goal_id, period_start desc);

-- La columna que la pantalla enseña primero: lo que se rompió, lo más reciente
-- arriba.
create index if not exists goal_readings_org_breached_idx
  on public.goal_readings (organization_id, period_start desc)
  where status = 'breached';

comment on table public.goal_readings is
  'Una fila por meta y por período cerrado, CONGELADA. Guarda el Figure entero (value, display, unit, source_id, method) más el objetivo y la dirección copiados del momento, para que el histórico no se mueva cuando alguien cambie la meta. No se le concede UPDATE ni a service_role: una lectura escrita no se corrige. Se escribe únicamente desde recordGoalReading().';

comment on column public.goal_readings.method is
  'Cómo se hizo la aritmética, en una frase en español. Es lo que alguien necesita meses después para rehacer el número a mano y decidir si se lo cree. Un número sin esta frase es una afirmación, no una medición.';

comment on column public.goal_readings.target_value is
  'El objetivo CONTRA EL QUE SE JUZGÓ ESTE PERÍODO, copiado de la meta al escribir la fila. Si mañana alguien baja el objetivo de 45 a 40 días, julio sigue diciendo que se juzgó contra 45 — que es lo que pasó.';

comment on column public.goal_readings.status is
  'met, breached o unmeasurable. Ninguno mira hacia adelante: un cruce de umbral es verificable y una predicción no, y una predicción equivocada desacredita los umbrales correctos que tiene al lado. unmeasurable es un período sin nada que medir: no es un incumplimiento y no manda ningún correo.';

-- ===========================================================================
-- 3. Cuándo se dijo, y cuándo se dijo que ya estaba arreglado
-- ===========================================================================

create table if not exists public.goal_notices (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  goal_id           uuid        not null references public.goals(id) on delete cascade,
  -- La lectura que lo motivó. `set null` porque el aviso ya salió y sigue
  -- siendo cierto que salió aunque la fila que lo motivó desaparezca.
  reading_id        uuid        references public.goal_readings(id) on delete set null,

  -- El período del que se habla. Parte de la clave: un mes distinto merece su
  -- propio aviso, igual que un vencimiento reprogramado en la 0069.
  period_start      date        not null,

  -- DOS CLASES, Y LA SEGUNDA ES LA QUE HACE DE ESTO UN GERENTE. Ver la
  -- cabecera.
  notice_class      text        not null check (notice_class in ('breached','recovered')),

  -- El día en Bogotá en que salió. Reporte, no identidad.
  sent_on           date        not null,

  channel           text        not null default 'email' check (channel in ('email','none')),
  recipient_user_id uuid        references public.users(id) on delete set null,
  recipient_email   text        check (length(recipient_email) <= 320),

  -- El resultado, separado de la claim: un aviso reclamado cuyo envío falló se
  -- queda en false y lo reintenta el día siguiente. La fila no se vuelve a
  -- crear, sólo se repite el intento — como máximo un mensaje, como mínimo un
  -- intento, que es el orden correcto (0069).
  delivered         boolean     not null default false,
  note              text        check (length(note) <= 500),
  settled_at        timestamptz,
  created_at        timestamptz not null default now()
);

-- «¿Ya dijimos esto?» lo decide la base de datos, no el cron.
create unique index if not exists goal_notices_once_idx
  on public.goal_notices (goal_id, period_start, notice_class);

create index if not exists goal_notices_org_recent_idx
  on public.goal_notices (organization_id, created_at desc);

comment on table public.goal_notices is
  'El registro de haberlo dicho. Dos clases: breached cuando el período cerró del lado malo del umbral, y recovered cuando el siguiente volvió a cumplir. La segunda es lo que separa a un gerente de una alarma — quien sólo avisa cuando algo se rompe enseña a temer sus correos. El índice único por (meta, período, clase) es lo que hace que correr el cron diez veces mande un correo. Se escribe únicamente desde claimGoalNotice().';

-- ===========================================================================
-- 4. Acceso
-- ===========================================================================
-- Deny-all + service_role, igual que la 0069, la 0076 y la 0098. La frontera de
-- inquilino es createOrgScopedClient, no una política contra auth.uid().
--
-- LA EXCEPCIÓN QUE VALE LA PENA LEER: goal_readings NO RECIBE UPDATE. Es la
-- congelación, puesta donde no se puede deshacer distraídamente. Un `alter` que
-- conceda UPDATE aquí es una decisión que se ve en un diff; un `db.update()`
-- añadido a un archivo de servicio no se ve en ninguno.

alter table public.goals         enable row level security;
alter table public.goal_readings enable row level security;
alter table public.goal_notices  enable row level security;

revoke all on table public.goals         from public, anon, authenticated;
revoke all on table public.goal_readings from public, anon, authenticated;
revoke all on table public.goal_notices  from public, anon, authenticated;

grant select, insert, update, delete on table public.goals         to service_role;
grant select, insert,         delete on table public.goal_readings to service_role;
grant select, insert, update, delete on table public.goal_notices  to service_role;

-- Y AQUÍ VA EL REVOKE QUE DE VERDAD CONGELA LA TABLA.
--
-- Sin esta línea la anterior no hace nada: Supabase deja puesto un
-- `alter default privileges in schema public grant all on tables to
-- service_role`, así que toda tabla nueva NACE con UPDATE concedido y un
-- `grant` que simplemente omite el verbo no se lo quita. Conceder de menos no
-- es revocar — es exactamente la clase de garantía que se lee bien en el diff,
-- pasa la revisión, y no está.
--
-- Comprobado contra la base local: sin esto, `set role service_role; update
-- public.goal_readings ...` devuelve UPDATE 1.
revoke update on table public.goal_readings from service_role;
