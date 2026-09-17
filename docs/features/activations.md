# Activaciones desde un prompt

Primera entrega del [plan de lanzamiento](../strategy/2026-09-16-activations-backlog.md). `/activations` está en Automatización y se puede abrir desde Feed, Integraciones y Finanzas. **Una activación es una regla configurable; facturas es solamente una plantilla.**

## Recorrido

1. Describir el proceso: «Encuentra productos con inventario menor a 10 y prepara un asunto para compras».
2. Cortex utiliza el nombre de la empresa y el catálogo de fuentes privadas accesibles —archivos, pestañas y encabezados— para proponer una fuente, un criterio y un asunto. Puede pedir aclaraciones. La selección de fuente es opcional.
3. Aplicar la propuesta y editar nombre, condiciones, columnas de agrupación, columnas de evidencia, título, objetivo y siguiente paso. También se puede empezar con configuración manual.
4. Simular sobre los datos reales de la pestaña seleccionada. Se muestran las coincidencias, las filas que no cumplen y las inválidas con motivo.
5. Confirmar explícitamente qué datos se compartirán con la empresa. Se crea un asunto abierto de Gerencia por grupo de duplicados o por fila que cumpla condiciones.
6. Abrir Gerencia, asignar responsable, revisar evidencia y utilizar el cierre humano existente. El historial permite reutilizar la configuración mientras la fuente siga disponible.

Esta entrega ejecuta revisiones manuales sobre una pestaña tabular del Feed. El planner no simula conexiones, temporizadores, acciones externas o cruces de tablas: devuelve esos requisitos como pendientes. Una petición con capacidades no soportadas no se convierte silenciosamente en un subconjunto ejecutable. Se diseña una activación por petición; las solicitudes múltiples requieren elegir por cuál empezar.

## Qué puede configurarse

- Comparaciones de texto: igualdad, desigualdad, contiene, vacío.
- Comparaciones numéricas exactas: mayor/menor, incluyendo igualdad; decimal con punto y sin separador de miles.
- Fechas anteriores o posteriores a hoy, en Bogotá, con fechas válidas `AAAA-MM-DD`.
- Cumplir todas las condiciones o cualquiera de ellas.
- Detectar registros repetidos por una o varias columnas. Las claves vacías se excluyen; una coincidencia requiere revisión y no confirma por sí misma que exista un duplicado.
- Elegir columnas de contexto que acompañan la evidencia, además de las usadas por la regla.
- Personalizar el asunto y reutilizar la configuración.
- Plantilla opcional de facturas: emisor + número + moneda, con monto y fecha explícitos. Cambios de monto/fecha son posibles conflictos, nunca una certificación de doble facturación.

El motor no interpreta código arbitrario. El modelo propone una definición estructurada que se valida antes de ofrecerla a la persona; la simulación y creación de asuntos son deterministas.

## Aislamiento y evidencia

La fuente y su simulación son privadas para su creador en la empresa activa. El planificador recibe metadatos, no valores de las filas. Usa el modelo de chat configurado en Cortex, un límite de frecuencia y la comprobación de cuota existentes. Revalida sesión y fuente después de la respuesta del modelo.

La ejecución usa sesión, empresa y actor; el commit vuelve a comprobar la membresía y propiedad de la fuente. La fuente debe seguir vigente, y sus tablas y hash deben coincidir con el snapshot dentro de la transacción. Las solicitudes cruzadas se rechazan.

La confirmación comparte solamente la evidencia mostrada de los grupos o filas coincidentes. No promueve el archivo a Brain ni modifica facturas, inventario, pagos o sistemas externos. En Gerencia, un panel de sólo lectura muestra todas las filas compartidas y distingue esa evidencia de origen de la evidencia que demuestra el cierre. Las ediciones conservan el snapshot; un trigger evita reemplazarlo.

`activation_runs` está vinculado al archivo temporal: eliminarlo elimina las simulaciones en cascada; fuentes vencidas dejan de aparecer. Los asuntos que la persona autorizó compartir conservan su evidencia para seguimiento.

