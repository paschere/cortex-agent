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
| `zones` | Plano: cada opción es una zona dibujada en una rejilla de 12×12. |
| `form` | Agrega una fila a la tabla. Sólo escribe los campos que el bloque pide. |
| `gallery` | Tarjetas en rejilla (2–4 columnas): título, subtítulo, hasta 3 datos, etiqueta de color (campo de opciones, color por posición) y foto (campo de texto con una dirección `https:`). |
| `calendar` | `month`: cuadrícula del mes (el cálculo entrega mes anterior, actual y siguiente; se navega sin pedir datos). `agenda`: los próximos `days` días. Color por un campo de opciones. Tope de 300 eventos. |
| `progress` | Barras de avance: una sola contra `target`, o una por grupo contra su meta en `targets` (o la común). Sin metas, relativas a la más grande. |
| `media` | Imagen `https:` o inserción SÓLO de YouTube, Loom, Google Maps («Insertar un mapa»), Google Slides/Docs publicados (`embeds.ts`). Nunca HTML. |
| `links` | Botones de navegación (hasta 8): ruta interna (`/views/…`) o `https:`. |

`metric` también puede comparar con el período anterior: `compare: 'previous_period'`, `period` (`day`/`week`/`month`), `dateField` y `goodWhen` (`up`/`down`: el color de la flecha dice si el cambio es bueno). La cifra pasa a ser la del período, con delta y una línea de los últimos 10–12 períodos.

Filtros: `eq`, `neq`, `contains`, `gt/gte/lt/lte`, `empty`, `not_empty`, `before_today`, `after_today`, `next_days`, `last_days` (hoy en Bogotá). Anchos `full`/`half`/`third` en una rejilla de 6 columnas; en móvil todo es ancho completo.

Código: `packages/agent-tools/src/views/` — `spec.ts` (contrato y comprobación contra el catálogo), `compute.ts` (spec + filas → bloques resueltos, puro), `sources.ts` (registro de fuentes de la plataforma), `feed-sources.ts` (tablas del Feed: ids, encabezados → campos, lectura con dueño), `store.ts` (lectura/escritura, contraseñas, enlaces, formularios), `tools.ts`.

## Ficha, barra de filtros, páginas y aspecto

**Ficha de una fila.** En `table`, `board`, `zones`, `gallery` y `calendar`, tocar una fila abre un panel (hoja inferior en el teléfono) con sus campos, los editables, sus botones y sus fechas. Por bloque: `openRecord: false` la apaga, `detailFields` (≤16) elige los campos, `recordEditable` (≤12, sólo tablas propias, exige `editing`) los que se editan ahí. Los datos viajan con el cálculo (`block.record`), sólo para las filas que el bloque muestra y sólo los campos declarados: no hay ruta nueva que repita las puertas (sesión/token, contraseña, fuentes internas/personales, Feed sólo del dueño) ni una consulta por clic. Por defecto: dentro del equipo, todos los campos de una tabla propia (los primeros 8 de una fuente de sólo lectura); **por enlace (`audience: 'public'`), sólo los que el bloque ya pinta**, para que una vista ya compartida no empiece a mostrar más campos afuera. Escribir desde la ficha pasa por `editViewRow` con la lista blanca `blockWriteFields` (celdas + campo que se arrastra + `recordEditable`).

**Barra de filtros** (`spec.filtersBar`, ≤6): `{id, label, source, field, kind: select|date_range|search}`. Filtra en el servidor todos los bloques (y avisos) que leen esa fuente. El navegador manda `?f=` (una query `id=valor&…` codificada; rango `desde~hasta`) a `/api/views/[id]/data` y `/api/views/public/data`; `parseViewFilterParam` lo valida contra el spec guardado y descarta lo demás. `LiveViewCanvas` lo deja en la dirección para compartir la vista filtrada; `/v/<token>?f=…` abre ya filtrada. La fuente tiene que estar en algún bloque y el rango, sobre una fecha (`checkSpecAgainst`).

