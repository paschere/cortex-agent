# Apps con código

Un segundo motor de aplicaciones, al lado del de bloques, para lo que los bloques no alcanzan:
interfaz libre, lógica en servidor, paquetes npm y base de datos propia. Lo escribe Cortex desde
el chat y lo puede editar un desarrollador; Cortex respeta lo que el desarrollador cambió.

Decisiones del dueño (2026-11-04): escriben Cortex y desarrolladores; las cuatro capacidades
(pantallas a la medida, lógica en servidor, paquetes externos, base propia); convive y comparte
con las apps actuales; se estrena con Operación de carga.

## Principio: misma app, otro tipo de pantalla

No es una plataforma aparte. Una app (`custom_apps`) puede mezclar pantallas de bloques y
pantallas con código. Comparten usuarios, roles, permisos (`apps/permissions.ts`), tablas
(`trackers`), reglas, avisos y finanzas. El código nunca habla con la base directamente: pasa por
el SDK, y el servidor aplica el rol del usuario igual que hoy.

## Piezas

| Pieza | Qué es | Dónde corre |
|---|---|---|
| **Pantalla con código** | React + TypeScript. Se compila a un bundle por versión. | iframe `sandbox="allow-scripts"` sin `allow-same-origin` (origen nulo): no ve cookies ni la sesión de Cortex. CSP estricta. |
| **SDK `@cortex/app-sdk`** | `tables.query/insert/update`, `files.upload`, `user`, `ai.ask`, `functions.call`, `notify`, `location`, `camera`, `navigate`. | En la pantalla, por `postMessage` al host; el host llama a la API con la sesión y el rol. |
| **Funciones de servidor** | TypeScript con npm. Disparadas por la pantalla, por una regla (`run_function`), por horario o por webhook. | Vercel Sandbox (ya lo usamos en dev-tasks): tiempo y memoria con tope, salida a internet por lista, secretos del cofre de custom-tools, token corto y con alcance para llamar al SDK. |
| **Paquetes npm** | Declarados en el `package.json` de la app; se instalan y empaquetan al compilar. | Compilación en Sandbox; el navegador solo recibe el bundle. |
| **Base propia** | Un esquema Postgres por app (`app_<id>`) con un rol que solo ve ese esquema; migraciones SQL versionadas. | La misma Postgres de Railway. Acceso desde funciones (y desde la pantalla solo vía funciones). |
| **Código y versiones** | Archivos de la app en `custom_app_files` con versiones; borrador → vista previa → publicar → volver atrás. | Base de Cortex; sincronización opcional con un repo de GitHub para los desarrolladores. |
| **Cortex programando** | El agente de dev-tasks (coder en Sandbox) escribe, compila, revisa tipos y prueba antes de dejar el borrador. | Vercel Sandbox. |

## Fases

1. **Pantallas con código + SDK de tablas.** Compilar, servir aislado, permisos del rol, versiones,
   vista previa y publicar; Cortex la escribe desde el chat. Estreno: «Torre de control» de
   Operación de carga (mapa en vivo de operarios y geocercas, vuelos por llegar con su ETA y
   posición, atenciones abiertas y alertas, todo en una pantalla).
2. **Funciones de servidor + npm + secretos.** Acción de regla `run_function`, horarios y webhooks.
3. **Base de datos propia por app.** Esquema, rol limitado, migraciones, cuotas.
4. **Desarrolladores.** Editor en Cortex y sincronización con GitHub (o CLI `cortex apps pull/push`);
   Cortex lee el diff del desarrollador antes de tocar el archivo.

## Riesgos

- **Seguridad:** código de terceros dentro de Cortex. Mitigación: origen nulo, CSP, todo pasa por
  el SDK con el rol, nada de secretos en el navegador, auditoría de cada llamada, cuotas por app.
- **Costo y latencia de funciones:** Sandbox arranca en segundos; para llamadas frecuentes se
  evalúa un runtime de aislados más adelante.
- **Mantenimiento:** el código de una app puede romperse con un cambio del SDK. El SDK se versiona
  y cada app fija su versión.

---

## Contrato técnico (fase 1, base para las demás)

### Un proyecto de código por app

Una app tiene como máximo UN proyecto de código (`custom_app_code`, `app_id` único). Sus archivos:

