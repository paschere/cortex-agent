# Vistas

Pantallas a la medida sobre las tablas de la empresa (`trackers`, migración 0115) y, en sólo lectura, sobre las tablas propias de la plataforma (ventas, pagos, clientes, vencimientos…; ver [Fuentes de la plataforma](#fuentes-de-la-plataforma)) y sobre las tablas del Feed y las activaciones de quien mira (ver [Feed, activaciones y operación](#feed-activaciones-y-operación)): tableros, portales y formularios. Se piden y se cambian escribiendo, sin desarrolladores. Migración `0156_custom_views.sql`.

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

Código: `packages/agent-tools/src/views/` — `spec.ts` (contrato y comprobación contra el catálogo), `compute.ts` (spec + filas → bloques resueltos, puro), `sources.ts` (registro de fuentes de la plataforma), `feed-sources.ts` (tablas del Feed: ids, encabezados → campos, lectura con dueño), `store.ts` (lectura/escritura, contraseñas, enlaces, formularios), `tools.ts`.

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
| `cortex.activaciones` | Simulaciones y publicaciones de Activaciones (`activation_runs`, 0148) **de quien mira**. | `fecha`, `estado` (Simulada/Publicada), `regla` (Facturas duplicadas/Duplicados/Condiciones), `origen` (Manual/Seguimiento), `fuente`, `hoja`, `filas`, `coincidencias`, `invalidas`, `asuntos`, `publicada` | **personal** |
| `cortex.seguimientos` | Reglas autorizadas para revisar solas (`activation_automations`, 0151) de quien mira. | `estado` (Activa/En pausa/Necesita revisión), `disparador`, `frecuencia`, `fuente`, `ultima_revision`, `proxima_revision`, `resultado` (Sin cambios/Revisada/Necesita revisión/Error), `coincidencias`, `asuntos_nuevos`, `mensaje` | **personal** |
| `cortex.operaciones` | Acciones externas comprobadas (`activation_operations`, 0153) de quien mira. Nunca lee la entrada, la respuesta ni la evidencia. | `estado` (los 9 de Activaciones), `verificacion` (Comprobada/No coincidió/Incierta/En curso/Sin comprobar), `accion`, `verificador`, `asunto`, `intentos`, `creada`, `terminada`, `duracion_s`, `error` | **personal** |
| `cortex.rutinas` | Corridas de rutinas (`scheduled_job_runs`): las propias y las globales, lo mismo que /schedules. Sin salida ni instrucción. | `estado` (En curso/Correcta/Con error), `inicio`, `duracion_s`, `tipo` (Herramienta/Agente), `alcance` (Mía/De todo el equipo), `rutina_estado`, `error` | **personal** |

**«Ventas» son facturas de venta confirmadas.** No hay una tabla de ventas ni de negocios propia (los negocios de HubSpot se consultan en vivo y no se guardan). La cartera es `cortex.ventas` con su `saldo` y su `estado`.

**El dinero `money` es siempre pesos.** Una factura o un pago en otra moneda no entra en los campos `money` (se pintarían como COP y se sumarían con pesos): su importe va a `total_otra_moneda` / `valor_otra_moneda`, junto a `moneda`.

**Sólo lectura.** Un bloque `form` sobre una fuente de la plataforma se rechaza al guardar (`checkSpecAgainst`), se pinta como aviso si llega por otro camino (`computeView`) y `submitViewForm` lo niega.

**Regla de compartir.** Una vista que usa una fuente **interna** (nombra gente del equipo o su trabajo interno), una **personal** o una tabla del Feed (ver abajo) no se puede poner en `link` ni `password`:

- `setViewAccess` lo rechaza con un `ValidationError` en español, sea quien sea quien lo pida (también un administrador, también `views.share` desde el chat). Fijarla en Inicio sí se puede.
- `updateView` (y restaurar una versión) no deja que una vista ya compartida empiece a usar una fuente interna: primero hay que dejar de compartirla.
- Segunda llave: la página pública `/v/<token>` carga con `loadViewSources(..., { audience: 'public' })`, que NO LEE las fuentes internas aunque el spec las nombre; sus bloques salen como aviso.
- La pantalla de compartir muestra el motivo y deshabilita las puertas de afuera.

El catálogo (`viewCatalog`) incluye las fuentes con `kind: 'platform'`, su `sensitivity` y `rowCount: null` (no se cuentan). El diseñador de /views recibe sus campos y hasta 3 filas de muestra, igual que las tablas; `SPEC_GRAMMAR` de las herramientas se genera del registro.

Fuera a propósito: `vehicles` (es por persona, no del espacio: una vista de toda la empresa mostraría los carros personales de cada quien), nómina y personas (datos personales), y documentos del cerebro (tienen permisos por espacio que una vista no respeta).

## Feed, activaciones y operación

Una vista también puede mirar lo que cada persona tiene en su [Feed](feed.md) y lo que sus [Activaciones](activations.md) hicieron con eso. Todo es de sólo lectura (el mismo `isReadOnlySource` que rechaza formularios, celdas editables, tableros que se arrastran y botones).

### Tablas del Feed

Tercera familia de ids, que no choca con slugs ni con `cortex.*`:

| Id | Qué es |
|---|---|
| `feed.<uuid de la captura>.<hoja 0–19>` | Una hoja de una captura fija (archivo, texto, URL). Vence con la captura. |
| `feedsrc.<uuid de la conexión>.<hoja>` | Una hoja de la **última** captura de una fuente conectada (Google Sheets, API, cruce; 0150/0152). La vista sigue a la conexión: cuando la fuente se sincroniza, el siguiente refresco en vivo de la vista ya la muestra. |
| `feedview.<uuid de la vista preparada>` | La tabla con citas que Cortex preparó de un texto (0149). Desaparece con su captura. |

- **Campos desde los encabezados.** La fila 1 es el encabezado (lo mismo que asume Activaciones). Clave = encabezado sin tildes en `minúsculas_con_guion_bajo`, 28 caracteres, sin repetir (`_2`, `_3`), y nunca `label`/`created_at`/`updated_at` (se les pone `_hoja`). Tipo inferido con prudencia sobre las filas leídas: `number` si todas las celdas con algo son números (una celda «00123» es un código: texto); `money` si además el encabezado habla de plata y la hoja no declara otra moneda en una columna «Moneda» (regla de pesos de `sources.ts`); `date` si todas son AAAA-MM-DD o DD/MM/AAAA (día primero); `select` (sirve para tableros) con hasta 12 categorías repetidas o un encabezado de estado/tipo/etapa; si no, `text`. Hasta 40 columnas.
- **Filas.** Las de la hoja salvo el encabezado y las vacías, hasta 2.000; una captura que el Feed ya cortó (`feed_truncated`) también sale como parcial. `id` = fuente + número de fila; `label` = la primera columna de texto; `created_at`/`updated_at` = la hora de la captura.
- **Vencidas o borradas.** El bloque se pinta como aviso con la razón («venció», «la hoja ya no está», «la fuente se desconectó», «no tiene una lectura vigente»). Una captura pasado su `purge_at` no se lee aunque la fila siga en la base.

### La regla de privacidad

**Una tabla del Feed sólo muestra filas a su dueño, siempre — también las fuentes conectadas.** Por qué: todo el Feed es de quien lo subió (`ownedFeed`, `readOwnedTableSources`, `readOwnedPreparedViews`, `feed_sources.actor_id` en cada ruta), y la conexión durable sigue siendo de una persona, con capturas temporales. El único camino por el que algo del Feed llega al equipo es publicar una activación: filas concretas, revisadas y confirmadas, que viajan como asuntos de Gerencia. Una vista es del espacio y puede tener enlace; si leyera el Feed de su autor para quien la abra, sería una puerta que el Feed nunca tuvo. Se eligió lo conservador:

| Quién abre | Qué ve en un bloque sobre una tabla del Feed |
|---|---|
| Su dueño, dentro de Cortex | Las filas. |
| Un compañero, dentro de Cortex | «Esta tabla viene del Feed privado de otra persona…». No viaja ni el nombre del archivo. |
| El enlace público `/v/<token>` | «…no se muestra fuera de Cortex». |
| Un llamador que no dice quién mira | «…ábrela dentro de Cortex». |

- `loadViewSources(db, spec, { viewerId })` lee **con el id de quien mira**, nunca con el de quien hizo la vista. Primero lee sólo metadata (dueño y vencimiento); el contenido se pide después filtrado por dueño y vigencia: el contenido de otra persona ni se pide a la base (hay una prueba que lo verifica).
- Una vista con una tabla del Feed **no se comparte por enlace ni con contraseña** (`internalSourcesOf` la cuenta como «tablas del Feed privado»; `setViewAccess` y `updateView` lo rechazan), y `audience: 'public'` no la lee.
- **Diseñar:** el catálogo del diseñador (`viewCatalog(db, { viewerId })`) trae sólo las tablas del Feed de quien pide (las 24 más recientes: conexiones por su última lectura, capturas sueltas que no son de una conexión, vistas preparadas vigentes) con sus campos y tres filas de muestra.
- **Editar la vista de otro:** al guardar, `validateSpec(db, spec, { viewerId, keep })` comprueba las tablas del Feed de quien guarda. Las que la versión guardada ya usaba y esta persona no puede leer (el Feed de otro, una captura vencida) entran como `opaque`: se conservan sin abrirlas ni comprobar campos, para que un compañero pueda cambiar el resto de la vista. No se pueden **agregar** tablas del Feed ajenas.
- Para mostrarle esos datos al equipo o a un cliente, el camino es copiarlos a una tabla del espacio (decisión explícita), no abrir el Feed.

### Activaciones, seguimientos, operaciones y rutinas

`cortex.activaciones`, `cortex.seguimientos`, `cortex.operaciones` y `cortex.rutinas` (tabla de arriba) son `personal`: como en sus pantallas, cada quien ve **lo suyo** (`actor_id` = quien mira; en rutinas, las propias y las globales). Un tablero de «mi operación» abierto por un compañero muestra la operación de ese compañero. Sin `viewerId` no se leen (`PERSONAL_SOURCE_NO_VIEWER`), afuera tampoco (`PERSONAL_SOURCE_BLOCKED`), y no se comparten por enlace. Lo que sí es de la empresa —los asuntos que una activación publicó— está en `cortex.gestion`.

Quedaron fuera: notificaciones y auditoría (poco valor para un tablero frente a lo que ya dicen activaciones/operaciones, y nombran gente).

Los llamadores pasan `viewerId`: la página de la vista, `/api/views/[id]/data` (refresco en vivo), Inicio (`PinnedViews`), el diseñador, `saveViewAction` y las herramientas `views.create`/`views.update`. La página pública y `/api/views/public/data` no lo pasan.

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

## Editar, botones, en vivo y avisos (0160)

- **En vivo:** `spec.refreshSeconds` (0, 10, 30 o 60; por defecto 30). La vista abierta se recalcula sola mientras la pestaña está visible y después de cada cambio. Es sondeo, no un canal en tiempo real.
- **Edición** (sólo tablas propias): `table.editable` (celdas que se editan en el sitio) y `board.draggable` (arrastrar una tarjeta cambia su campo de opciones; en el teléfono, un menú). Cada cambio se valida con el esquema de la tabla sobre la fila completa.
- **Botones por fila:** `set_field` (pone el valor que dice el spec, nunca uno enviado por el navegador) y `notify` (avisa en la campana a quien creó la vista y a los administradores). Máximo 3 por bloque.
- **Quién escribe:** `spec.editing` = `off` (por defecto), `team` (sólo dentro de la app) o `public` (también quien tenga el enlace, con la contraseña si la vista la pide). Desde afuera hay un tope de 120 cambios por hora por vista.
- **Rastro:** cada edición, movimiento o botón queda en `custom_view_events` con qué cambió, en qué fila y quién (null = alguien con el enlace).
- **Avisos:** `spec.alerts` (hasta 5). Cuando aparece una fila nueva que cumple los filtros mientras la vista está abierta: aviso en pantalla, sonido y, si la persona lo permite, notificación del sistema. El sonido se activa con «Activar avisos» (los navegadores exigen un clic). `bell` suena además en la campana de quien creó la vista cuando entra una fila por un formulario de esa vista, esté o no abierta.
- Todo se configura con texto en el diseñador («que se pueda cambiar el estado arrastrando», «que suene cuando entre una factura de más de 5 millones»).

## Límites

- Cada vista lee hasta 2.000 filas por tabla; si hay más, las cifras se marcan como parciales.
- Las fuentes de la plataforma son de sólo lectura y fijas (el registro de `sources.ts`); no se pueden filtrar en la base, se filtran en memoria sobre las filas leídas como una tabla inventada.
- Los datos se recalculan al abrir y, mientras la pestaña está visible, cada `refreshSeconds` (sondeo). Una vista sobre `feedsrc.*` cambia cuando la fuente conectada se sincroniza, no antes: la frecuencia la pone la fuente en Feed.
- `cortex.activaciones` lee las 100 simulaciones más recientes (cada una trae hasta mil candidatos que hay que leer para contarlos); si hay más, sale parcial.
- Las tablas del Feed se leen enteras desde `feed_tables` (JSON de la captura, hasta 50.000 celdas) en cada refresco; no hay índice ni filtro en la base.
- El diseñador consume una respuesta del plan por cada petición (más un reintento interno si su primer borrador no cuadra con el catálogo).

## Verificación

- `packages/agent-tools/src/views/views.test.ts`: contrato, cálculo, filtros de fecha, tablero, columnas, bloques rotos y scrypt.
- `packages/agent-tools/src/views/sources.test.ts`: ids que no chocan con slugs de tabla, campos válidos, contrato con fuentes (y formularios rechazados), lectores contra un PostgREST de mentira con dos espacios (ventas con saldo y mora, dólares fuera de `money`, pagos en disputa fuera, vencimientos vs. compromisos internos, tope parcial) y la regla de compartir (`setViewAccess`, `updateView`, `audience: 'public'`).
- `packages/agent-tools/src/views/feed-sources.test.ts`: ids del Feed (armar/desarmar, no chocan, la forma rechaza parecidos), encabezados → claves y tipos (dinero sólo en pesos, códigos como texto, fechas día primero), filas y tope parcial, contrato (sólo lectura, no disponible, opacas), y contra un PostgREST de mentira con dos personas y dos espacios: el dueño ve, el compañero ve el aviso sin que se pida el contenido, público y sin `viewerId` no leen, vencidas/borradas/de otro espacio, la conexión sigue su última lectura, vista preparada, compartir rechazado, catálogo sólo del que pregunta, `validateSpec` con `keep`, y las cuatro fuentes personales (cada quien lo suyo; rutinas propias + globales).
- `scripts/test-views-sql.mjs` (PGlite): CHECK de las puertas, slugs por espacio y el candado de intentos. `PGLITE_MODULE=<ruta> node scripts/test-views-sql.mjs`.
- `apps/web/lib/shared-links-public-paths.test.ts`: las rutas públicas siguen en el middleware.
- QA visual con datos de mentira en escritorio, 375 px y el tema oscuro de la app. Sin prueba autenticada end-to-end contra una base con la 0156 aplicada.
