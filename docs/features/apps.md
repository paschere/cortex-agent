# Aplicaciones

Un conjunto de pantallas con menú y roles, armado sobre las mismas tablas (`trackers`) y vistas que ya usa la empresa. El operario de planta ve «Registrar» y «Mis registros» (sólo sus filas), el supervisor aprueba, gerencia mira el tablero y exporta. Migración `0208_custom_apps.sql`. Plan completo: [docs/plans/aplicaciones.md](../plans/aplicaciones.md).

Estado: **fase 1** (miembros de Cortex con rol) y **fase 2** (usuarios externos con código por correo e instalable, migración `0209_custom_app_users.sql`). Automatizaciones y Web Push son la fase 3; el modo kiosco, el portal de clientes y `apps.design` son la **fase 4** (migración `0211_custom_app_kiosk.sql`, ver abajo).

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

## Fase 3: automatizaciones y Web Push (0210)

Una app que avisa y mueve cosas sola: «duplicado → aviso al supervisor», «si le rechazan → aviso al operario», «al aprobar → pasa a Despachada», «resumen diario a gerencia». **Los avisos van SÓLO por notificación push y correo** (decidido 2026-10-06): no hay acción de WhatsApp.

| Tabla | Qué guarda |
|---|---|
| `custom_app_automations` | Cuando (`trigger`), Si (`conditions`), Entonces (`actions`) en JSON validado en código (`apps/automations/spec.ts`), `enabled`, y copias `tracker_id`/`trigger_kind` para la consulta barata de cada escritura. |
| `custom_app_automation_runs` | Una corrida por (regla × suceso): cola durable, `idempotency_key` ÚNICA, intentos, resultado por acción e historial con errores. |
| `push_subscriptions` | Suscripciones Web Push de un usuario externo o de un miembro; único por `endpoint` (un teléfono compartido cambia de dueño, no se duplica). |

**Cómo se emiten los eventos (un solo punto).** `apps/automations/emit.ts` (`emitAutomationEvent`) se llama DESPUÉS de cada escritura de filas, junto a `applyDuplicateRule`: `upsertRow` (`row_created`/`row_updated`), `submitViewForm` (`row_created` + `form_submitted`), `patchRow` de las vistas (`row_updated` y, si fue Aprobar/Rechazar, `approval_decided`), `applyDuplicateRule` (`row_flagged_duplicate`, sólo las filas que quedaron marcadas ahora) y las sincronizaciones de hojas, carpetas de Drive y programas contables (`emitSyncEvents`, que lee lo escrito desde el inicio de la sincronización). Cada escritura paga como máximo UNA consulta indexada («¿hay reglas encendidas que miren esta tabla?», recordada 10 s); sin reglas no se lee nada más. Si hay, deja una fila `queued` por regla (con el suceso adentro) y despierta al trabajo `apps/automation.run`; si encolar falla, el barrido de cada minuto (`apps/automation.dispatch`) la recoge. Nunca lanza: una regla caída no tumba el guardado de la fila.

**Disparadores:** `row_created`, `row_updated` (campo opcional y «pasó a <valor>»), `row_flagged_duplicate`, `form_submitted` (pantalla/bloque), `approval_decided` (aprobado/rechazado/cualquiera), `schedule` (diaria o semanal a una hora, zona Bogotá; la franja se reclama con un UPDATE condicionado) y `button` (acción manual en una pantalla: sale un botón sobre el lienzo para quien ve esa pantalla; se deduplica por persona en 30 s).

**Condiciones:** los filtros de las vistas (`matches` de `views/compute.ts`, misma semántica) más «cambió de X a Y».

**Acciones:** `set_field`, `create_row` (otra tabla, valores fijos o `{{campo}}`), `notify_member` (campana y push a miembros, roles de la app o administradores), `notify_app_user` (push al creador de la fila o a un rol; si no tiene push activo, correo), `email` (a direcciones fijas o a usuarios de un rol), `webhook` y `ask_cortex`. Variables: `{{campo}}` (llave o etiqueta), `{{antes.campo}}`, `{{nombre}}`, `{{app}}`, `{{enlace}}`, `{{motivo}}`; un nombre desconocido queda vacío.