```
package.json            dependencias npm (fase 2: cualquier paquete del registro; scripts de instalación desactivados)
screens/<slug>.tsx      una pantalla: `export default function Screen() {…}`
lib/**/*.ts(x)          código compartido
server/<nombre>.ts      función de servidor (fase 2): `export default async function (input, ctx) {…}`
db/migrations/NNNN_*.sql migraciones de la base propia (fase 3)
```

Límites: 200 archivos, 512 KB por archivo, 4 MB en total. Rutas `^[a-zA-Z0-9_./-]+$`, sin `..`.

### Datos (migración `0243_custom_app_code.sql`)

- `custom_app_code`: `id, organization_id, app_id (unique, fk cascade), files jsonb {ruta: contenido} (borrador), sdk_version text default '1', published_build_id uuid null, updated_by, updated_at, created_at`.
- `custom_app_code_builds`: `id, organization_id, code_id (fk cascade), number int (1,2,3… por proyecto), files jsonb (copia exacta de lo compilado), bundles jsonb {screenSlug: {js, css}}, status 'ok'|'error', log text, created_by, created_at`. Se guardan las últimas 30; la publicada nunca se borra.
- `custom_app_screens`: `kind text not null default 'view' check (kind in ('view','code'))`, `code_entry text null` (p.ej. `screens/torre.tsx`). Una pantalla `code` sigue teniendo su `view_id` (vista mínima de relleno), así roles, orden, ícono y menú no cambian.
- `tenant()` en `tenancy/tables.ts`, RLS solo `service_role`, como 0208.

### Compilar

`buildAppCode(db, appId, actor)` en `packages/agent-tools/src/apps/code/build.ts` recibe un `Builder` inyectable:
`interface Builder { build(input: { files: Record<string,string>; entries: Record<string,string> /* slug → ruta */; sdkSource: string }): Promise<{ ok: boolean; bundles: Record<string,{js:string;css:string}>; log: string }> }`.
La implementación real (`apps/web/lib/apps/code-builder.ts`) usa Vercel Sandbox: escribe los archivos, pone `node_modules/@cortex/app-sdk` desde `sdkSource`, `npm install` (fase 1: solo lo permitido), `esbuild` por pantalla a IIFE `format:'iife', jsx:'automatic', minify`, con `react`/`react-dom` empaquetados. Errores de esbuild → `status:'error'` y el log legible.
Cada compilación crea una fila en `custom_app_code_builds`. `publishAppCode(db, appId, buildId)` fija `published_build_id` (solo builds `ok`).

### Servir la pantalla

`GET /api/apps/[id]/code/[screen]/frame?build=<id>` devuelve HTML con el bundle en línea y la cabecera
`Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src https: data: blob:; connect-src 'none'`.
Sin `build` sirve la publicada; `build=<id>` (vista previa) solo para admin. El rol se revisa igual que una pantalla (`openScreenForApi`).
El iframe del host: `<iframe sandbox="allow-scripts allow-forms allow-popups allow-downloads" src=…>`. Origen nulo: no ve cookies ni el DOM de Cortex.

### El puente (SDK)

Mensajes `postMessage` iframe ↔ host, `{ cortex: 1, id, op, args }` → `{ cortex: 1, id, ok, data | error }`. El host solo acepta mensajes cuyo `event.source` es su iframe y reenvía a
`POST /api/apps/[id]/code/[screen]/sdk` `{ op, args }`. TODO permiso se decide en el servidor con el rol del usuario (`apps/permissions.ts`); el navegador no decide nada.

Operaciones fase 1 (`packages/agent-tools/src/apps/code/sdk.ts`, `runSdkOp(db, access, op, args)`):

| op | args | Regla |
|---|---|---|
| `user.me` | – | `{id, name, role, attributes}` |
| `tables.list` | – | tablas que el rol lee, con campos (key, label, type, options) |
| `tables.query` | `{table, where?: {campo: valor}, search?, order?: {field, dir}, limit≤500, offset}` | `rowAccessFor` + `applyRowScope`; filas `{id, label, values, created_at, updated_at}` |
| `tables.get` | `{table, id}` | igual |
| `tables.insert` | `{table, values}` | `canCreateIn` + `writableFieldsFor`; `prepareValues`; emite `row_created` |
| `tables.update` | `{table, id, values}` | `editAccessFor`/`canEditRow` + campos; emite `row_updated` |
| `locations.live` | – | solo `canViewLocations`; última ubicación por persona |
| `geofences.list` | – | zonas de la app |
| `ai.ask` | `{prompt, data?}` | modelo rápido, medidor `answers`, tope por minuto; texto |
| `functions.call` | `{name, input}` | fase 2 |
| `db.query` | `{sql, params}` | fase 3: base propia de la app, ver «Fase 3» |

