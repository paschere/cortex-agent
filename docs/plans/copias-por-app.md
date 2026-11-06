# Copias por app (respaldo y restauración)

Decisión del dueño (2026-11-06): copias por app dentro de Cortex, además de la copia diaria de
toda la base (pg_dump del jobs-worker a /backups, 14 días) y PITR de Railway (al minuto, ~4 semanas).

## Qué se copia (una «copia» = una foto de la app)
- Configuración: app (fila de custom_apps), pantallas, vistas (spec), roles, reglas, avisos,
  versiones publicadas (referencia), geocercas.
- Código (apps con código): custom_app_code.files + id de la compilación publicada (no los
  bundles: se recompilan), secretos NO (solo sus nombres).
- Datos: TODAS las filas de las tablas (trackers) que usa la app — las que nombran los permisos
  de sus roles, sus vistas y sus reglas — con sus campos (definición de la tabla incluida).
  Archivos adjuntos: solo sus referencias (las URLs firmadas ya apuntan a app_files, que no se borra).
- Base propia de la app (esquema app_<id>): volcado de sus tablas como JSON por tabla
  (máx. 50 000 filas por tabla; más, se marca truncado).

## Dónde vive
Tabla nueva `custom_app_backups` (migración nueva con el número siguiente libre): id, org, app_id,
kind ('diaria' | 'antes_de_cambio' | 'manual'), reason (texto), created_by, created_at,
size_bytes, tables (jsonb resumen: slug → filas), status, storage_ref. El contenido va
comprimido (gzip de JSON) en app_files (bucket 'app-backups', ruta <org>/<app>/<id>.json.gz)
— o, si app_files no sirve para eso, columna bytea en la misma tabla. Retención: 30 diarias +
las manuales y «antes de cambio» de los últimos 90 días.

## Cuándo
- Diaria a las 2:00 a. m. Bogotá para cada app activa (job nuevo en services/jobs/src/manifest.ts
  que llama a la app web como los demás jobs, o lo corre en Vercel /api/jobs/run — sigue el
  patrón existente).
- «Antes de cambio»: al publicar una versión de la app, al publicar código, al aplicar
  migraciones de la base propia, y desde el chat cuando Cortex vaya a modificar tablas/reglas en lote.
- Manual: botón «Hacer copia ahora».

## Restaurar (solo administradores de la app; siempre deja una copia «antes de restaurar»)
- Ver una copia: resumen por tabla (filas), diferencias contra hoy (filas nuevas/borradas/cambiadas).
- Descargar: Excel (una hoja por tabla) o JSON completo.
- Restaurar una FILA (vuelve a sus valores de esa copia; si fue borrada, la recrea con el mismo id).
- Restaurar una TABLA completa (reemplaza sus filas por las de la copia, con confirmación que dice
  cuántas filas se crean/cambian/borran).
- Restaurar configuración (pantallas, roles, reglas) o código.
- Nada de esto toca otras apps ni tablas que la app no usa. Todo queda en el historial (/actividad).

## Interfaz
Pestaña «Copias» en el editor de la app (apps/web/components/apps/editor/), estilo del editor.
Herramienta de chat para Cortex: listar copias, hacer copia, restaurar fila/tabla (con confirmación).