- **Webhook:** POST JSON firmado con HMAC-SHA256 (`x-cortex-signature: v1=<hex>` sobre `x-cortex-timestamp.cuerpo`, llave por regla derivada de `BETTER_AUTH_SECRET`, visible en el editor). Reutiliza las protecciones de las herramientas personalizadas (`custom-tools/guard.ts`): sólo https, sin credenciales en la URL, la dirección resuelta no puede ser privada, loopback ni link-local, conexión fijada a la dirección validada y SIN redirecciones.
- **ask_cortex:** corre como una rutina (`surface: 'schedule'`, con la política de riesgo y las reglas CEL de la empresa). Sin aprobación sólo lee y escribe en la tabla de la regla; cualquier otra escritura (aunque la herramienta no pida confirmación) queda como aprobación pendiente (`mcp_pending_actions`, origen `schedule`) para quien creó la regla, con su correo. Nunca se le ofrecen herramientas de `apps.*`, seguridad, mandatos ni facturación.

**Garantías.** Idempotencia por `idempotency_key` = regla + tipo + fila + versión del suceso (un reintento o dos escritores dejan UNA corrida). Sin bucles: lo que escribe una regla corre dentro de `withAutomationOrigin` (AsyncLocalStorage); el evento que nace lleva la cadena de reglas y su profundidad, así que una regla no se dispara a sí misma ni por una vuelta larga, y la profundidad máxima es 3. Reintentos con espera creciente (1, 5 y 15 min, hasta 4 intentos) sólo para errores transitorios (red, 429, 5xx); la corrida guarda el resultado de CADA acción y al reintentar salta las que ya salieron (un correo no se repite porque falló el webhook siguiente). Pausar no borra el historial y salta lo ya encolado. Corridas «running» de hace más de 10 min vuelven a la cola. Topes por app y por día (cuentan filas de `custom_app_automation_runs`): 500 corridas y 20 pedidos a Cortex.

