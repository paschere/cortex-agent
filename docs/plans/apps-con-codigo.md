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
package.json            dependencias npm (fase 2 las instala; fase 1 solo react/react-dom/@cortex/app-sdk + lista permitida)
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
| `db.query` | `{sql, params}` | fase 3 |

Navegación y avisos son del host (no van al servidor): `nav.go({screen, prefill})`, `ui.toast(text)`.
Tope: 120 llamadas por minuto por usuario y pantalla. Cada escritura queda en auditoría como una edición de app.

### `@cortex/app-sdk` (`packages/app-sdk`)

Sin dependencias; el bundle de la pantalla lo incluye. Exporta `cortex` (las ops como promesas: `cortex.tables.query(...)`, `cortex.user.me()`…) y hooks React: `useUser()`, `useQuery(table, opts, {refreshMs})` → `{rows, loading, error, refresh}`, `useLocations({refreshMs})`. Versionado: la app fija `sdk_version`.

### Cortex programando

Herramientas del chat (`packages/agent-tools/src/apps/code/tools.ts`): `apps.code_read` (archivos y última compilación), `apps.code_write` (escribe/borra archivos del borrador), `apps.code_build` (compila y devuelve el log), `apps.code_add_screen` (pantalla `code` con su entrada), `apps.code_publish` (con confirmación). El modelo itera escribir → compilar → leer errores. Solo owner/admin.
