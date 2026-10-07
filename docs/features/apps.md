# Aplicaciones

Un conjunto de pantallas con menú y roles, armado sobre las mismas tablas (`trackers`) y vistas que ya usa la empresa. El operario de planta ve «Registrar» y «Mis registros» (sólo sus filas), el supervisor aprueba, gerencia mira el tablero y exporta. Migración `0208_custom_apps.sql`. Plan completo: [docs/plans/aplicaciones.md](../plans/aplicaciones.md).

Estado: **fase 1** (miembros de Cortex con rol). Usuarios externos con código por correo, instalable (PWA) y automatizaciones son las fases 2 y 3.

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

## Pruebas

- `src/apps/__tests__/permissions.test.ts`: reglas puras.
- `src/apps/__tests__/isolation.test.ts`: dos empresas con datos gemelos; empresa A no lee B, el operario sólo ve lo suyo (tablas y cifras), rol sin pantalla = 404, operario no aprueba ni escribe campos ajenos ni edita filas ajenas, y las pantallas no se abren por la puerta de las vistas.

## Pendiente (fases siguientes)

- Fase 2: usuarios externos (`custom_app_users`, sesiones, código por correo), manifiesto e íconos por app, service worker con alcance, `created_by_app_user`.
- Fase 3: automatizaciones y Web Push.
- `apps.update/publish/invite_users/design` en el chat; medir de nuevo `src/evaluation` al cambiar descripciones de herramientas (`EVAL_MEASURE=1`).
