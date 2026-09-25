# Vistas

Pantallas a la medida sobre las tablas de la empresa (`trackers`, migración 0115): tableros, portales y formularios. Se piden y se cambian escribiendo, sin desarrolladores. Migración `0156_custom_views.sql`.

## Qué es una vista

Un spec JSON declarativo con 1–24 bloques. No hay HTML ni código generado: por eso una vista puede abrirse desde afuera.

| Bloque | Qué hace |
|---|---|
| `text` | Markdown (sin imágenes ni HTML). |
| `metric` | count/sum/avg/min/max sobre una tabla, con filtros, formato y meta opcional. |
| `table` | Columnas elegidas, orden, buscador y orden por columna en el navegador. |
| `chart` | Barras, línea (por día/semana/mes) o dona. |
| `board` | Tablero por un campo de opciones. |
| `form` | Agrega una fila a la tabla. Sólo escribe los campos que el bloque pide. |

Filtros: `eq`, `neq`, `contains`, `gt/gte/lt/lte`, `empty`, `not_empty`, `before_today`, `after_today`, `next_days`, `last_days` (hoy en Bogotá). Anchos `full`/`half`/`third` en una rejilla de 6 columnas; en móvil todo es ancho completo.

Código: `packages/agent-tools/src/views/` — `spec.ts` (contrato y comprobación contra el catálogo), `compute.ts` (spec + filas → bloques resueltos, puro), `store.ts` (lectura/escritura, contraseñas, enlaces, formularios), `tools.ts`.

## Cómo se crea y se edita

- **En /views**: se describe la vista; `/api/views/design` devuelve un borrador con vista previa calculada con datos reales. Se puede seguir afinando con otra frase. Nada se guarda sin «Crear vista» / «Guardar cambios». Si faltan datos, el diseñador puede proponer hasta 2 tablas nuevas, que se crean al guardar (nunca modifica una tabla existente).
- **En /views/<slug>**: la barra de abajo («Pídele un cambio a Cortex») edita la vista con texto.
- **En el chat**: `views.list`, `views.get`, `views.create`, `views.update`, `views.share`, `views.archive`.
- Cada guardado es una versión (`custom_view_versions`) con la frase que la produjo. Restaurar copia una versión vieja como nueva. Las ediciones simultáneas no se pisan: la segunda recibe un conflicto.

## Quién la ve

| Puerta | Acceso |
|---|---|
| `workspace` | Miembros del espacio, dentro de la app. |
| `link` | `/v/<token>` sin cuenta; vencimiento opcional (7/30/90 días o nunca). |
| `password` | El enlace más una contraseña (scrypt). Queda recordada 12 h en una cookie firmada, atada a la huella del hash vigente: cambiar la contraseña invalida las cookies. |

- `pinned` la muestra en Inicio (hasta 3 vistas, sin formularios, 6 bloques máximo).
- Crear y editar: cualquier miembro. Compartir, contraseña y archivar: quien la creó o un `org_admin`.
- `views.share` exige confirmación humana siempre (`mandatory-confirmation.ts`). La contraseña no se puede poner desde el chat (quedaría en la auditoría).
- Fuerza bruta: `custom_view_reserve_unlock` gasta el intento bajo candado antes de comparar; a los 10 fallos la vista se cierra 15 minutos.
- Formularios públicos: tope de 60 envíos por hora por vista, registrados en `custom_view_submissions`.
- `/v`, `/api/views/public/*` están en `PUBLIC_PATHS`. `lib/views/public.ts` es el único archivo de vistas con el cliente de servicio sin alcance (búsqueda por token); todo lo demás se lee con el handle del espacio de la vista.

## Límites

- Cada vista lee hasta 2.000 filas por tabla; si hay más, las cifras se marcan como parciales.
- Sólo lee tablas inventadas (`trackers`). Clientes, cartera, vencimientos y demás módulos todavía no son fuente de bloques.
- Los datos se calculan al abrir; no hay refresco en vivo mientras la página está abierta.
- El diseñador consume una respuesta del plan por cada petición (más un reintento interno si su primer borrador no cuadra con el catálogo).

## Verificación

- `packages/agent-tools/src/views/views.test.ts`: contrato, cálculo, filtros de fecha, tablero, columnas, bloques rotos y scrypt.
- `scripts/test-views-sql.mjs` (PGlite): CHECK de las puertas, slugs por espacio y el candado de intentos. `PGLITE_MODULE=<ruta> node scripts/test-views-sql.mjs`.
- `apps/web/lib/shared-links-public-paths.test.ts`: las rutas públicas siguen en el middleware.
- QA visual con datos de mentira en escritorio, 375 px y el tema oscuro de la app. Sin prueba autenticada end-to-end contra una base con la 0156 aplicada.
