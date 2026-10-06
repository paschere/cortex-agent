# Plan: Aplicaciones

Estado: propuesto (2026-10-06). Para implementar en otra sesión. Debe servir a **cualquier empresa**; el primer caso real es el control de guías en planta.

## Qué es

Una **Aplicación** es un conjunto de pantallas con menú, usuarios y roles propios, instalable en el celular y con automatizaciones, armada sobre las mismas tablas (trackers) que ya usan las Vistas.

| | Vista (hoy) | Aplicación (nuevo) |
|---|---|---|
| Pantallas | Una (con páginas/pestañas) | Varias, con menú y navegación |
| Quién entra | Miembros de Cortex, o cualquiera con enlace/contraseña | Usuarios de la app (operarios, clientes) con su propio acceso, sin ser miembros |
| Qué ve cada quien | Lo mismo | Según su rol: pantallas, filas y acciones |
| Celular | Página web | Instalable (ícono, nombre y marca de la app) |
| Lógica | Avisos en vivo | Automatizaciones: cuando pasa X, hacer Y |
| Se arma | Cortex + editor visual | Cortex + editor visual (igual) |

**Ejemplo guía (control de guías en planta):**
- **Operario.** Pantallas: «Registrar» (formulario con dictado/escáner/foto, sin internet) y «Mis registros». Ve solo sus filas.
- **Supervisor.** Pantalla «Por aprobar» (aprobar/rechazar) y «Duplicados». Ve todo.
- **Gerencia.** «Tablero» (métricas, embudo, metas) y exportar.
- **Automatizaciones:**
  - guía marcada Duplicado → aviso al supervisor por WhatsApp o correo;
  - rechazo → aviso al operario;
  - resumen diario a gerencia.

## Principio: reutilizar, no duplicar

Una pantalla de app ES un spec de vista (`packages/agent-tools/src/views/spec.ts`) con un contexto distinto (quién mira y qué puede). No se crea un segundo motor de render ni de escritura.