**Páginas** (`spec.pages`, ≤8): pestañas sobre la misma lista de bloques; un bloque puede estar en varias y el que no está en ninguna sale en la primera. La elegida va en `?p=`. Sin páginas, una sola.

**Aspecto** (`spec.theme`): `accent` (los cinco tonos; si falta, `spec.accent`), `density` (`comfortable`/`compact`), `header` (`plain`/`hero`: banda con título, subtítulo y `cover` https). Sólo tokens. La portada (`ViewCover`: logo y nombre de la empresa, título, subtítulo, «En vivo · hace X», avisos, «Imprimir» y la barra de la vista en `actions`) la pinta `LiveViewCanvas` cuando recibe `heading`, adentro y en el enlace público; quien lo monta no pinta su propio título.

**Marca de la empresa (0170).** `company_branding` (una fila por empresa: `display_name`, `primary_color`, `secondary_color` en `#rrggbb`, `logo_path` en `app_files` bucket `branding`, `logo_version`). Se edita en /company («La marca», sólo administradores, vista previa en vivo con los mismos componentes del lienzo; el logo se reduce a PNG de 512 px en el navegador y propone sus colores; el servidor vuelve a validar tamaño y tipo por los primeros bytes, sin SVG). La marca es el acento por defecto de toda vista: `ViewBrandProvider` + `.cortex-brand` reasignan `--primary*` dentro de la vista con el contraste resuelto en `lib/branding/colors.ts` (textos ≥ 4.5:1 y 7:1, en claro y oscuro; botones con el color tal cual y el texto que mejor se lee). Una vista que elige otro tono en `theme.accent` lo conserva. Sin marca, el índigo de Cortex. El logo se sirve por `/api/branding/logo` (sesión) y `/api/views/public/logo?token=` (sólo el de la empresa dueña de esa vista). Impresión/PDF: `components/views/views.css` (`@media print`) oculta controles, conserva colores y deja «Datos al …». Escaparate de desarrollo: `/v/views-showcase` (`?modo=oscuro`, `?marca=amarilla|ninguna`, `?portada=1`, `?paginas=1`, `?vacia=1`, `?lugar=app`, `?panel=marca|cargando`).

Todo lo nuevo es opcional y sin valores por defecto en el contrato: los specs guardados no cambian ni de forma ni de tipo. Código: `embeds.ts` (direcciones), `view-filters.ts` (parámetro `f`), `compute.ts` (bloques, ficha, barra, páginas, tema); en web, `components/views/blocks/*`.

## Fuentes de la plataforma

Un bloque nombra su origen en `tracker`: el slug de una tabla inventada (`remates`) o el id de una fuente de la plataforma (`cortex.ventas`). El punto no cabe en un slug de tabla (`^[a-z][a-z0-9_]{1,47}$`), así que las dos familias no chocan nunca. El campo se sigue llamando `tracker` para que los specs guardados no cambien.

Las fuentes se leen con el handle del espacio, por las funciones de cada módulo cuando existen, con sus mismos filtros de verdad, y con el mismo tope de 2.000 filas (los pagos, 1.000: el tope de `listPayments`). Sus campos tienen la forma de los de una tabla (`key`, `label`, `type`, `options`). Además, toda fila trae `label`, `created_at` y `updated_at`.

