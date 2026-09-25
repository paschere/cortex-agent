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

## Límites
- 1.000 filas por captura; mínimo cada 5 minutos (no es tiempo real al segundo).
- No hay pantalla propia todavía: se configura y consulta desde el chat.
- Probado con pruebas unitarias y PGlite; no contra una API de vuelos real.
