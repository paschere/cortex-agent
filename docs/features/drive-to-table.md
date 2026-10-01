# Carpeta de Drive → tabla

Cada archivo que llega a una carpeta de Google Drive se lee y se vuelve una fila (o varias) de una tabla de la empresa. Sirve para cualquier documento que llegue repetido: facturas de proveedores, órdenes de compra, remisiones, guías, hojas de vida, contratos. Migración `0164_drive_folder_syncs.sql`.

## Cómo se usa
En el chat: «los proveedores dejan sus facturas en esta carpeta (enlace): que cada una quede en una tabla *facturas*, con proveedor y número como clave». Herramienta `trackers.sync_from_drive_folder` (pide confirmación); `trackers.drive_syncs` lista las carpetas conectadas, su última corrida y los archivos por revisar o con error, con el motivo.

- **Carpeta**: enlace, id o nombre exacto. Se lee con las credenciales de Google de quien la conecta (necesita Drive conectado con lectura).
- **Columnas**, en este orden de preferencia:
  1. las que diga la persona (`fields`, cada una con una pista de dónde está; `fromDocument: false` para las que llena el equipo, como un estado o un responsable);
  2. un ejemplo de partida (`preset`): `guias_aereas`, `facturas_proveedor`, `ordenes_compra`;
  3. las de la tabla, si ya existe (se leen todas menos las de opciones, que suelen ser del equipo);
  4. si no hay nada de eso, el modelo **propone** las columnas leyendo un archivo de muestra de la carpeta, y la respuesta dice cuál.
- **Clave** (`keyFields`): los campos que identifican un documento (su número; proveedor + número si los números se repiten entre proveedores). Se normaliza sin espacios, guiones ni tildes: «045-12345678» y «045 12345678» son la misma fila. Va en `tracker_rows.external_key` (0161).
- **Valores por defecto** (`defaults`): con qué nace una fila nueva, p. ej. `{"estado": "Pendiente"}`.
- **Indicaciones** (`instructions`): contexto para leer esos documentos («las guías de Miami traen el peso en libras»).
- Toda tabla conectada tiene un campo **Revisión** (OK / Por revisar); si no lo tenía, se agrega.

## Qué se cree y qué no
El documento es dato, nunca instrucciones: va delimitado y el sistema dice que no se obedece; lo único que la respuesta del modelo puede hacer es llenar campos de esta tabla.

Por cada campo el modelo devuelve el valor, la **frase literal** del documento donde está, y si duda. Antes de guardar:
- si la frase no está en el archivo, o el valor no está en la frase (un total calculado, una fecha deducida), el valor **no se guarda**;
- números: punto decimal; se aceptan 1.500.000,50 y 1,500,000.50 en la frase. Fechas: 2026-03-12, 12/03/2026 (y 03/12/2026 de EE. UU.), 12MAR26, «12 de marzo de 2026»;
- un campo de opciones sólo acepta una de sus opciones.

Lo dudoso, lo descartado y la clave que falta dejan la fila **«Por revisar»**; los motivos quedan en el libro de archivos y salen en `trackers.drive_syncs`. Una fila sin clave igual se crea (el equipo tiene que verla) con una clave del archivo, para que leerlo otra vez no la duplique.

Un archivo con varios registros (un Excel con diez facturas, un manifiesto) da varias filas, hasta 50 por archivo.

## Cuándo se vuelve a leer
- `drive_folder_sync_files` anota cada archivo con su revisión (md5, o modifiedTime en los nativos de Google). Se lee **una vez por revisión**.
- Una revisión nueva actualiza la fila: cambia lo que el documento trae, **conserva** lo que el equipo puso (estado, dolly, responsable) y lo que esta vez no se pudo leer.
- Error pasajero (Drive o el modelo no respondieron): se reintenta hasta 3 veces. Error permanente (imagen, PDF escaneado sin texto, .xls antiguo, más de 20 MB): no se reintenta hasta que el archivo cambie.
- Lo que sale de la carpeta no se borra de la tabla.

Formatos: PDF con texto, Word (.docx), Excel (.xlsx), CSV, texto, Documentos y Hojas de cálculo de Google (todas las hojas). No lee fotos ni escaneos.

## Cómo corre
- `drive-table/dispatch` cada 10 minutos (pg-boss en `services/jobs` + Inngest de respaldo) → `drive-table/run` por carpeta. La herramienta encola la primera lectura de inmediato.
- `drive-table/run`: toma la corrida (sólo si tocaba: el cron y la primera lectura no corren a la vez), lista la carpeta (sin subcarpetas), lee hasta **10 archivos** por corrida —los más recientes primero; el atraso sigue en las siguientes—, un paso por archivo.
- La lectura usa el modelo de utilidad (`generateObject` con un esquema armado con los campos de la tabla) sobre hasta 30.000 caracteres del archivo. Pasados 9 minutos de corrida no se empieza otro archivo (el puente de pg-boss corta a los 800 s).
- La campana de quien la creó suena cuando entran o cambian filas o un archivo no se pudo leer: «Facturas: 3 filas nuevas — FE-4471, FE-4472, FE-4480. 1 por revisar.» (clase `table_sync`).

## Límites
- Intervalo mínimo 10 minutos; 10 archivos por corrida; 50 registros por archivo; 30.000 caracteres por archivo.
- Sólo la carpeta, no sus subcarpetas.
- No hay pantalla propia: se configura y se consulta desde el chat; las filas se ven en `/trackers/<tabla>`.
- Probado con pruebas unitarias (planeación, citas, claves, libro), un archivo de punta a punta contra una base falsa, y la migración contra PGlite. **No** probado contra Drive ni el modelo reales.