| Id | Qué es | Campos | Sensibilidad |
|---|---|---|---|
| `cortex.ventas` | Facturas de venta **confirmadas** y clasificadas como por cobrar (0076 + 0143), con lo cobrado por pagos que cuentan enlazados a esa factura en su moneda. `label` = número de factura. | `numero`, `cliente`, `nit`, `emitida` (date), `vence` (date), `total`, `iva`, `pagado`, `saldo` (money COP), `estado` (Por cobrar/Vencida/Pagada), `dias_mora`, `moneda`, `total_otra_moneda` | compartible |
| `cortex.pagos` | Pagos que cuentan (reportados o confirmados); los que están en disputa o descartados no están, igual que en la cartera. | `fecha` (date), `cliente`, `factura`, `tipo` (Abono/Anulación/Ajuste), `estado` (Reportado/Confirmado), `valor` (money COP, la anulación resta), `moneda`, `valor_otra_moneda`, `fuentes` | compartible |
| `cortex.cartera` | Cartera vencida = «plata en riesgo»: las facturas por cobrar vencidas con saldo, las confirmadas a mano **y** las de Siigo/Alegra/QuickBooks (`accounting_invoices`, 0165), contadas una vez (`overdueReceivableInvoices`, la misma lista que `moneyAtRisk`). | `numero`, `cliente`, `vence` (date), `dias_mora`, `tramo` (1 a 30/31 a 60/61 a 90/Más de 90 días), `saldo` (money COP), `moneda`, `saldo_otra_moneda`, `origen` (Documento confirmado/Siigo/Alegra/QuickBooks/Otro programa) | compartible |
| `cortex.recuperado` | Plata recuperada con Cortex (`moneyRecovered`, 0166): una fila por movimiento atribuido (pago, devolución que resta, baja de saldo) y una por lo manual verificado en Gerencia, con su día. | `fecha` (date), `cliente`, `factura`, `valor` (money COP), `moneda`, `valor_otra_moneda`, `accion` (qué hizo Cortex), `tipo` (Pago/Devolución/Baja de saldo/Manual) | **interna** (lo manual lleva el título de un asunto) |
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

### Fuentes de los módulos (0181–0197)

Cada módulo de operación tiene su fuente de sólo lectura (`packages/agent-tools/src/views/module-sources.ts`; `cortex.estados` y `cortex.presupuesto` viven en `statements/view-sources.ts`). **Todas son `internal`**: una vista que las usa no se comparte por enlace ni con contraseña.

