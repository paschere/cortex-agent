# Vistas

Pantallas a la medida sobre las tablas de la empresa (`trackers`, migración 0115) y, en sólo lectura, sobre las tablas propias de la plataforma (ventas, pagos, clientes, vencimientos…; ver [Fuentes de la plataforma](#fuentes-de-la-plataforma)): tableros, portales y formularios. Se piden y se cambian escribiendo, sin desarrolladores. Migración `0156_custom_views.sql`.

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

Código: `packages/agent-tools/src/views/` — `spec.ts` (contrato y comprobación contra el catálogo), `compute.ts` (spec + filas → bloques resueltos, puro), `sources.ts` (registro de fuentes de la plataforma), `store.ts` (lectura/escritura, contraseñas, enlaces, formularios), `tools.ts`.

## Fuentes de la plataforma

Un bloque nombra su origen en `tracker`: el slug de una tabla inventada (`remates`) o el id de una fuente de la plataforma (`cortex.ventas`). El punto no cabe en un slug de tabla (`^[a-z][a-z0-9_]{1,47}$`), así que las dos familias no chocan nunca. El campo se sigue llamando `tracker` para que los specs guardados no cambien.

Las fuentes se leen con el handle del espacio, por las funciones de cada módulo cuando existen, con sus mismos filtros de verdad, y con el mismo tope de 2.000 filas (los pagos, 1.000: el tope de `listPayments`). Sus campos tienen la forma de los de una tabla (`key`, `label`, `type`, `options`). Además, toda fila trae `label`, `created_at` y `updated_at`.

| Id | Qué es | Campos | Sensibilidad |
|---|---|---|---|
| `cortex.ventas` | Facturas de venta **confirmadas** y clasificadas como por cobrar (0076 + 0143), con lo cobrado por pagos que cuentan enlazados a esa factura en su moneda. `label` = número de factura. | `numero`, `cliente`, `nit`, `emitida` (date), `vence` (date), `total`, `iva`, `pagado`, `saldo` (money COP), `estado` (Por cobrar/Vencida/Pagada), `dias_mora`, `moneda`, `total_otra_moneda` | compartible |
| `cortex.pagos` | Pagos que cuentan (reportados o confirmados); los que están en disputa o descartados no están, igual que en la cartera. | `fecha` (date), `cliente`, `factura`, `tipo` (Abono/Anulación/Ajuste), `estado` (Reportado/Confirmado), `valor` (money COP, la anulación resta), `moneda`, `valor_otra_moneda`, `fuentes` | compartible |
| `cortex.clientes` | Clientes registrados (0075). Sin responsable interno, teléfonos, dirección ni notas. | `razon_social`, `nit`, `estado` (Prospecto/Activo/Sin movimiento/Ex cliente/Bloqueado), `ciudad`, `departamento`, `servicios`, `plazo_pago`, `cupo` (money), `cliente_desde` (date) | compartible |
| `cortex.vencimientos` | Vencimientos confirmados con terceros (SOAT, tecnomecánica, contratos, pólizas, aduana, pagos…), sin los compromisos internos. Estado del día (`deriveState`). | `tipo`, `contraparte`, `vence` (date), `estado` (Vigente/Por vencer/Vencido/Cumplido/Descartado), `dias`, `valor` (money), `cumplido` (date) | compartible |
| `cortex.metas` | Una fila por meta activa y período medido (0101). | `periodo` (date), `valor`, `objetivo`, `estado` (Cumplida/Incumplida/Sin datos), `cadencia`, `unidad` | compartible |
| `cortex.compromisos` | Compromisos internos entre compañeros (0097). | `responsable`, `vence`, `estado`, `dias`, `cumplido`, `detalle` | **interna** |
| `cortex.gestion` | Asuntos de Gerencia (0130). | `estado` (Por organizar/En gestión/Bloqueado/Por verificar/Cerrado con evidencia/Descartado), `impacto` (Alto/Medio/Bajo), `responsable`, `vence`, `revision`, `siguiente_paso`, `bloqueo` | **interna** |
| `cortex.prospectos` | Oportunidades de Crecimiento (`growth_signals`). Nunca lee nombre, correo ni canal de contacto. | `estado` (Nueva/Calificada/Descartada/Contactada), `industria`, `senal`, `cargo`, `region`, `fuente` | **interna** |

**«Ventas» son facturas de venta confirmadas.** No hay una tabla de ventas ni de negocios propia (los negocios de HubSpot se consultan en vivo y no se guardan). La cartera es `cortex.ventas` con su `saldo` y su `estado`.

**El dinero `money` es siempre pesos.** Una factura o un pago en otra moneda no entra en los campos `money` (se pintarían como COP y se sumarían con pesos): su importe va a `total_otra_moneda` / `valor_otra_moneda`, junto a `moneda`.

**Sólo lectura.** Un bloque `form` sobre una fuente de la plataforma se rechaza al guardar (`checkSpecAgainst`), se pinta como aviso si llega por otro camino (`computeView`) y `submitViewForm` lo niega.

**Regla de compartir.** Una vista que usa una fuente **interna** (nombra gente del equipo o su trabajo interno) no se puede poner en `link` ni `password`:

- `setViewAccess` lo rechaza con un `ValidationError` en español, sea quien sea quien lo pida (también un administrador, también `views.share` desde el chat). Fijarla en Inicio sí se puede.
- `updateView` (y restaurar una versión) no deja que una vista ya compartida empiece a usar una fuente interna: primero hay que dejar de compartirla.
- Segunda llave: la página pública `/v/<token>` carga con `loadViewSources(..., { audience: 'public' })`, que NO LEE las fuentes internas aunque el spec las nombre; sus bloques salen como aviso.
- La pantalla de compartir muestra el motivo y deshabilita las puertas de afuera.

El catálogo (`viewCatalog`) incluye las fuentes con `kind: 'platform'`, su `sensitivity` y `rowCount: null` (no se cuentan). El diseñador de /views recibe sus campos y hasta 3 filas de muestra, igual que las tablas; `SPEC_GRAMMAR` de las herramientas se genera del registro.

Fuera a propósito: `vehicles` (es por persona, no del espacio: una vista de toda la empresa mostraría los carros personales de cada quien), nómina y personas (datos personales), y documentos del cerebro (tienen permisos por espacio que una vista no respeta).

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
- Las fuentes de la plataforma son de sólo lectura y fijas (el registro de `sources.ts`); no se pueden filtrar en la base, se filtran en memoria sobre las filas leídas como una tabla inventada.
- Los datos se calculan al abrir; no hay refresco en vivo mientras la página está abierta.
- El diseñador consume una respuesta del plan por cada petición (más un reintento interno si su primer borrador no cuadra con el catálogo).

## Verificación

- `packages/agent-tools/src/views/views.test.ts`: contrato, cálculo, filtros de fecha, tablero, columnas, bloques rotos y scrypt.
- `packages/agent-tools/src/views/sources.test.ts`: ids que no chocan con slugs de tabla, campos válidos, contrato con fuentes (y formularios rechazados), lectores contra un PostgREST de mentira con dos espacios (ventas con saldo y mora, dólares fuera de `money`, pagos en disputa fuera, vencimientos vs. compromisos internos, tope parcial) y la regla de compartir (`setViewAccess`, `updateView`, `audience: 'public'`).
- `scripts/test-views-sql.mjs` (PGlite): CHECK de las puertas, slugs por espacio y el candado de intentos. `PGLITE_MODULE=<ruta> node scripts/test-views-sql.mjs`.
- `apps/web/lib/shared-links-public-paths.test.ts`: las rutas públicas siguen en el middleware.
- QA visual con datos de mentira en escritorio, 375 px y el tema oscuro de la app. Sin prueba autenticada end-to-end contra una base con la 0156 aplicada.
