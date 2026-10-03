# Tablas que se llenan solas

Una fuente conectada del Feed (Google Sheet, página web o API — p. ej. una API de vuelos) llena una tabla de la empresa cada 5–1440 minutos. Migración `0161_tracker_syncs.sql`.

## Cómo se usa
En el chat: «llena una tabla *llegadas* desde la fuente *Vuelos BOG*, con vuelo y fecha como clave, cada 5 minutos, y avísame». Herramienta `trackers.sync_from_source` (pide confirmación); `trackers.syncs` lista las sincronizaciones con su último resultado.

- Si la tabla no existe, se crea con las columnas de la fuente (hasta 20). Una columna con hora («2026-09-25T15:05Z») queda como texto en hora de Bogotá.
- Cada fila se identifica por sus **columnas clave**; nueva → se agrega, cambió → se actualiza. Lo que desaparece de la fuente no se borra.
- Un valor nuevo en un campo de opciones (un estado que no se había visto) amplía las opciones en vez de rechazar la fila.
- `notify`: la campana de quien creó la sincronización suena cuando entran o cambian filas («Llegadas: 2 filas nuevas: AV9, LA40»). Una vista sobre la tabla puede además sonar mientras está abierta (`spec.alerts`), también cuando una fila **cambia** y pasa a cumplir el filtro («pasó a Aterrizó»).

## APIs que no responden con una lista en la raíz
La fuente de API ahora encuentra la lista de registros:
1. en `recordsPath` si se indica («data», «arrivals», «states»);
2. en la raíz;
3. en la propiedad del objeto raíz que es una lista (la más larga; si hay empate no adivina).

Listas sin nombres (OpenSky `states`) usan `columns` como encabezados (o c1, c2…). En listas que vienen dentro de un objeto, los objetos anidados se aplanan un nivel («arrival.iata»). Una lista en la raíz conserva su forma de siempre, porque las activaciones guardadas dependen de sus columnas. `recordsPath`/`columns` se pasan a `trackers.sync_from_source` y quedan en la configuración de la fuente.

Conectar la API en sí sigue siendo el flujo de Herramientas propias (admin, credenciales cifradas) y luego «Conectar como fuente» en el Feed.

## Quién y cómo corre
- Sólo el dueño de la fuente crea la sincronización, y corre con su identidad: copiar filas de su Feed privado a una tabla del equipo es decisión suya.
- `table-sync/dispatch` cada 5 minutos (pg-boss en `services/jobs` + Inngest de respaldo) → `table-sync/run` por sincronización: refresca la fuente, aplica la captura, anota el resultado. Si la API falla, se sincroniza con la última captura buena y el error queda anotado.
- `tracker_rows.external_key` es única por tabla: dos corridas con la misma captura no duplican nada.

## Parámetros fijos de una API de lista
`trackers.sync_from_source` y `trackers.update_from_source` aceptan `query`: parámetros fijos de la fuente (`{"airport":"BOG","date":"{hoy:YYYY-MM-DD}"}`). Tienen que ser parámetros de la herramienta propia de la fuente (una llave no va aquí). `{hoy}` y `{ahora}` (con formato opcional) se resuelven cada vez que se lee la API; la configuración y su hash guardan la plantilla, así que no nace una fuente nueva cada día. Con `update_from_source` se encola una lectura enseguida; la primera pasada (inmediata) aún usa la captura anterior.

## Consulta por fila (migración `0198_row_lookups.sql`)
La sincronización lee UNA lista por corrida. Para «dime cómo va cada vuelo, cada 5 minutos, sólo los de hoy que no han aterrizado, máximo 2.000 consultas al día» lo que hace falta es **una URL por fila**: eso es una *consulta por fila*.

En el chat: `trackers.row_lookup_create` (pide confirmación), `trackers.row_lookup_status` (cómo va: consultas de hoy, filas que tocan, errores) y `trackers.row_lookup_update` (pausar, reanudar, subir el tope, cambiar filtro/ventana; «consultar ahora»). En pantalla: **Tablas › una tabla › Consultas automáticas** (tarjeta por consulta con consultas de hoy contra el tope, próxima vuelta, último error, pausa/reanudar, «Consultar ahora», tope editable) y el diálogo **Agregar consulta**, que prueba con UNA fila y muestra lo que escribiría antes de guardar.