| Fuente | Módulo | Qué es | Campos | Regla de quién ve |
|---|---|---|---|---|
| `cortex.por_pagar` | `payables` | Facturas de proveedores (`payable_invoices`); lo abierto primero, por vencimiento. | `proveedor`, `numero`, `emision`, `vence`, `dias`, `pagar_el`, `pagada_el`, `estado`, `total`, `neto` (money COP), `total_otra_moneda`, `moneda`, `alertas`, `revision`, `origen` | La revisión: sólo alertas `warn`/`block` (las notas informativas no cuentan). |
| `cortex.inventario` | `inventory` | Productos activos con existencia total (`loadInventoryOverview`); lo que pide atención primero. | `sku`, `categoria`, `unidad`, `existencia`, `minimo`, `faltante`, `reposicion`, `alerta`, `dias_cobertura`, `consumo_diario`, `costo`, `precio`, `valor` (COP), `moneda`, `ultimo_movimiento`, `proveedor` | Costo, precio y valor sólo si el producto está en pesos. |
| `cortex.ordenes_compra` | `inventory` | Órdenes de compra; lo abierto primero. | `proveedor`, `estado`, `creada`, `esperada`, `recibida`, `dias_para_llegar`, `atrasada`, `total`, `total_otra_moneda`, `moneda`, `plazo_dias`, `origen` | — |
| `cortex.impuestos` | `taxes` | Calendario tributario (`tax_obligations`). | `tipo`, `periodo`, `entidad`, `formulario`, `vence`, `dias`, `estado`, `vencida`, `requiere_pago`, `por_confirmar`, `registrada` | Una declaración que se paga no se cumple con presentarla: sigue «vencida» hasta «pagada». |
| `cortex.nomina` | `payroll` | **Sólo totales por período** (`payroll_periods.totals`). | `periodo`, `inicio`, `fin`, `pago`, `frecuencia`, `estado`, `personas`, `devengado`, `deducciones`, `aportes`, `provisiones`, `neto`, `costo_total`, `seguridad_social` | Sólo quien administra la empresa (`isCompanyManager`); a los demás, o sin sesión, el bloque dice `NOMINA_RESTRICTED`. **Nunca lee `employees`, desprendibles ni novedades**: no hay una fila por persona. |
| `cortex.contratos` | `contracts` | Contratos con vigencia (renovaciones automáticas corridas), fecha límite de aviso y próxima obligación confirmada. | `tipo`, `contraparte`, `valor`, `valor_otra_moneda`, `moneda`, `inicio`, `vence`, `dias_para_vencer`, `aviso_hasta`, `dias_para_aviso`, `renovacion`, `estado`, `responsable`, `proxima_obligacion`, `proxima_obligacion_vence`, `obligaciones_pendientes`, `obligaciones_vencidas` | Un contrato laboral (o con alguien del equipo) sólo lo ve quien administra, quien lo creó y su responsable (`canSeeContract`); sus obligaciones tampoco se leen. |
| `cortex.pqrs` | `compliance` | PQRS con plazo legal. | `radicado`, `clase`, `materia`, `canal`, `asunto`, `recibida`, `vence`, `dias_habiles`, `vencida`, `estado`, `responsable`, `respondida` | Nunca trae el cuerpo, la respuesta, ni nombre, correo, teléfono o documento de quien reclama. |
| `cortex.cumplimiento` | `compliance` | Lista de cumplimiento (`compliance_items`). | `area`, `frecuencia`, `periodo`, `vence`, `dias`, `estado`, `vencida`, `aplica`, `por_confirmar`, `base_legal`, `responsable`, `cumplida` | — |
| `cortex.comercial` | `crm` | Oportunidades del embudo, abiertas, ganadas y perdidas. | `cliente`, `etapa`, `estado`, `valor`, `valor_otra_moneda`, `moneda`, `probabilidad`, `ponderado`, `cierre_esperado`, `responsable`, `proximo_paso`, `proximo_paso_vence`, `dias_sin_actividad`, `origen`, `ganada`, `perdida`, `motivo_perdida` | `etapa` usa los nombres del embudo estándar; las etapas propias de la empresa caen en «Sin estado» de un tablero (las opciones de un campo son fijas). `estado` (Abierta/Ganada/Perdida) es estable. |
| `cortex.proyectos` | `service_orders` | Proyectos y órdenes de servicio con las cuentas de `projectMetrics`. | `tipo`, `cliente`, `estado`, `responsable`, `entrega`, `dias_para_entrega`, `avance`, `tareas_tarde`, `horas`, `horas_pct`, `costo`, `presupuesto`, `costo_pct`, `ingreso`, `facturado`, `por_facturar`, `margen`, `margen_pct`, `moneda`, `alerta` | Las cifras en dinero sólo si el proyecto está en pesos. |
| `cortex.flota` | `fleet` | Vehículos de la flota con `loadFleetOverview` (90 días); los que necesitan atención primero. | `vehiculo`, `tipo`, `conductor`, `km`, `costo_km`, `costo_90d`, `km_galon`, `utilizacion`, `mantenimiento`, `mantenimiento_estado`, `mantenimiento_fecha`, `mantenimiento_km`, `soat_vence`, `tecnomecanica_vence`, `documentos_por_vencer`, `comparendos`, `atencion` | — |
| `cortex.documentos_vencen` | `doc_expirations` | Papeles que vencen, **sólo los confirmados** por una persona. | `tipo`, `sujeto`, `clase_sujeto`, `emisor`, `vence`, `dias`, `estado`, `responsable`, `aviso_dias` | Sin título del documento ni cita (el espacio del Cerebro decide quién los ve). |
| `cortex.estados` / `cortex.presupuesto` | `statements` / `budget` | Estados financieros y presupuesto contra lo real (0191). | ver `statements/view-sources.ts` | La nómina va como la ve quien mira (`ledger/privacy.ts`). |