Navegación y avisos son del host (no van al servidor): `nav.go({screen, prefill})`, `ui.toast(text)`.
Tope: 120 llamadas por minuto por usuario y pantalla. Cada escritura queda en auditoría como una edición de app.

### `@cortex/app-sdk` (`packages/app-sdk`)

Sin dependencias; el bundle de la pantalla lo incluye. Exporta `cortex` (las ops como promesas: `cortex.tables.query(...)`, `cortex.user.me()`…) y hooks React: `useUser()`, `useQuery(table, opts, {refreshMs})` → `{rows, loading, error, refresh}`, `useLocations({refreshMs})`. Versionado: la app fija `sdk_version`.

### Cortex programando

Herramientas del chat (`packages/agent-tools/src/apps/code/tools.ts`): `apps.code_read` (archivos y última compilación), `apps.code_write` (escribe/borra archivos del borrador), `apps.code_build` (compila y devuelve el log), `apps.code_add_screen` (pantalla `code` con su entrada), `apps.code_publish` (con confirmación). El modelo itera escribir → compilar → leer errores. Solo owner/admin.

---

## Fase 2: funciones de servidor, npm y secretos (migración `0244_custom_app_code_functions.sql`)

### Funciones

`server/<nombre>.ts` (`^[a-z][a-z0-9_]{1,47}$`) con `export default async function (input, ctx) { return resultado }`.
`ctx = { user: {id,name,role,attributes}|null, cortex, secrets: Record<string,string>, log(...args) }`.
`ctx.cortex` es el mismo SDK de las pantallas, del lado servidor: `tables.list/query/get/insert/update`, `locations.live`,
`geofences.list`, `ai.ask`, `user.me`. NO tiene `functions.call` (una función no llama a otra: sin recursión).

### Compilar

`Builder.build` recibe además `functions: {nombre → ruta}` y devuelve `functions: {nombre → js}`. En el mismo Sandbox
(un solo `npm install`), esbuild empaqueta cada función con `platform:'node', target:'node22', format:'cjs',
bundle:true` y el sourcemap en línea (los errores salen con la línea del `.ts`). Va a la columna nueva
`custom_app_code_builds.functions jsonb` ({nombre: js}); `bundles` queda solo con pantallas. Tope: 6 MB por función
empaquetada, 700 MB de `node_modules`, 60 paquetes declarados, 150 s de instalación. Ya no hay lista permitida:
cualquier paquete del registro sirve; instalar es con `--ignore-scripts` (nada corre al instalar). Lo único que se
rechaza con motivo: versiones `file:`/`link:`/`workspace:`/`portal:` (apuntan al disco del sandbox, no existen
fuera de él). Paquetes con binarios nativos (`.node`) fallan al empaquetar con el error de esbuild en el log.
Un proyecto puede tener solo funciones (sin pantallas con código).

### Correr (`runAppFunction`, `code/run-function.ts`)

Una sola puerta para pantalla, regla, horario, webhook y chat. Corre la compilación PUBLICADA (o, para probar,
`build:'latest'` = la última que salió bien). Un sandbox tibio por app y compilación
(`cortex-fn-<app>-<build8>`, `Sandbox.getOrCreate`, no persistente, 3 min + 2 min por uso): la primera llamada escribe
el runner y las funciones; las siguientes solo pagan el arranque de `node`. Cada llamada escribe
`jobs/<id>.json` (entrada, secretos, token), corre `node runner.cjs` (tope 60 s, SIGKILL) y lee `jobs/<id>.out.json`
(resultado ≤ 1 MB, log capturado de `console.*`). El runner borra el archivo del trabajo apenas lo lee. Si el sandbox
tibio murió se reintenta una vez con uno nuevo. Salida a internet: todo permitido MENOS redes privadas, link-local y
metadata (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10); el sandbox no recibe ninguna llave de Cortex.
Riesgo que queda: una función puede mandar a internet lo que su rol lee (por eso los roles de reglas/webhooks son
explícitos y mínimos). Siguiente paso posible: lista de dominios por app en `networkPolicy.allow`.