**Web Push.** Variables de entorno (las tres, o el push queda apagado, la UI lo dice y los avisos a usuarios de app salen por correo): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` (`mailto:…` o https); se generan con `npx web-push generate-vapid-keys`. El service worker de la app (`/a/<app>/sw.js`) maneja `push` (pinta el aviso) y `notificationclick` (enfoca o abre la pantalla, sólo dentro de `/a/<app>/`). El botón «Activar notificaciones» (`PushToggle`, con su explicación; en iPhone pide instalar la app primero) suscribe a quien está abierto —usuario externo o miembro de Cortex— por `/api/apps/public/<app>/push` (GET estado y clave pública, POST suscribir, DELETE). Una suscripción vencida (404/410) se borra al primer envío.

**Editor.** Pestaña «Automatizaciones»: lista con estado y última corrida, creación en Cuando / Si / Entonces, plantillas («Avisar al supervisor cuando haya un duplicado», «Avisar al operario si le rechazan», «Resumen diario a gerencia», «Pasar a Despachada cuando se apruebe»), «Probar con una fila de ejemplo» (simulación: usa el mismo motor y dice qué haría, no hace nada), historial con errores por acción, pausar/reanudar y borrar. Un disparador `button` es la forma de configurar los botones de acción manual de una pantalla.

**Chat.** `apps.automations.list` (lectura), `.create` (plantilla o Cuando/Si/Entonces), `.update` y `.pause` (con confirmación, sólo owner/admin). Se validan contra la app real (tablas, campos, pantallas y roles de ESA app).

**Pruebas.** `apps/automations/__tests__/engine.test.ts` (puro: variables, disparadores, condiciones, bucles, idempotencia, horarios, reintentos, plantillas, simulación), `automations.test.ts` (dos empresas: emisión, aislamiento, `notify_app_user` sólo a usuarios de esa app, reintentos, webhook que rechaza http e IP privadas, tope diario, botones, validación) y `tools.test.ts` (chat); en web `lib/apps/push.test.ts` (sin llaves → nada de push, 410 borra, push sólo de esa app, qué corre y qué espera aprobación en `ask_cortex`), más `jobs-registry.test.ts` y `tenancy-guard.test.ts`.

## Chat (completo)

`apps.list` y `apps.get` (lectura; los usuarios invitados sólo los ve quien administra), `apps.create`, `apps.update` (renombrar, ícono, inicio, agregar/editar/quitar/ordenar pantallas con la misma gramática de `views.update`, roles y permisos completos; valida antes de escribir y no deja quitar un rol con usuarios externos), `apps.publish` (publicar/despublicar), `apps.assign_members` (miembros de Cortex por correo o nombre) y `apps.invite_users` (externos; manda el correo por `ToolContext.sendAppInvitations`). Todas con confirmación salvo las de lectura y sólo para owner/admin. Etiquetas en `tool-labels.ts`, `chat-palette-tools.ts` y `approvals/summary.ts`; instrucción corta en `system-prompt.ts`. Pruebas en `apps/__tests__/tools.test.ts`.

## Fase 4: kiosco, portal de clientes y diseño por chat (0211)

### Modo kiosco (dispositivo compartido de planta)

Un celular que usan varias personas se deja «en modo kiosco» para UNA app. Cada operario toca su nombre y escribe su PIN; lo que registra queda a SU nombre (`created_by_app_user`) y su sesión se cierra sola tras N minutos sin uso. Código: `packages/agent-tools/src/apps/kiosk.ts`; web en `lib/apps/kiosk-{session,actions,admin-actions}.ts`, `components/apps/KioskScreen.tsx` y `app/a/[app]/kiosco`.

| Qué | Dónde |
|---|---|
| `custom_apps.kiosk_enabled`, `kiosk_idle_minutes` (1–120, por omisión 5) | Se activa y se configura en la pestaña «Usuarios» → «Dispositivos de planta». |
| `custom_app_devices` | Nombre, SÓLO el sha256 del token del dispositivo, `revoked_at`, quién lo dejó. |
| `custom_app_users.pin_hash / pin_attempts / pin_locked_until` | PIN en hash con sal (scrypt + llave del servidor), intentos y bloqueo. |
| `custom_app_sessions.device_id / idle_minutes` | La sesión de kiosco es una sesión normal atada a un dispositivo y con vencimiento por inactividad. |

**Flujo.**
1. Quien administra activa el kiosco y, en «Dispositivos de planta», crea un enlace de emparejamiento (un solo uso, 15 min). El celular abre `/a/<app>/kiosco?c=…` y toca «Dejar este celular en modo kiosco» (el botón gasta el código, no el enlace: una vista previa no lo consume). Alternativa: un rol con «Deja celulares en kiosco» (`permissions.kiosk`, típico del supervisor) o un administrador lo hace desde el menú de la app, en el celular que tiene en la mano; su sesión se cierra y el celular queda pidiendo PIN.
2. En `/a/<app>`, un navegador con dispositivo autorizado y sin sesión muestra la lista de nombres (activos con PIN; buscador si son más de 12) y el teclado, no la entrada por correo. PIN de 4 a 6 números; al sexto dígito entra solo.
3. El PIN lo asigna el administrador (fila del usuario → «Asignar PIN») o la persona lo define en «Mi PIN» tras entrar con código por correo. Cambiarlo en un kiosco pide el PIN actual.
4. «Cambiar de persona» cierra la sesión y vuelve a la lista; sin uso durante N minutos pasa lo mismo (`KioskIdleGuard` cuenta tocar/escribir/mover; el servidor lo exige además en CADA petición y deja la sesión revocada).

**Seguridad.**
- El PIN sólo vale con un dispositivo autorizado y vivo (cookie httpOnly `cortex_appdev_<app>`, un año; el servidor guarda el hash). En un navegador cualquiera no abre nada, ni con el PIN bueno.
- Bloqueo por persona (no por celular): 5 fallos → 15 minutos bloqueada y NI EL PIN BUENO entra mientras dure; cambiar de celular no reinicia el contador, un acierto sí. Reasignar el PIN la destraba. Conteo con compare-and-set (dos intentos en paralelo no cuentan como uno). Topes en memoria por dispositivo (40/15 min) y por IP (120/h).
- Un PIN trivial (0000, 1111, 1234, 9876…) se rechaza. Los mensajes no distinguen dispositivo revocado, persona desactivada o sin PIN y PIN malo; sólo se dice el bloqueo y los intentos que quedan.
- Revocar el dispositivo (editor) o apagar el kiosco corta en el mismo paso las sesiones abiertas en él. Quitar el PIN cierra las de esa persona. Tope de turno: 12 h aunque no pare de usarla. Desactivar a la persona la saca como siempre.
- Una persona nunca ve las filas «own» de otra en el mismo celular: cada PIN abre SU sesión con SU rol y SU scope; al entrar otra persona el worker borra la caché de la anterior (`who`), y al volver a la lista de nombres se borran todas (`signout`).
- Límite honesto: mientras el celular está sin señal el servidor no puede cortar una sesión; la corta el temporizador del navegador y, al volver la señal, el servidor.

### Portal de clientes

Plantilla `portal_clientes` (`templates.ts`, lista en `/apps`): tablas `pedidos_cliente` y `documentos_cliente`; rol **Cliente** con `read: {field: 'cliente', equals: '$user.cliente'}` (no exporta, no edita; crea sólo `referencia/fecha/descripcion` o el documento) y rol **Atención al cliente** (ve y atiende todo). Pantallas «Mis pedidos» (cifras + tarjetas con estado), «Nueva solicitud», «Mis documentos» y «Atención». La marca de la empresa sale de `company_branding` en la entrada y el marco de `/a`.
- **Un solo dato lo cierra todo:** el servidor aplica el filtro ANTES de calcular tablas, cifras, gráficos, archivos y Excel. Sin el atributo, el cliente no ve NADA (no «todo»).
- **Crear a nombre del cliente:** `submitAppForm` pasa el campo del scope en `forced` (y `fillDefaults`), no en `values`: el formulario no lo muestra ni lo deja escribir (`cliente` fuera de la lista de campos del rol = «no puede escribir») y la fila queda con SU cliente y el estado inicial «Solicitada». (Antes el campo se descartaba si el formulario no lo pedía: era un hueco, corregido en `views/store.ts` con `forced`/`fillDefaults`.)
- **Invitar:** un rol con filtro por atributo no se invita sin él (`requiredAttributes`; también al cambiar de rol). La pestaña «Usuarios» pide el valor con autocompletar desde los valores REALES de esa columna (`attributeValueSuggestions`, sólo la empresa y sólo el editor).
- **Ver como cliente X:** «Ver como…» pide el cliente y abre `?como=cliente&atr=cliente:Andina` (sólo administradores; sólo lectura; la pantalla, los datos y el Excel repiten la dirección: `lib/apps/preview-query.ts`).
- Pruebas de aislamiento con la plantilla real en `src/apps/__tests__/portal.test.ts`.

### `apps.design`

Herramienta de chat de sólo lectura (sólo owner/admin) que arma el BORRADOR completo de una app sin guardar nada: el modelo del chat compone nombre, roles, pantallas (o parte de una plantilla) y la herramienta lo valida contra las tablas reales (`validateSpec` por pantalla, campos de los filtros y de `fields`, roles de cada pantalla, barrera de fuentes internas), avisa de lo raro (rol sin permiso sobre una tabla de su pantalla, formulario sin poder registrar, rol por atributo que necesita el dato), devuelve `{ok, problems, warnings, draft, automations, markdown}` y un resumen en lenguaje simple para aprobar. Las automatizaciones sugeridas son TEXTO (`name/when/action`): no se activan. Si algo no cuadra devuelve los problemas, y una tabla inexistente trae la regla de siempre (primero `trackers.propose_from_source` / `trackers.propose_from_drive_folder`). Aprobado, `apps.create` guarda ese mismo borrador. Código: `apps/design.ts`; pruebas: `__tests__/design.test.ts`.

### Instalación

Al instalar, el worker guarda además la pantalla de inicio del rol y sus datos (`precacheUrlsOf`; `who` trae `precache` y se repite en `appinstalled`), en la caché de LA persona que está dentro y sólo si aún no estaban.

## Pruebas

- `src/apps/__tests__/permissions.test.ts`: reglas puras.
- `src/apps/__tests__/external.test.ts` (código, sesión, CSV), `tools.test.ts` (herramientas del chat) y, en `isolation.test.ts`, el aislamiento de los externos; en web `lib/apps/external.test.ts` (manifiesto, caché sin mezclar usuarios, topes, correos) y `middleware-public.test.ts`.
- Fase 4: `src/apps/__tests__/kiosk.test.ts` (PIN, bloqueo, dispositivo revocado, inactividad, dos personas en un celular), `portal.test.ts` (cliente A nunca ve a B: filas, cifras, archivos, Excel; invitar; autocompletar; ver como), `design.test.ts`; en web `lib/apps/kiosk.test.ts` (caché por persona, precaché, «Ver como»).
- `src/apps/__tests__/isolation.test.ts`: dos empresas con datos gemelos; empresa A no lee B, el operario sólo ve lo suyo (tablas y cifras), rol sin pantalla = 404, operario no aprueba ni escribe campos ajenos ni edita filas ajenas, y las pantallas no se abren por la puerta de las vistas.

## Pendiente (fases siguientes)

- Fase 3 (hecha, ver arriba): migración 0210 sin aplicar hasta desplegar; faltan las llaves VAPID en Vercel (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`) para que el push salga; mientras tanto, correo. Las corridas no se miden aún en `usage_events` (el tope por app y día cuenta filas propias).
- `ask_cortex` (automatizaciones, fase 3).
- Kiosco: la lista de nombres es la de todos los usuarios activos con PIN (sin teclado de «sólo PIN»); un PIN por app, no por empresa.
- Medir de nuevo `src/evaluation` (`EVAL_MEASURE=1`): se agregaron descripciones de herramientas.