**El interruptor del módulo (0186).** Cada una va envuelta con `withModule(<módulo>, fuente)`: con el módulo apagado, `read` contesta `{ rows: [], blocked: "El módulo X está apagado; un administrador lo prende en Ajustes › Módulos." }` y `loadViewSources` lo pone como `blocked` del bloque (el aviso dice por qué; no es «no se pudo leer»). No se borra nada: al prenderlo la vista vuelve a tener datos. `viewCatalog` las conserva marcadas con `moduleOff` (un spec guardado se sigue validando), el diseñador (`/api/views/design`) y la paleta del lienzo (`editorCatalog`) no las ofrecen salvo que la vista ya las use (entonces el diseñador la recibe `unavailable`). `PlatformSource.module` y `PlatformSourceRead.blocked` son el contrato.

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

- **En /views** (`components/views/gallery/ViewsLibrary.tsx`): la estantería con buscador, filtros (Fijadas / Compartidas / Mías), orden, miniaturas con el acento de cada vista, quién la editó y cuándo, y un menú por tarjeta (abrir, editar, duplicar, fijar, compartir, archivar; las mismas acciones de servidor y reglas que la barra de la vista; «Duplicar» es `duplicateViewAction`, que guarda la misma spec con `saveViewAction`). «Nueva vista» (o `?nueva=1`) abre la galería (`NewViewDialog`): describirla con Cortex, una plantilla o el lienzo en blanco; todo abre el estudio (abajo) y nada se guarda hasta «Crear». Si faltan datos, el diseñador puede proponer hasta 2 tablas nuevas, que se crean al guardar (nunca modifica una tabla existente).
- **En /views/<slug>**: la barra de abajo («Pídele un cambio a Cortex») edita la vista con texto, y «Editar» (`?editar=1`) abre el estudio en pantalla completa (abajo).
- **Plantillas** (`apps/web/lib/views/starter-templates.ts`): «Cartera» y «Ventas del mes» son specs sobre `cortex.ventas` que abren armadas con datos reales (sin gastar respuestas del plan); «Programa de pagos» (`payables`), «Inventario bajo mínimo» (`inventory`), «Embudo comercial» (`crm`) y «Vencimientos de la empresa» (`doc_expirations`) también son specs, y llevan el `module` del que leen: con ese módulo apagado no se ofrecen (`startersFor(modulesOff)`, la página `/views` le pasa `modulesOffFor`); «Operación de carga», «Seguimiento de solicitudes», «CRM de ventas», «Inventario», «Agenda de citas» y «Proyectos» son frases que Cortex arma con las tablas de cada empresa (llevan un boceto `sketch` sólo para su miniatura); «Lienzo en blanco» arranca con un bloque de texto.
- **En el chat**: `views.list`, `views.get`, `views.create`, `views.update`, `views.share`, `views.archive`.
- Cada guardado es una versión (`custom_view_versions`) con la frase que la produjo. Restaurar copia una versión vieja como nueva. Las ediciones simultáneas no se pisan: la segunda recibe un conflicto.

### El estudio (editar con las manos)

Pantalla completa (`components/views/editor/ViewEditor.tsx` + `components/views/studio/*`; lo que no depende de React, en `lib/views/studio.ts` con `studio.test.ts`):