Se reutiliza:
- **Render y cómputo:**
  - `computeView` (packages/agent-tools/src/views/compute.ts);
  - `LiveViewCanvas` / `ViewCanvas` / `FormBlock` (apps/web/components/views/**);
  - diseño operario (`theme.layout: 'operator'`), avisos en vivo y titileo (`apps/web/lib/live-signal.ts`).
- **Escrituras:**
  - `submitViewForm`, `editViewRow`, `runViewAction`, `editViewSubmission` (packages/agent-tools/src/views/store.ts);
  - validación `validateRowValues` (trackers/validation.ts), duplicados `applyDuplicateRule` (trackers/duplicates.ts), aprobación (`approval` del form);
  - cola sin internet (`apps/web/lib/views/offline-queue.ts`, `useFormQueue.ts`), subida de archivos (`lib/views/upload.ts`), dictado (`lib/views/dictate.ts`).
- **Fuentes y privacidad:**
  - `loadViewSources` y la regla de audiencia pública (packages/agent-tools/src/views/sources.ts, `internalSourcesOf`): una app con usuarios externos usa la misma barrera que el enlace público;
  - el Feed NUNCA se expone.
- **Diseñador:** `VIEW_DESIGNER_SYSTEM` / `SPEC_GRAMMAR` (apps/web/lib/views/design.ts, views/tools.ts) se extienden, no se copian.
- **Editor:**
  - apps/web/components/views/editor/** y el editor «Campos y reglas» (apps/web/components/trackers/SchemaEditor.tsx);
  - crear tabla desde hoja o carpeta (`CreateTableDialog`).
- **Marca:** `company_branding` (0170) para ícono y colores por defecto.
- **Avisos y correo:** `apps/web/lib/notifications/notify.ts`, plantillas en apps/web/lib/email-templates/ (ver `view-digest.ts`).
- **WhatsApp:** packages/agent-tools/src/whatsapp/** (revisar si hay envío saliente de plantilla; si no, la acción WhatsApp queda detrás de una bandera y se dice).
- **PWA:** ya existe para Cortex (`apps/web/app/manifest.ts`, `apps/web/app/service-worker.tsx`, `public/sw.js`): imitar el patrón, con manifiesto por app.

## Modelo de datos (migración nueva)

Usa el siguiente número libre y compáralo contra `origin/main` antes de subir. Hoy sería 0206. Ver la nota de la memoria «migraciones en orden»: un número menor que uno ya aplicado tumba el deploy.

Todas las tablas llevan `organization_id`, RLS como 0160/0201 y acceso por `getOrgScopedClient`.

- **`custom_apps`:** id, organization_id, slug (único por empresa), name, description, icon (emoji o URL de asset), theme (acento, estilo; por defecto la marca), `home_screen`, status (`draft`/`published`), version, created_by, timestamps.
- **`custom_app_screens`:** id, app_id, slug, title, icon, `spec` (jsonb = ViewSpec validado con `viewSpecSchema`), `position`, `roles` (text[] de roles que la ven). Alternativa: guardar las pantallas dentro de `custom_apps.screens` jsonb. Elegir tabla aparte si se quiere versionar y editar pantallas por separado.
- **`custom_app_roles`:** id, app_id, key, name, y `permissions` jsonb:
  - `screens: string[]`;
  - por tabla:
    - `read: 'all' | 'own' | {field, equals: '$user.<atributo>'}`;
    - `create: boolean`;
    - `edit: 'none' | 'own' | 'all'`;
    - `fields?: string[]` (campos que puede escribir);
    - `actions: string[]` (ids de acciones/aprobar);
  - `export: boolean`.
- **`custom_app_users`:** id, app_id, organization_id, name, `email?`, `phone?`, `role_key`, `attributes` jsonb (p.ej. `{cliente: "Andina"}`, usado por los filtros de fila), status (`invited`/`active`/`disabled`), last_seen_at, created_by. Un miembro de Cortex también puede entrar a la app con su sesión normal, con un rol asignado. En ese caso guardar `member_user_id` en vez de credenciales propias.
- **`custom_app_sessions`:** id, app_user_id, token_hash (scrypt/sha256 del token), expires_at, device (user agent corto), created_at, revoked_at.
- **`custom_app_login_codes`:** app_user_id, code_hash, channel (`email`/`whatsapp`), expires_at (10 min), attempts (bloqueo a los 5).
- **`custom_app_automations`:** id, app_id, name, enabled, `trigger` jsonb, `conditions` jsonb, `actions` jsonb, created_by.
- **`custom_app_automation_runs`:** id, automation_id, trigger_ref (fila/evento), status, error, started_at, finished_at, `idempotency_key` único (automatización + fila + versión del evento).
- **`tracker_rows.created_by_app_user`** (uuid, nullable): quién de la app creó la fila, para el filtro «own». Alternativa: guardarlo en `custom_view_submissions`, pero el filtro de lectura necesita la fila.

## Acceso de usuarios de la app (sin ser miembros)

Sin better-auth (es para miembros y empresas). Sesión propia, sencilla y revocable:

1. **Entrada:** `/a/<empresa>/<app>` o, más corto, `/a/<appId-corto>`.
   - Si no hay sesión: pantalla de entrada con la marca de la app.
   - El usuario pone correo o celular y recibe un código de 6 dígitos (correo con las plantillas existentes; WhatsApp si hay envío saliente).
   - Tiene topes por IP y por usuario, y el código expira.
2. **Cookie de sesión:** `cortex_app_<appId>`, httpOnly, sameSite=lax, 30 días deslizante. El servidor guarda solo el hash. Cerrar sesión y «cerrar todas mis sesiones».
3. **Dispositivo compartido de planta (opcional, fase 4):** el supervisor deja un celular «en modo kiosco» con sesión de dispositivo. Cada operario entra con un PIN de 4–6 dígitos ligado a su usuario, y la sesión se cierra sola tras N minutos sin uso.
4. **Middleware:** `apps/web/middleware.ts` agrega `/a` y `/api/apps/public` a `PUBLIC_PATHS`. La autorización real va en cada ruta con un helper `requireAppUser(appId)` que devuelve {app, user, role, db} con el cliente acotado a la empresa de la app (como `openPublicView` en lib/views/public.ts).
5. **Invitar usuarios:**
   - desde el editor de la app: uno por uno o importando un CSV (nombre, correo/celular, rol, atributos);
   - les llega el enlace por correo o WhatsApp;
   - desactivar corta todas sus sesiones.
6. **Miembros de Cortex:** entran con su sesión y el rol que les asigne la app. Un owner/admin siempre puede entrar como «administrador».

## Permisos (lo más delicado)

Toda decisión se toma en el servidor, con el spec y el rol guardados, nunca con lo que mande el navegador.

- **Pantallas:**
  - el rol solo recibe en el menú sus pantallas;
  - pedir una pantalla ajena es 404;
  - el spec que llega al cliente es el ya computado, sin bloques de fuentes que el rol no puede leer.
- **Lectura de filas:**
  - se agrega un filtro obligatorio por rol en `loadViewSources`/`computeView`. Nuevo parámetro `scope: {tracker, filter}[]` que se aplica ANTES de computar métricas (las cifras de un cliente solo cuentan sus filas);
  - `own` = `created_by_app_user = user.id`;
  - `{field, equals:'$user.cliente'}` = el valor del atributo del usuario.
- **Fuentes:**
  - igual que el enlace público: solo trackers y fuentes `cortex.*` compartibles, nunca Feed ni `internal`/`personal`;
  - publicar una app con una fuente no permitida se rechaza con la lista, como `internalShareRefusal`.
- **Escritura:**
  - formularios y ediciones pasan por las mismas funciones de store con un `writer: {kind:'app_user', id, role}`;
  - el rol limita qué campos y qué filas (own/all) y qué acciones (aprobar/rechazar);
  - topes por usuario además de por vista;
  - todo queda en `custom_view_events` con `actor = app_user` (extender el esquema: `actor_kind`).
- **Exportar:** solo si el rol lo permite, con el mismo scope.
- **Tests de aislamiento obligatorios:**
  - un usuario de la empresa A nunca lee filas de B;
  - un cliente con `$user.cliente` nunca ve las de otro cliente, ni en tablas ni en métricas ni en exportar;
  - un operario no aprueba;
  - un usuario desactivado o con sesión revocada queda fuera.

  Imitar `src/commitments/__tests__/isolation.test.ts` y `tenancy-guard.test.ts`.

## Instalable en el celular (PWA por app)

- `GET /a/<app>/manifest.webmanifest` dinámico:
  - `name`/`short_name` de la app;
  - `start_url` y `scope` = `/a/<app>`;
  - ícono generado desde el emoji o el logo (ruta `/a/<app>/icon-<size>.png` que lo renderiza; Next `ImageResponse`);
  - colores de la marca;
  - `display: standalone`.
- Service worker con alcance `/a/<app>/`. A diferencia del de Cortex, SÍ cachea:
  - el cascarón de la app y las pantallas visitadas, para abrir sin señal;
  - los datos se muestran con «Sin conexión · datos de hace X»;
  - los formularios ya tienen cola sin internet;
  - nunca cachear respuestas de otra sesión: la clave incluye el usuario.
- Botón «Instalar en este teléfono»:
  - Android/Chrome con `beforeinstallprompt`;
  - iOS con instrucciones de «Compartir → Agregar a inicio».
- Notificaciones push (fase 4): Web Push con VAPID, suscripción por usuario de app, usadas por las automatizaciones.

## Automatizaciones

Motor simple, durable e idempotente, ejecutado con el sistema de trabajos existente (inngest o pg-boss; ver apps/web/inngest/functions/*.ts y `services/jobs/src/manifest.ts`, y registrar en `jobs-registry.ts` y `tenancy-guard.test.ts` como hizo `view-digest.ts`).

- **Disparadores:**
  - `row_created`, `row_updated` (opcional `field` y `to`), `row_flagged_duplicate`, `form_submitted` (pantalla/bloque), `approval_decided` (aprobado/rechazado);
  - `schedule` (diaria/semanal a una hora, zona Bogotá);
  - `button` (acción manual en una pantalla).
  - Emitir los eventos de fila desde UN solo punto: después de `upsertRow`/`submitViewForm`/`patchRow`/syncs, junto a `applyDuplicateRule`. Encolar `apps/automation.event` con {organizationId, trackerId, rowId, kind, before?, after}.
- **Condiciones:** las mismas de los filtros de vista (`filterSchema`), más «cambió de X a Y».
- **Acciones (v1):**
  - `set_field`: cambiar un campo de la fila;
  - `create_row`: en otra tabla, con valores de la fila o fijos;
  - `notify_member`: campana a miembros o roles de Cortex;
  - `notify_app_user`: push o correo al creador de la fila o a un rol;
  - `email`: plantilla con variables `{{campo}}`;
  - `whatsapp`: solo si hay envío saliente aprobado; si no, deshabilitada con el motivo;
  - `webhook`: POST firmado HMAC a una URL https, sin redirecciones a IPs privadas; reutilizar las protecciones de red de las herramientas personalizadas;
  - `ask_cortex`: instrucción en texto que Cortex ejecuta con las herramientas permitidas y SIEMPRE pasando por aprobación si escribe fuera de la tabla. Respetar `requiresConfirmation` y las políticas (packages/agent-tools/src/security/policy.ts). Es la última fase.
- **Garantías:**
  - idempotencia por `idempotency_key`;
  - una automatización no se dispara a sí misma en bucle: `set_field` hecho por la automatización no re-dispara la misma; profundidad máxima 3;
  - reintentos con espera para errores transitorios;
  - historial visible por automatización (corridas, errores) y pausar o reanudar.
- **Plantillas listas:** «Avisar al supervisor cuando haya un duplicado», «Avisar al operario si le rechazan», «Resumen diario», «Pasar a ‹Despachada› cuando se apruebe».

## Diseñador y editor

- **Cortex:**
  - herramientas `apps.design` (borrador sin guardar, como `/api/views/design`), `apps.create`, `apps.update`, `apps.publish` (confirmación), `apps.invite_users` (confirmación) y `apps.automations.*`;
  - extiende la gramática con pantallas, roles, permisos y automatizaciones;
  - regla de siempre: si la fuente es una hoja o una carpeta, primero proponer la tabla (`trackers.propose_from_source` / `trackers.propose_from_drive_folder`).
- **Editor visual** (`/apps/[id]/edit`):
  - columna izquierda con las pantallas (agregar, ordenar, ícono, quién la ve);
  - el centro usa el editor de vistas actual para la pantalla elegida;
  - pestañas «Roles y permisos» (matriz rol × pantalla y rol × tabla, con el filtro de filas en lenguaje simple: «ve solo lo suyo», «ve las filas donde Cliente = su cliente»);
  - pestaña «Usuarios» (invitar, importar, desactivar, ver último acceso);
  - pestaña «Automatizaciones» (cuando / si / entonces, con plantillas y su historial);
  - pestaña «Instalar y compartir» (enlace, QR, ícono, vista previa como cada rol).
- **«Ver como…»:** vista previa de la app como cada rol, con datos reales y sin escribir. Clave para confiar en los permisos.
- **Listado `/apps`:** con plantillas («Control en planta», «Portal de clientes», «Inspecciones», «Inventario»). Entrada en el menú de la app principal.

## Fases y criterios de aceptación

### Fase 1: Aplicación con pantallas y miembros de Cortex

- Tablas `custom_apps`, `custom_app_screens`, `custom_app_roles` (sin usuarios externos aún).
- `/apps`, crear, editar pantallas con el editor de vistas, menú inferior en celular y lateral en escritorio, roles asignados a miembros.
- Permisos de pantalla y de filas (scope) en el servidor.
- **Acepta:**
  - una app «Control en planta» con 4 pantallas;
  - un miembro con rol Operario solo ve sus pantallas y sus filas (también en métricas y exportar);
  - pruebas de aislamiento en verde.

### Fase 2: Usuarios externos e instalable

- `custom_app_users`, sesiones y códigos.
- Entrada por correo con código, invitaciones e importación CSV.
- Manifiesto, íconos, service worker con alcance y modo sin conexión de lectura.
- **Acepta:**
  - un operario sin cuenta Cortex recibe el enlace, entra con código, instala la app en Android e iPhone, registra sin señal y se envía al volver;
  - desactivarlo lo saca en el siguiente request;
  - topes y bloqueo de código probados.

### Fase 3: Automatizaciones

- Motor, disparadores de fila/formulario/aprobación/horario/botón y acciones `set_field`, `create_row`, `notify_member`, `notify_app_user` (correo), `email` y `webhook`.
- Historial y plantillas.
- **Acepta:**
  - «duplicado → aviso al supervisor» llega en menos de 1 minuto;
  - no hay bucles;
  - reintento tras un error de red;
  - el historial muestra cada corrida.

### Fase 4: Extras

- PIN y modo kiosco en dispositivo compartido.
- Web Push.
- WhatsApp saliente (si hay proveedor).
- `ask_cortex` con aprobaciones.
- Portal de clientes con filtro por atributo.
- Diseñador por texto completo (`apps.design`).

## Riesgos y decisiones abiertas

- **Fuga entre clientes en un portal:** es el riesgo principal. El scope de filas va en el servidor ANTES de computar, nunca en el cliente. Las pruebas de aislamiento bloquean el merge.
- **Costo de automatizaciones con `ask_cortex`:** tope por app y por día, y cuenta en el plan.
- **Precio y plan:** ¿las apps y los usuarios externos cuentan como asientos? Hay que definirlo antes de la fase 2. Sugerencia: usuarios de app ilimitados en planes pagos con tope de uso, no por asiento.
- **WhatsApp saliente:** confirmar si hay número y plantillas aprobadas. Si no, solo correo y push.
- **Dominio propio por app** (`planta.empresa.com`): fuera de alcance v1; dejar el diseño compatible (la app se resuelve por host o por ruta).

## Cómo trabajar

- **En paralelo:** máximo 2–3 subagentes con modelo sonnet; más satura el Mac.
- **Formato:** biome solo sobre archivos tocados.
- **Antes de cada subida:**
  - `npx tsc --noEmit -p .` en apps/web y packages/agent-tools;
  - las pruebas de las áreas tocadas.
- **Fallos que ya existían** (no son nuevos): unchecked-reads, auth-signup, mandates/revocation, ChoicePrompt, commitments/isolation.
- Cambiar descripciones de herramientas obliga a volver a medir `packages/agent-tools/src/evaluation` con `EVAL_MEASURE=1` (unos 20 min por el plan gratuito de Voyage).
- **Docs:** documentar en `docs/features/apps.md` al terminar cada fase.