### Volver a llamar a Cortex

Token HMAC de 5 minutos (`mintFnToken`, llave derivada de `JOBS_SECRET` con la etiqueta `cortex.app-fn-sdk.v1`) con
`{org, app, actor{kind,id,name}, role, attributes, screen?, readOnly, fn, exp}`. `POST /api/apps/code/fn-sdk` (pública en
el middleware, sin cookie) lo verifica, reconstruye el `AppAccess` con los permisos del rol LEÍDOS DE LA BASE en ese
momento (`accessFromClaims`) y llama `runSdkOp(..., {via:'function'})`: los permisos son los del que disparó la
función. Tope de `ctx.cortex`: 600 llamadas/min por app y usuario (la pantalla tiene 120). «Ver como…» propaga
`readOnly`: la función corre, sus escrituras se rechazan. Una pantalla llama `cortex.functions.call(name, input)`
(30/min por usuario); el error de la función vuelve como mensaje al usuario.

### Disparadores

- **Pantalla**: op `functions.call`. Rol: el de quien la usa.
- **Regla / horario**: acción de automatización `run_function {name, role, input:{clave: "texto con {{campos}}"}, withRow?}`.
  `role` es OBLIGATORIO y no puede ser `administrador`: la función corre con ese rol de la app, a nombre de quien creó
  la regla (para que las filas que escriba tengan autor). Con un horario no hay fila (`withRow` no aplica). La validación
  exige que el rol exista y que `server/<name>.ts` exista en el borrador. Un error de la función hace fallar la acción
  (queda en el historial de la regla). Un rol con alcance por atributo («Cliente = el suyo») no sirve aquí: no hay persona.
- **Webhook**: `POST /api/apps/<app>/code/hooks/<función>` con `Authorization: Bearer cxh_…` (o `X-Cortex-Token`). Un
  webhook por función (`custom_app_code_hooks`: rol, hash del token, autor; crear de nuevo ROTA el token). La función
  recibe `{ body, headers (sin credenciales), query }`. 60/min por webhook. Mismo 404 para inexistente/token malo/app sin publicar.
- **Chat**: `apps.code_run` (probar con una entrada; por omisión la última compilación buena, como administrador o como
  un rol dado) y `apps.code_runs` (últimas corridas). Solo owner/admin.

### Secretos y registro

`custom_app_code_secrets` (`^[A-Z][A-Z0-9_]{1,63}$`, ≤ 50 por app, ≤ 8 KB): valor cifrado con `encryptToken`
(`TOKEN_ENCRYPTION_KEY`, el mismo cifrado que custom-tools). La lista solo devuelve nombre y fecha; el valor solo se
inyecta en `ctx.secrets`. `custom_app_code_runs`: función, disparador, actor, rol, nº de compilación, ok/error/timeout,
duración, log (≤ 20 KB) y error; se poda a las últimas 500 por app.

### Server actions (`apps/web/lib/apps/code-actions.ts`)

`listSecrets(appRef)`, `setSecret(appRef, name, value|null)`, `listRuns(appRef, {limit?, function?})`,
`runFunction(appRef, name, input, {role?, published?})`, `listWebhooks(appRef)`, `createWebhook(appRef, {name, role})`,
`deleteWebhook(appRef, name)`; `CodeSnapshot.functions: string[]`.

### Pendientes / riesgos

- Un `tables.insert/update` hecho por una función dispara las reglas de la tabla como cualquier escritura. La cadena
  anti-bucle de automatizaciones SÍ cruza el HTTP de vuelta desde la fase 3 (ver «Cadena anti-bucle» abajo).
- El sandbox tibio es por app: dos usuarios de la misma app comparten VM (cada llamada tiene su archivo y su token).
- No probado contra el Sandbox real (sin credenciales locales): el runner, `getOrCreate`, la política de red y el
  `extendTimeout` están escritos según los tipos de `@vercel/sandbox` 2.9.

---

## Fase 3: base de datos propia por app (migración `0246_custom_app_db.sql`)