### Qué se configura
- **Dirección** con campos de la fila: `https://api.ejemplo.com/vuelos/{vuelo}/{fecha:YYYY-MM-DD}`. Formatos: fechas y horas en hora de Bogotá (`YYYY-MM-DD`, `YYYYMMDD`, `DD/MM/YYYY`, `HH:mm`, `iso`, `unix`, `unixms`) y texto (`upper`, `lower`, `digits`, `compact`). `{hoy}` y `{ahora}` son fijos. Cada valor va codificado (`encodeURIComponent`): un valor no puede salirse de su tramo ni abrir un parámetro. El servidor es literal (sin campos) y siempre `https`. Una fila a la que le falta un campo **no se consulta** (no gasta consulta) y se cuenta como «sin algún campo».
- **Credencial**: el nombre de una herramienta propia (Herramientas propias, admin; método GET). La llave sigue cifrada ahí: la consulta sólo toma de la herramienta su autenticación y encabezados, la descifra dentro de `executeCustomTool` y nunca sale (ni en el estado, ni en los avisos, ni en la pantalla, que sólo ve nombre y servidor). **La llave sólo se envía al mismo servidor que la herramienta**; si la dirección va a otro dominio se rechaza al crear y en cada corrida. Si la herramienta se borra, la consulta avisa (guarda `credential_name`) en vez de seguir llamando sin llave. La guardia contra direcciones internas es la de las herramientas propias.
- **Qué traer**: caminos de la respuesta → columna (`status → estado`, `arrival.estimated → hora_estimada`, `data.0.status`, `$.a.b`), con `translate` opcional (`landed → aterrizado`). Una columna que la tabla no tiene se agrega como texto; una hora ISO queda en hora de Bogotá; un valor nuevo en un campo de opciones amplía las opciones.
- **Filtro** de qué filas se consultan, con los mismos operadores que las vistas de la grilla (`eq neq contains not_contains gt gte lt lte between in not_in empty not_empty before after last_days next_days`, y `match` todos/alguno). Para fechas el valor puede ser `hoy` (día de Bogotá al correr; `last_days 0` también). **El filtro es la regla de parada**: cuando `estado` pasa a «aterrizado» la fila deja de cumplir `estado no es ninguno de aterrizado, cancelado` y no se vuelve a consultar. Una prueba compara la lista de operadores con la de `components/datagrid/types.ts`.
- **Intervalo**: base (mínimo 5 min) y, opcional, regla «cerca de»: una columna de fecha/hora, una ventana (`desde N min antes hasta M min después`), cada cuánto dentro (≥5) y qué hacer fuera (`base` = al intervalo base, `skip` = no consultar). Al consultar una fila, la próxima toca cuando abre la ventana si abre antes del siguiente intervalo (y con los valores YA escritos: la respuesta puede mover la hora). Los fallos seguidos de una fila espacian el reintento (×2 por fallo, hasta ×8 y 2 h).
- **Topes**: por día (obligatorio, por defecto 1.000, hasta 100.000) y por corrida (por defecto 100). El contador del día es de Bogotá y se reinicia a medianoche de Bogotá. Al llegar al tope del día la consulta se detiene, avisa **una sola vez** (campana de quien la creó, con `dedupeKey` por consulta y día) y se retoma a medianoche; el tope por corrida deja el resto para la vuelta siguiente (5 min). Las más urgentes (dentro de la ventana, las que llevan más sin consultarse) pasan primero.

### Cómo corre
- Mismo reloj que las sincronizaciones: `table-sync/dispatch` cada 5 minutos toma las consultas con `next_run_at` vencido, les pone un arrendamiento de 10 minutos (para que dos vueltas no se pisen) y manda `table-sync/run` con `lookupId`. **No hay un trabajo nuevo**: no se tocó `jobs-registry.ts` ni `services/jobs/src/manifest.ts`, así que no hace falta redeploy de Railway por el manifiesto (sí el de la app web, donde viven el despachador y el ejecutor).
- Una vuelta (`runRowLookup`): lee la tabla, el estado por fila y la credencial; el planificador puro (`lookups/plan.ts`) decide qué filas, con qué dirección y por qué no las demás; llama la API con 3 hilos, 15 s por llamada y 40 s para toda la vuelta; un **429** detiene la vuelta y la pospone ≥15 min (respeta Retry-After); un **401/403** la detiene, avisa y espera 1 h; un **404** es «todavía no hay dato» (se espacia, no es falla).
- Escritura: sólo las columnas del mapeo y sólo si cambiaron, sobre los valores que la fila tiene EN ESE INSTANTE (se relee antes de escribir: lo que el equipo editó mientras la API respondía no se pisa) y por `upsertRow`, el mismo camino de `trackers.upsert`. Cada cambio deja una fila en `audit_events` (`trackers.row_lookup`, superficie `schedule`, con qué cambió de qué a qué) que el historial de la fila muestra como «Consulta automática «nombre»».
- Al crear (chat o pantalla) se prueba con una fila: si la API contesta mal (o la dirección no arma), la consulta se guarda **en pausa** para no gastar el tope repitiendo un error. La prueba cuenta como una consulta del día.

### Tablas
`row_lookups` (configuración, topes, contador del día `calls_today`/`calls_day`, último resultado, `next_run_at`) y `row_lookup_state` (por consulta y por fila: `next_at`, último resultado, fallos seguidos). Las dos `tenant()`, RLS encendido sin políticas, sólo `service_role`. Cambiar la dirección, el mapeo, el filtro o la ventana borra el estado por fila (todas vuelven a tocar).

## Límites
- 1.000 filas por captura; mínimo cada 5 minutos (no es tiempo real al segundo).
- Consulta por fila: se miran hasta 5.000 filas de la tabla por vuelta, hasta 10 caminos por consulta y 10 condiciones de filtro; sólo GET; no hay «borrar consulta» en pantalla (se pausa).
- El evaluador del filtro está duplicado a propósito en `packages/agent-tools/src/table-sync/lookups/filter.ts` (el paquete no puede importar de la app); sigue los mismos operadores y reglas que `matchesFilter` de la grilla (sin tildes ni mayúsculas, «no es» incluye lo vacío, un filtro a medio llenar no filtra).
- Probado con pruebas unitarias, un doble de PostgREST y PGlite (`packages/agent-tools/src/table-sync/lookups/row-lookups.sql-test.mjs`); no contra una API de vuelos real.