Reintentos del mismo commit reutilizan asuntos. Para reglas genéricas, la identidad incorpora el contenido de origen, la definición y el grupo o fila; para la plantilla de facturas, contenido + emisor + factura + moneda. El mismo contenido y definición se pueden reutilizar sin duplicar asuntos, dentro de la empresa. Cambiar una regla o el contenido constituye una revisión nueva. No se promete identidad universal entre exportaciones, ERPs ni nombres de proveedor variables.

## Límites

- Fuente tabular procedente del ingreso existente de Feed: CSV, XLSX u hojas de Google que produzcan `feed_tables`.
- Hasta 20 pestañas por fuente y 1.000 filas de datos por pestaña; primera fila como encabezado.
- Hasta 500 columnas direccionables, 20 condiciones, 10 columnas de agrupación y 20 columnas de contexto opcionales.
- Valores/identificadores de hasta 240 caracteres; los valores largos utilizados por la regla se excluyen y no se truncan para comparar.
- Fechas estrictas. La plantilla de facturas exige moneda de tres letras, no infiere valores y excluye notas crédito/importes negativos.
- Consulta inicial: 100 fuentes y 50 ejecuciones recientes.
- Planner: prompt de hasta 4.000 caracteres; catálogo de hasta 20 fuentes, 8 pestañas y 60 encabezados por pestaña, con límite total de 24.000 caracteres. Si una fuente no aparece, se puede seleccionar expresamente o usar el constructor manual.
- Diseño y simulación no significan que haya una rutina activa. La programación, los eventos de conectores y las acciones externas siguen pendientes de integrarse con este constructor.

## Gmail

El barrido usa cursor por `user_id` y encola una continuación al completar una página de 200 buzones. pg-boss exige aceptación de todos los eventos y falla ante un rechazo parcial para permitir reintento. El fallback Inngest registra cron, continuación y handlers de buzón con sus pasos durables. Los reintentos pueden redistribuir eventos aceptados previamente; sigue siendo necesaria la idempotencia del procesamiento por buzón.

## Verificación

Vitest cubre límites del planner, fuentes inventadas/inaccesibles, propuestas ambiguas, capacidades no soportadas, reglas genéricas, comparación decimal exacta, fechas, agrupación, mapeo, aislamiento de estado UI, evidencia de Gerencia y reparto Gmail. Los typechecks de web y agent-tools comprueban los contratos.

`scripts/test-activations-sql.mjs` ejecuta SQL real de Gerencia y la migración 0148 con PGlite en memoria y dependencias mínimas sintéticas. Sus 30 aserciones cubren creación genérica, evidencia, idempotencia, aislamiento, revocación, expiración, snapshot modificado, preservación de evidencia y eliminación del archivo. No sustituye una prueba con Supabase desplegado ni dos conexiones PostgreSQL concurrentes.

```sh
npm install --prefix /tmp/cortex-activation-db --ignore-scripts --no-audit --no-fund @electric-sql/pglite
PGLITE_MODULE=/tmp/cortex-activation-db/node_modules/@electric-sql/pglite/dist/index.js node scripts/test-activations-sql.mjs
```

La revisión visual usa el componente real y el simulador real con API/datos sintéticos, incluido un plan de modelo simulado. Esto comprueba el recorrido en escritorio y móvil, no la calidad del modelo en producción. La prueba autenticada con una empresa real, un archivo real, el modelo configurado y la base desplegada requiere validación aparte.

## Siguiente fase

Activaciones persistentes separadas de la retención temporal del Feed, conectores mantenidos, identidades canónicas, salud/frescura de sincronización, programación y eventos, acciones externas con mandatos existentes, varias activaciones por objetivo, medición de activación/retención/costo y empresas piloto. El backlog completo mantiene esos puntos pendientes; esta entrega no equivale a disponibilidad general de toda la plataforma propuesta.
