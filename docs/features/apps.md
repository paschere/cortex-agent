# Aplicaciones

Un conjunto de pantallas con menú y roles, armado sobre las mismas tablas (`trackers`) y vistas que ya usa la empresa. El operario de planta ve «Registrar» y «Mis registros» (sólo sus filas), el supervisor aprueba, gerencia mira el tablero y exporta. Migración `0208_custom_apps.sql`. Plan completo: [docs/plans/aplicaciones.md](../plans/aplicaciones.md).

Estado: **fase 1** (miembros de Cortex con rol) y **fase 2** (usuarios externos con código por correo e instalable, migración `0209_custom_app_users.sql`). Automatizaciones y Web Push son la fase 3.

## Principio: una pantalla ES una vista

No hay un segundo motor. El spec de cada pantalla vive en `custom_views` con `app_id` puesto; `custom_app_screens` sólo dice en qué app está, en qué orden, con qué ícono y qué roles la ven. Se reutilizan `computeView`, `loadViewSources`, `submitViewForm`, `editViewRow`, `runViewAction`, el lienzo `LiveViewCanvas`, el editor de vistas, la cola sin internet, las fotos y el dictado.

Las pantallas NO salen en `/views`, y las rutas, acciones y herramientas de las vistas no las abren: `getView`/`mustGetView` devuelven «no existe» para una vista con `app_id` salvo `{ appScreens: true }`, que sólo usan la capa de apps y el editor de quien administra. Así nadie salta el rol entrando por `/api/views/<id>/data`, exportar, enlace público o acciones de la vista. `setViewAccess` y `archiveView` tampoco las tocan.

## Datos (0208)

| Tabla | Qué guarda |
|---|---|
| `custom_apps` | slug (único por empresa), nombre, ícono, tema, pantalla de inicio, `draft`/`published`. |
| `custom_app_screens` | vista, slug, título, ícono, orden y `roles` (vacío = todos). |
| `custom_app_roles` | clave, nombre y `permissions` (JSON validado en código). |
| `custom_app_members` | miembro de Cortex, su rol y sus atributos (`{cliente: "Andina"}`). |

Todas con `organization_id`, `tenant()` en `tenancy/tables.ts` y RLS sólo para `service_role`.

## Permisos (todo en el servidor)

Las reglas puras viven en `packages/agent-tools/src/apps/permissions.ts` (probadas en `permissions.test.ts`) y se aplican en `apps/store.ts`. Nunca se confía en lo que manda el navegador.

```
{ tables: { "<tabla>": {
    read:  "all" | "own" | { field, equals: "$user.<atributo>" },
    create: bool, edit: "none" | "own" | "all",
    fields?: [campos que puede escribir], actions: [ids de botones, "__approve", "__reject"] } },
  export: bool }
```

- **Negar por defecto:** una tabla que el rol no nombra no se lee (sus bloques salen con aviso).
- **Administrador:** owner/admin de la empresa entra siempre con el rol virtual `administrador` (todo). No se guarda ni se recorta.
- **Pantallas:** el menú trae sólo las del rol; pedir una ajena es 404 (`screenFor` devuelve null).
- **Scope de filas:** `rowScopeFor` arma una entrada por fuente del spec y `loadViewSources(..., { scope })` la aplica AL LEER, antes de `computeView`. Por eso métricas, gráficos, tablas y el Excel salen de las filas permitidas y de ninguna otra. `own` filtra además en la consulta (`tracker_rows.created_by`, ya existente desde la 0115). Las fuentes de sólo lectura (plataforma, Feed) no tienen autor: `own` ahí es «nada».
- **Fuentes:** quien no es admin lee con la barrera del enlace público (`audience: 'public'`): nada del Feed ni fuentes internas o personales. Publicar con una fuente así se rechaza con la lista (`assertAppSources`).
- **Escrituras** (`submitAppForm`, `editAppSubmission`, `editAppRow`, `runAppAction`): validan rol antes de llamar a la escritura de la vista: crear, campos permitidos, own/all, botones y aprobar/rechazar. La fila tiene que ser visible para el rol; si no, «ya no está». Con filtro por atributo, el servidor pone el campo del filtro al crear.
- **Exportar:** `/api/apps/<app>/screens/<pantalla>/export` da 403 si el rol no exporta y usa el mismo scope.
- **Editar la app** (crear, roles, miembros, publicar, pantallas) es sólo de owner/admin (`requireAppAdmin`, `admin()` en `lib/apps/actions.ts`; `saveViewAction` exige admin si la vista es pantalla de app).
- **Ver como…:** `?como=<rol>` sólo lo honra a un admin; datos reales con ese rol y todo en sólo lectura.