- **Arriba**: salir, el nombre (se edita en el sitio), estado («Cambios sin guardar» / «Guardado»), deshacer/rehacer, ver como Computador / Tableta / Celular (el marco mide hasta 1280 / 768 / 390 px y las columnas las decide el marco, no la ventana: `deviceSpan`), «Probar» (la vista interactiva con datos reales, sin escribir nada), «Compartir» (el mismo `ShareDialog` de la barra) y «Guardar» (no cierra el estudio; una vista nueva pasa a `/views/<slug>?editar=1`).
- **Izquierda**: «Agregar» (biblioteca de piezas con su dibujo, buscable; se tocan o se arrastran al lienzo y caen donde se sueltan, con `locateDrop`; los tipos salen de `blockTypes` del servidor y de lo que `newBlock` sabe armar), «Datos» (el catálogo por familia, con campos, filas —`rowCount`, que `/api/views/catalog` manda de más— y botones para poner una pieza sobre cada fuente), «Capas» (los bloques en lista: elegir, reordenar, renombrar) y «Páginas» cuando la vista tiene (`spec.pages`: navegar y decir en qué páginas sale el bloque elegido; crearlas y renombrarlas sigue en «Ajustes de la vista»).
- **Centro**: el lienzo con las seis columnas a la vista al pasar o arrastrar, marco de selección con esquinas y un asa a la derecha que cambia el ancho (tercio/mitad/completo), y un final que enseña («Arrastra una pieza aquí o pídeselo a Cortex»).
- **Derecha**: el inspector (Bloque / Vista), plegable; por debajo de 1600 px arranca plegado y elegir un bloque lo abre.
- **Abajo**: la caja de Cortex flotante (⌘K o «/») con frases sugeridas a partir de la vista (`studioSuggestions`). Atajos con «?» (`ShortcutsDialog`).
- **Teléfono y tableta** (< 1024 px): lienzo a pantalla completa, barra de pestañas abajo (Agregar, Datos, Capas, Ajustes) y cada panel como hoja que sube.
- **Borrador en el navegador** (`useDraftAutosave`): mientras hay cambios sin guardar se copia a `localStorage` por vista; al volver se ofrece «Recuperar» o «Descartar», nunca se aplica solo. Todo en try/catch.

### El lienzo por dentro

`apps/web/components/views/editor/*`. Para «este gráfico más ancho» o «quita ese filtro» sin escribirle a Cortex:

- **Rejilla**: cada bloque se pinta con el mismo `ViewBlockPreview` de la vista guardada, inerte, dentro de un marco. Arrastrar con el asa (eventos de puntero, sirve en el teléfono; menos de 5 px es un clic); con el teclado, flechas sobre el asa o Alt+flechas sobre el nombre. Al elegir un bloque: ancho (⅓ ½ completo), antes/después, duplicar y eliminar (con «Deshacer» en un aviso). Deshacer/rehacer global (⌘Z / ⇧⌘Z, hasta 60 pasos; las teclas de un mismo campo cuentan como un paso).
- **Inspector** (columna en escritorio, hoja inferior por debajo de 1024 px): título, fuente (menú agrupado: tablas del espacio, datos de Cortex, Feed propio; lo que el bloque no admite sale deshabilitado con el motivo), campos, agregado, tipo de gráfico, agrupar por, filtros como frases («Estado» «no es» «Pagada»), orden, límite, columnas editables, botones por fila, arrastrar, campos del formulario, markdown. Pestaña «Vista»: nombre, subtítulo, descripción, refresco, quién edita y avisos.
- **Paleta «Agregar bloque»**: cada plantilla sale válida (`newBlock` elige fuente —la del bloque elegido si sirve—, título y campos probables). «Plano» (`zones`) aparece sólo si `blockSchema` del servidor lo acepta (`/api/views/catalog` devuelve `blockTypes`).
- **Vista previa**: cada cambio (450 ms después) va a `POST /api/views/preview`, que valida con `viewSpecSchema` + `checkSpecAgainst` (catálogo de quien edita, con `keep` de la versión guardada) y calcula con `loadViewSources` + `computeView`, nunca escribible. Los problemas vuelven atados a su bloque (`problemsFromZod`/`problemsFromCheck`) y se pintan en el marco y en el inspector; «Guardar» espera a que no quede ninguno. No llama al modelo ni gasta respuestas.
- **Guardar** pasa por `saveViewAction` con `expectedVersion` (versión nueva, historial, conflicto si alguien guardó antes). «Cancelar» descarta. La caja de Cortex sigue abajo y cambia el borrador del lienzo.
- El vocabulario que el navegador necesita (operadores, agregados, anchos…) está repetido en `lib/views/editor-shape.ts` porque el barril de `@cortex/agent-tools` no entra en el bundle de cliente; `editor-shape.test.ts` falla si se desvía. `editor-spec.test.ts` comprueba que cada plantilla de la paleta y de inicio pasa el contrato y el catálogo.