### Cadena anti-bucle a través del HTTP de vuelta (arreglo de la fase 2)

`FnTokenClaims` lleva ahora `chain: string[]` y `depth` (firmados en el mismo HMAC). `runAppFunction` los toma de
`withAutomationOrigin` en curso (una regla que corre `run_function` no hace nada especial) o de `opts.automation`. La ruta
`/api/apps/code/fn-sdk` envuelve `runSdkOp` en `withAutomationOrigin({chain, depth})`, así que un `tables.insert/update` de la
función emite el evento con la cadena de la regla: `mayFire` descarta a la regla que ya está en la cadena y todo lo que pase de
`AUTOMATION_MAX_DEPTH` (3). Una regla que llama a una función que escribe en su propia tabla ya no hace bucle. Pantalla,
webhook y chat no llevan cadena (`[]`, 0).

### Diseño

- **Esquema + rol por app**: `app_<12 primeros hex del id>`; el rol del mismo nombre (LOGIN, sin superusuario, sin
  CREATEDB/CREATEROLE, `CONNECTION LIMIT 6`) POSEE el esquema y no tiene nada más. Los crea Cortex la primera vez que corren
  las migraciones de la app (no la migración 0246: ésta solo crea el registro `custom_app_db` y `custom_app_db_migrations`).
- **El código no recibe credenciales.** Pide `db.query` por el SDK y es el servidor de Cortex quien abre la conexión.
- **Se conecta COMO el rol de la app, no con `SET LOCAL ROLE`.** Probado: si la sesión empieza como el superusuario de
  Cortex, el SQL de la app puede escribir `RESET ROLE`/`SET ROLE postgres` y salir de su esquema; con un rol intermedio
  miembro de todos, podría saltar a la app de al lado. La contraseña del rol se DERIVA (HMAC de `JOBS_SECRET`, etiqueta
  `cortex.app-db.v1`; no se guarda). Si cambia `JOBS_SECRET` o la app se cambia su contraseña, el motor la restablece solo
  al ver `28P01`. Un pool corto (2 conexiones, LRU de 24 pools) por rol; `DISCARD ALL` al devolver la conexión, para que
  nada de la sesión (`SET`, tablas temporales) pase a la llamada siguiente.
- **Cada llamada es una transacción** con `SET LOCAL search_path = app_x`, `statement_timeout = 10 s`,
  `idle_in_transaction_session_timeout`. El SQL puede quitarse el `statement_timeout` (es suyo): la defensa real es el
  tope del cliente (10 s + 2 s), que mata el backend con `pg_terminate_backend` desde la conexión de administración.
- **Una sentencia por llamada** (`assertSingleStatement` entiende comentarios, textos, `E'..'`, identificadores y `$$`).
  Parámetros `$1…` (≤ 100, ≤ 256 KB cada uno). Resultado: ≤ 1000 filas y ≤ 2 MB (las consultas se leen con un cursor
  `FETCH 1001`, no se carga todo en memoria); `truncated: true` si se recortó.
- **Quién llama**: desde una función de servidor (`ctx.db.query(sql, params)` o `ctx.cortex.db.query`), lee y escribe;
  con «Ver como…» solo lee. Desde una pantalla solo si el `package.json` trae `"cortex": {"dbFromScreens": true}` y
  entonces SOLO `SELECT` (guarda de sintaxis + transacción `READ ONLY`). Tope: 300 llamadas/min por app y persona.
- **La base de la app es de la app, NO del rol del usuario.** A diferencia de las tablas (`trackers`), donde el servidor
  aplica el rol de quien pregunta, aquí no hay filtro por persona: una función que lee una tabla propia lee todo lo que
  hay en ella. La función debe revisar `ctx.user.role` / `ctx.user.attributes` antes de devolver o cambiar datos (la
  gramática de `apps.code_*` lo dice). Con `dbFromScreens` cualquier persona que abra esa pantalla puede leer cualquier
  tabla del esquema: úsese solo para datos que todos los roles de la pantalla pueden ver.
- **Cuota**: 500 MB por esquema (`sum(pg_total_relation_size)` de tablas y vistas materializadas; recordado 30 s). Se mira
  antes de migrar y antes de cada escritura; con el esquema lleno solo se lee y se borra (`DELETE/TRUNCATE/DROP`).