## Rutas y pantallas

| Ruta | Qué es |
|---|---|
| `/apps` | Estantería y plantillas («Control en planta»), crear en blanco. |
| `/apps/<slug>` | Redirige a la primera pantalla visible del rol. |
| `/apps/<slug>/<pantalla>` | La pantalla corriendo (`AppRunner`): menú inferior en celular, lateral en escritorio. |
| `/apps/<id>/edit` | Editor: pantallas, roles y permisos, miembros, «Ver como…»; `?pantalla=<id>` abre el lienzo de vistas. |
| `/api/apps/<app>/screens/<pantalla>/{data,export,upload,dictate,relation}` | Mismas rutas de las vistas, con rol. |

Entrada «Aplicaciones» en el menú (`lib/nav-shape.ts`).

## Chat

`apps.list` (lectura) y `apps.create` (con confirmación; plantilla `control_planta` o diseño propio). Crear deja la app en borrador; publicar y asignar miembros se hace en el editor. Antes de diseñar sobre una hoja o carpeta de Drive se propone la tabla (`trackers.propose_from_source` / `trackers.propose_from_drive_folder`).

## Fase 2: usuarios externos e instalable (0209)

Un operario o un cliente SIN cuenta de Cortex entra a su app con un código por correo. No cuentan como asientos del plan (decidido 2026-10-06); sí tienen topes de uso. Sin WhatsApp: la entrada es sólo por correo.

| Tabla / columna | Qué guarda |
|---|---|
| `custom_app_users` | nombre, correo (minúsculas, único por app), rol, atributos (`$user.<atributo>`), estado `invited`/`active`/`disabled`, último acceso. |
| `custom_app_sessions` | una por dispositivo: SÓLO el sha256 del token, vencimiento, dispositivo, `revoked_at`. |
| `custom_app_login_codes` | código de 6 dígitos en HMAC (con llave del servidor y el usuario), vence a los 10 min, `attempts`. |
| `tracker_rows.created_by_app_user` | quién creó la fila desde la app. «Own» de un miembro mira `created_by`; el de un externo mira `created_by_app_user`; nunca se cruzan (hay prueba con el mismo uuid en los dos). |
| `custom_view_events.actor_kind` | `member` o `app_user`: de quién es `actor`. Los envíos guardan el id del externo en `submitted_by`. |

**Entrada** (`/a/<id de la app>`; el slug sólo es único por empresa, por eso va el id). Sin sesión: pantalla con la marca de la empresa, correo → código. Un miembro de Cortex con sesión normal que abre `/a/<app>` entra con su rol de la fase 1 (`openApp` prueba primero la sesión de Cortex y luego la cookie de la app). Código y sesión viven en `packages/agent-tools/src/apps/external.ts`; la cookie y las rutas en `apps/web/lib/apps/external-{session,actions}.ts`.

- Código: vence a los 10 min, un código nuevo anula el anterior, se bloquea a los 5 intentos fallidos (ni el bueno entra después), 5 códigos por hora por usuario, y por IP/correo en memoria (`lib/apps/rate-limit.ts`; en varias instancias cada una cuenta aparte).
- NO REVELA SI EL CORREO EXISTE: desconocido, desactivado o tope de la hora dan el mismo mensaje; un código malo, vencido o bloqueado es el mismo «no es correcto».
- Cookie `cortex_app_<appId>`: httpOnly, secure, sameSite lax, 30 días deslizantes (la sesión se renueva a lo sumo una vez por hora). `resolveExternalSession` revisa en CADA petición sesión, usuario `active` y rol: desactivar corta todas sus sesiones y lo saca en la siguiente petición. Cerrar sesión y «cerrar todas mis sesiones» en el menú.
- `getAppUser` / `requireAppUser(appId)` → {app, user, role, access, db}, con el cliente acotado a la empresa de la app (única lectura sin alcance: `findPublishedApp`, en la lista de `tenancy-guard.test.ts`).

**Ejecutar como externo.** `/a/<app>/<pantalla>` reutiliza `AppRunner`. Lectura con `audience: 'public'` (nunca Feed ni fuentes internas/personales) y scope por rol con `$user.<atributo>` ANTES de calcular (tablas, cifras, gráficos, Excel). Escrituras por las mismas funciones con rol (`actorKind: 'app_user'`): campos, own/all, botones, aprobación; relaciones sólo de las tablas de la pantalla. Exportar sólo si el rol exporta. Las rutas `/api/apps/<app>/screens/<pantalla>/{data,export,upload,dictate,voice-turn,relation}` tienen su gemela bajo `/api/apps/public/…` (`PUBLIC_PATHS` del middleware: `/a` y `/api/apps/public`); es el mismo manejador y la misma puerta (`openScreenForApi`). Subir, dictar y voz exigen además que el rol pueda registrar en esa tabla (`formGate`).