## Pulso de la empresa

«Dime cómo va la empresa en una vista y actualízala cada día», sin diseñar nada. Código: `packages/agent-tools/src/views/pulse.ts` (puro) y `pulse-tools.ts` (base, modelo y herramientas); pruebas en `pulse.test.ts`.

- **`views.company_pulse`** lee el inventario (`readPulseInventory`: una fila por fuente de la plataforma y el conteo de las tablas `siigo_*`/`alegra_*`/`quickbooks_*`) y `composePulseSpec` arma la vista `pulso_empresa` sólo con lo que tiene datos: «Resumen de hoy» (`resumen_hoy`, texto), ventas del mes contra el anterior (la tabla de facturas del programa contable sin anuladas; si no hay, `cortex.ventas`), cartera vencida (`cortex.cartera`, también en cero; si no contesta, las vencidas de las ventas), recuperado con Cortex, pagos recibidos (`cortex.pagos`; si no hay, la tabla de pagos del programa), metas cumplidas, pendientes de Gerencia, compromisos vencidos, vencimientos de 7 días, rutinas con error; ventas y pagos por mes, mejores clientes, «Quién debe más», metas y decisiones. Lo que falta vuelve en `missing` con cómo conectarlo; sin nada, no se crea la vista. Rehacerla conserva el resumen del día. No pide confirmación (como `views.create`).
- **`views.refresh_summary`** calcula la vista en el servidor (`loadViewSources` + `computeView`), saca las cifras citables (`pulseFacts`: cada KPI, su período anterior y su cambio, lo de ayer con los mismos filtros, puntos de los gráficos, primeras filas de las tablas, lo que se venció ayer) y pide al modelo 3 frases. **La guarda** (`checkGrounding`) lee cada número del texto y lo busca en esas cifras con la tolerancia de cómo se escribió («4,3 millones» cubre 4.250.000; «37 %» inventado no pasa). Si falla, un reintento con los números rechazados; si vuelve a fallar o el modelo no contesta, `fallbackSummary` (sólo cifras). Escribe el bloque con `updateView` y `prompt = «Resumen del día AAAA-MM-DD»`: la versión anterior queda en el historial y esa marca hace la herramienta **idempotente por día** (salvo `force`). Además está en `safe-actions/catalog.ts` con clave vista + día de Bogotá.
- **`views.schedule_pulse`** (con confirmación) crea o actualiza la rutina `scheduled_jobs` `kind: 'tool'` → `views.refresh_summary({view})`, por defecto `0 7 * * 1-5` en America/Bogota, con el resultado en la conversación de la rutina (y por correo si se pide). `schedule-run` entrega su `report` como texto.
- Una vista con el pulso usa fuentes internas (Gerencia, recuperado, rutinas): no se comparte por enlace.

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
- Las fuentes de los módulos que leen con el lector del módulo (`cortex.inventario`, `cortex.proyectos`, `cortex.flota`) calculan el módulo entero y recortan al tope después; las demás recortan en la consulta (lo abierto primero en `por_pagar` y `ordenes_compra`).
- Las fuentes de la plataforma son de sólo lectura y fijas (el registro de `sources.ts`); no se pueden filtrar en la base, se filtran en memoria sobre las filas leídas como una tabla inventada.
- Los datos se recalculan al abrir y, mientras la pestaña está visible, cada `refreshSeconds` (sondeo). Una vista sobre `feedsrc.*` cambia cuando la fuente conectada se sincroniza, no antes: la frecuencia la pone la fuente en Feed.
- `cortex.activaciones` lee las 100 simulaciones más recientes (cada una trae hasta mil candidatos que hay que leer para contarlos); si hay más, sale parcial.
- Las tablas del Feed se leen enteras desde `feed_tables` (JSON de la captura, hasta 50.000 celdas) en cada refresco; no hay índice ni filtro en la base.
- El diseñador consume una respuesta del plan por cada petición (más un reintento interno si su primer borrador no cuadra con el catálogo).