- **Migraciones**: `db/migrations/NNNN_nombre.sql` (4 dígitos). Orden por número, una vez cada una, cada una en su
  transacción COMO el rol (nombres sin calificar; nada de `public.`), con `pg_advisory_xact_lock` por app. Se anotan en
  `custom_app_db_migrations (org, app_id, name, checksum, applied_at, applied_by)` y, para ser atómicas con su efecto,
  también en `__cortex_migrations` DENTRO del esquema (si Cortex se cae entre el commit y la anotación, la siguiente
  corrida ve la marca, no repite el SQL y solo anota). Un archivo ya aplicado con otro checksum es un error; una nueva con
  número menor que la última aplicada también. Se aplican al PUBLICAR (las del build que se publica; si una falla no se
  publica nada) y con «Aplicar migraciones» / `apps.code_db_migrate` (las del borrador).
- **Borrar la app** (`deleteApp`) borra antes el esquema (`CASCADE`) y el rol. Sin fila en `custom_app_db` no toca Postgres;
  si hay base y el servidor no tiene el motor, o el borrado falla, la eliminación falla (no deja datos huérfanos).

### Piezas

`packages/agent-tools/src/apps/code/`: `app-db.ts` (puro: nombres, contraseña derivada, migraciones, guarda de SQL, cuota,
tope de resultado, interfaz `AppDbDriver`), `app-db-store.ts` (registro, aplicar, estado, `runAppDbQuery`, `dropAppDb`),
`app-db-publish.ts` (`publishAppCodeWithMigrations`); `sdk.ts` (`db.query`); `tools.ts` (`apps.code_db_migrate` con
confirmación, `apps.code_db_query` solo lectura). `apps/web/lib/apps/app-db-driver.ts` (motor `pg`, registrado en
`instrumentation-node.ts`), acciones `dbStatus`/`applyMigrations`/`dbQuery` en `code-actions.ts`, panel «Base de datos» en
`DevPanels.tsx`, `ctx.db.query` en el runner de funciones.

### Lo que el dueño debe hacer UNA vez en producción

La conexión de Cortex es `SUPABASE_DB_URL` (en Railway es el usuario `postgres`, superusuario: puede crear roles y
esquemas). Solo hace falta el ENDURECIMIENTO del esquema `public`, como superusuario (p. ej. `psql "$RAILWAY_DB_URL"`):

```sql
-- Por omisión PUBLIC puede usar el esquema public y ejecutar sus funciones; varias son SECURITY DEFINER de Cortex.
REVOKE USAGE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;   -- ya lo tenían (bootstrap.sql); idempotente
```

Hasta que lo haga, el motor se niega a crear bases propias (el `preflight` lo detecta y devuelve este mismo texto).
Comprobar antes que nada depende de PUBLIC: `select grantee, privilege_type from information_schema.usage_privileges
where object_name = 'public'` y que ningún servicio use un rol distinto de `postgres`/`service_role` sobre `public`
(PostgREST entra como `authenticator` → `service_role`; better-auth, jobs-worker y migraciones como `postgres`).

Si `SUPABASE_DB_URL` NO fuera superusuario: además `ALTER ROLE "<usuario>" CREATEROLE; GRANT CREATE ON DATABASE "<base>" TO "<usuario>";`.
Variables: ninguna nueva (`JOBS_SECRET` ya existe; `SUPABASE_DB_URL` debe ser la conexión DIRECTA o de sesión, no el pooler de
transacciones, porque cada rol de app inicia sesión con su propio usuario).

### Pruebas

`app-db.test.ts` (puro + motor falso + base falsa: migraciones, guarda, cuota, borrado, `db.query`, cadena en el token),
`app-db-driver.test.ts` (unidad + integración contra Postgres real si `APP_DB_TEST_URL` está definido: aislamiento entre
apps y con `public`, `RESET ROLE`/`SET ROLE`, `SET statement_timeout = 0`, READ ONLY, cursor, migración atómica,
autocuración de la contraseña, tamaño, borrado). Se corrió contra `pgvector/pgvector:pg16`:
`APP_DB_TEST_URL=postgresql://postgres:<pw>@localhost:<puerto>/postgres pnpm --filter web exec vitest run lib/apps/app-db-driver.test.ts`.