**Topes por usuario y por app** (además de los de la pantalla): envíos 60/h por usuario y 1000/h por app; cambios (ediciones y botones) 240/h y 3000/h (`assertExternalBudget`, contados en la base); subidas 120/h, dictados 80/h y turnos de voz 400/h por usuario (en memoria).

**Invitar y administrar:** pestaña «Usuarios» del editor (`lib/apps/user-actions.ts`, sólo quien administra): invitar uno por uno (nombre, correo, rol, atributos), importar CSV (columnas `nombre`, `correo`, `rol`; las demás son atributos; coma, punto y coma o tabulador), reenviar, cambiar rol, desactivar/reactivar, quitar y ver el último acceso. Correo de invitación con el enlace a `/a/<app>` (`lib/email-templates/app-access.ts`); la app tiene que estar publicada para que el enlace abra.

**Instalable.** `GET /a/<app>/manifest.webmanifest` (name/short_name, `start_url` y `scope` de la app, `display: standalone`, color de la marca o del acento), íconos `/a/<app>/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` y `apple-touch-icon.png` (`ImageResponse` del emoji sobre el color; cae a la inicial) y `/a/<app>/sw.js` con alcance `/a/<app>/`. El worker guarda el cascarón (`/_next/static`) y las pantallas visitadas y sus datos, UNA CACHÉ POR USUARIO (`cortex-app-<app>-u-<usuario>`): la página le avisa quién es (`who`), al entrar otra persona se borran las ajenas, al salir (`signout`) o si la red redirige a la entrada se borra todo. Lógica pura en `lib/apps/offline-cache.ts` (se incrusta en el worker con `toString`, probada aparte). Aviso «Sin conexión · datos de hace X»; los formularios usan la cola sin internet de siempre. Botón «Instalar en este teléfono» (`beforeinstallprompt` en Android/Chrome; instrucciones de «Compartir → Agregar a inicio» en iPhone). Límite honesto: una sesión revocada desde el servidor deja la copia en un teléfono sin señal hasta que vuelva a conectarse.

## Chat (completo)

`apps.list` y `apps.get` (lectura; los usuarios invitados sólo los ve quien administra), `apps.create`, `apps.update` (renombrar, ícono, inicio, agregar/editar/quitar/ordenar pantallas con la misma gramática de `views.update`, roles y permisos completos; valida antes de escribir y no deja quitar un rol con usuarios externos), `apps.publish` (publicar/despublicar), `apps.assign_members` (miembros de Cortex por correo o nombre) y `apps.invite_users` (externos; manda el correo por `ToolContext.sendAppInvitations`). Todas con confirmación salvo las de lectura y sólo para owner/admin. Etiquetas en `tool-labels.ts`, `chat-palette-tools.ts` y `approvals/summary.ts`; instrucción corta en `system-prompt.ts`. Pruebas en `apps/__tests__/tools.test.ts`.

## Pruebas

- `src/apps/__tests__/permissions.test.ts`: reglas puras.
- `src/apps/__tests__/external.test.ts` (código, sesión, CSV), `tools.test.ts` (herramientas del chat) y, en `isolation.test.ts`, el aislamiento de los externos; en web `lib/apps/external.test.ts` (manifiesto, caché sin mezclar usuarios, topes, correos) y `middleware-public.test.ts`.
- `src/apps/__tests__/isolation.test.ts`: dos empresas con datos gemelos; empresa A no lee B, el operario sólo ve lo suyo (tablas y cifras), rol sin pantalla = 404, operario no aprueba ni escribe campos ajenos ni edita filas ajenas, y las pantallas no se abren por la puerta de las vistas.

## Pendiente (fases siguientes)

- Fase 3: automatizaciones y Web Push (VAPID, suscripción por usuario de app y por miembro); es el canal de avisos junto con el correo.
- Fase 4: PIN y modo kiosco, `ask_cortex`, portal de clientes pulido, `apps.design` por texto completo.
- Medir de nuevo `src/evaluation` (`EVAL_MEASURE=1`): se agregaron descripciones de herramientas.
- Fijar en la caché sin conexión la primera pantalla al instalar (hoy se guarda al visitarla con señal).