## Verificación

- `packages/agent-tools/src/views/views.test.ts`: contrato, cálculo, filtros de fecha, tablero, columnas, bloques rotos y scrypt.
- `packages/agent-tools/src/views/sources.test.ts`: ids que no chocan con slugs de tabla, campos válidos, contrato con fuentes (y formularios rechazados), lectores contra un PostgREST de mentira con dos espacios (ventas con saldo y mora, dólares fuera de `money`, pagos en disputa fuera, vencimientos vs. compromisos internos, tope parcial) y la regla de compartir (`setViewAccess`, `updateView`, `audience: 'public'`).
- `packages/agent-tools/src/views/module-sources.test.ts`: forma de las filas de cada fuente de módulo contra un PostgREST de mentira (dólares fuera de `money`, lo abierto primero, tope parcial), interruptor del módulo (apagado, valor por defecto, bloque con el aviso, catálogo marcado), nómina sólo en agregados y sin tocar `employees`/`payslips`, contratos laborales sólo para su círculo, PQRS y documentos sin texto privado, y aislamiento por espacio. `apps/web/lib/views/starter-templates.test.ts`: plantillas por módulo.
- `packages/agent-tools/src/views/feed-sources.test.ts`: ids del Feed (armar/desarmar, no chocan, la forma rechaza parecidos), encabezados → claves y tipos (dinero sólo en pesos, códigos como texto, fechas día primero), filas y tope parcial, contrato (sólo lectura, no disponible, opacas), y contra un PostgREST de mentira con dos personas y dos espacios: el dueño ve, el compañero ve el aviso sin que se pida el contenido, público y sin `viewerId` no leen, vencidas/borradas/de otro espacio, la conexión sigue su última lectura, vista preparada, compartir rechazado, catálogo sólo del que pregunta, `validateSpec` con `keep`, y las cuatro fuentes personales (cada quien lo suyo; rutinas propias + globales).
- `scripts/test-views-sql.mjs` (PGlite): CHECK de las puertas, slugs por espacio y el candado de intentos. `PGLITE_MODULE=<ruta> node scripts/test-views-sql.mjs`.
- `apps/web/lib/shared-links-public-paths.test.ts`: las rutas públicas siguen en el middleware.
- `apps/web/lib/views/editor-shape.test.ts` y `editor-spec.test.ts`: vocabulario del lienzo contra el contrato; mover/duplicar/borrar; plantillas válidas; problemas atados a su bloque.
- `packages/agent-tools/src/views/blocks.test.ts`: direcciones (https, lista de inserciones, botones), contrato de los bloques nuevos, galería/calendario/avance/KPI, ficha (campos por audiencia, edición sólo con permiso), barra de filtros (parámetro, aplicación a bloques y avisos, tildes), páginas y tema. `apps/web/lib/views/filter-param.test.ts`: la copia del navegador escribe lo que el servidor lee.
- `apps/web/lib/branding/colors.test.ts`: contraste de marcas difíciles (amarillo, menta, casi negro, blanco), colores del logo, tipo del logo por sus bytes, validación del formulario.
- QA visual con datos de mentira en escritorio, 375 px y el tema oscuro de la app (también el lienzo: seleccionar, inspector, paleta, arrastrar, borrar con deshacer, plantilla «Cartera»). Sin prueba autenticada end-to-end contra una base con la 0156 aplicada.
