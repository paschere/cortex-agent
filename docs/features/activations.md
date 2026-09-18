# Activaciones y fuentes de Feed

## Flujo disponible

1. Añadir una fuente desde Feed: archivo PDF/DOCX/XLSX/CSV/TXT/MD, texto, URL pública, Google Sheets conectado o API de lectura configurada por la empresa.
2. Describir el objetivo en Activaciones o configurar una regla manualmente. El diseño usa las fuentes privadas de la persona en la empresa activa.
3. Las tablas se leen directamente. Documentos, textos y páginas pueden convertirse en una vista tabular privada: Cortex propone columnas y filas con citas literales verificables. No modifica el original ni lo promueve al cerebro.
4. Revisar campos, identidad del registro, condiciones y evidencia. Simular antes de compartir o autorizar seguimiento.
5. Crear asuntos en Gerencia una vez o autorizar revisiones futuras. La autorización de seguimiento especifica fuente, definición, esquema, frecuencia y permiso para compartir coincidencias como asuntos.

Las facturas son un preset. Las reglas generales admiten condiciones, comparaciones numéricas, fechas, campos vacíos y agrupaciones para revisar duplicados. Una intención ambigua o una acción que el motor no soporta produce preguntas; no se transforma silenciosamente en otra tarea.

## Disparadores

- **Al cambiar la fuente:** APIs, URLs y Sheets se consultan con la frecuencia elegida. Un contenido idéntico omite la simulación. Las nuevas versiones de archivos/textos se vinculan a una conexión persistente de Feed.
- **Por frecuencia:** evalúa incluso sin cambios, útil para vencimientos. Opciones: cada hora, 6 horas, 24 horas o 7 días. Son intervalos, no una hora fija de calendario.
- Un cron de pg-boss cada cinco minutos encuentra revisiones pendientes. Un cambio del puntero de una fuente adelanta las activaciones `on_change`. El webhook de una fuente autenticado por token adelanta la revisión; el cron actúa como respaldo. Los avisos repetidos se deduplican y los recibidos durante una ejecución conservan una revisión pendiente.

Cada ejecución verifica pertenencia a la empresa, propiedad de la fuente, conexión habilitada y autorización vigente. Un lease evita procesamiento concurrente. Pausar invalida el lease: un trabajo iniciado antes de la pausa no puede publicar después de ella.

Los cambios de esquema o registros inválidos detienen la regla para revisión. Los errores temporales se muestran y se reintentan en la siguiente revisión. Reanudar permite volver de pausa manual; una regla que necesita revisión requiere nueva simulación y autorización.

## Fuentes y privacidad

`feed_sources` conserva la conexión y el puntero a la última captura. Las capturas conservan la retención temporal existente de Feed; no se hace memoria permanente por conectarlas. Las fuentes API referencian las herramientas existentes: no duplican credenciales y solo capturan operaciones GET a través de sus controles de acceso, red y redacción.

Una fuente caducada o eliminada no puede autorizar ni publicar una simulación antigua. Las vistas preparadas se eliminan con su captura. APIs y URLs requieren que el contenido sea accesible con el conector configurado; las páginas que dependen de interacción de navegador y PDFs sin texto no adquieren soporte por el solo hecho de pegar su enlace.

## Duplicados y evidencia

Los asuntos de seguimiento utilizan un espacio estable de identidad por activación. Las reglas por condiciones requieren columnas que identifiquen el registro; las reglas de duplicados usan su agrupación. Cambiar el orden o valores secundarios no crea otro asunto con la misma identidad. Una activación nueva constituye otra autorización y puede producir sus propios asuntos.

Cada asunto conserva evidencia inmutable de las filas que originaron su creación, su regla y, en vistas preparadas, citas de la fuente. Reutilizar un asunto no reemplaza esa evidencia inicial. La evidencia de detección no prueba que el asunto esté resuelto.

## Límites de esta entrega

- Hasta 1.000 filas por simulación; las vistas de texto piden acotar el contenido si excede el límite de preparación.
- Las acciones automáticas de este motor crean asuntos abiertos. Enviar mensajes, pagar, escribir en un ERP o ejecutar herramientas requiere otro flujo autorizado.
- El diseñador propone una activación por turno. Feed permite preparar antes un cruce explícito de dos o tres fuentes.
- Se muestra el último resultado y el historial de simulaciones; no hay todavía un panel completo de métricas de SLA.

## Verificación

Las pruebas de motor, planificación, Feed, scheduler y rutas se complementan con PGlite ejecutando las migraciones 0148–0155 (sin 0154, que no fue necesaria): aislamiento, cambios de fuente, citas, idempotencia, publicación y fencing de pausa. La validación visual usa fuentes sintéticas. Una integración externa real y su cuenta de empresa requieren validación autenticada adicional.


## Cruces de fuentes

Feed → **Cruzar fuentes y explorar activaciones** permite elegir dos o tres conexiones privadas de la misma persona y empresa. Se aprueba una clave exacta común; no hay unión aproximada por nombre. La simulación distingue coincidencias, ausencias y claves ambiguas. Guarda una fuente combinada reutilizable en Activaciones.

Cada captura conserva dependencias y procedencia por fila. El servidor rechaza publicar una simulación si una dependencia cambió, venció, se desconectó o perdió su permiso. Al compartir, sólo viajan los valores revisados y referencias de origen; las citas de filas completas permanecen privadas. No se admiten cruces que dependan de otros cruces.

Las sugerencias usan encabezados y metadatos. Son propuestas editables; no implican que dos identificadores iguales pertenezcan a la misma entidad ni activan procesos sin revisión.

## Salud y actualización

La sección Fuentes conectadas y el diagnóstico de puesta en marcha distinguen lectura vigente, atrasada, incompleta, vencida, desconectada y reglas pendientes. La vigencia es un plazo de revisión configurable, no una prueba de veracidad del proveedor. Reconectar no reanuda automáticamente las reglas pausadas.

Las APIs GET pueden recorrer cursores declarados en la herramienta: ruta de registros, parámetro de cursor y ruta del siguiente cursor. La UI limita a cinco páginas y mil filas; alcanzar un límite deja la lectura incompleta y bloquea la autorización. No es replicación incremental universal ni propaga borrados del proveedor.

Un webhook sólo avisa de un cambio; no ingiere su cuerpo ni ejecuta efectos externos. Requiere token secreto mostrado una vez, identificador único de evento y timestamp reciente en cabeceras. La base conserva únicamente el hash del token. Rotar o revocar invalida el anterior. La pertenencia a la empresa se comprueba al recibir cada aviso.

## De un asunto a una acción comprobada

En el resultado de una activación o en su asunto de Gerencia, **Continuar con una acción** prepara una llamada a una herramienta personalizada de la empresa y un verificador GET. El formulario usa los campos declarados por cada herramienta. El usuario revisa los parámetros, la evidencia y el criterio esperado, y luego aprueba usando la cola de permisos existente.

El puente comprueba permisos, definición y contenido aprobado antes de escribir. Lee el estado previo, ejecuta una vez y consulta de nuevo. Una respuesta HTTP exitosa no basta: debe coincidir el criterio del verificador. Si el resultado es incierto, sólo se permite volver a consultar; no se reenvía la escritura. No se cierra el asunto automáticamente: el cierre sigue requiriendo evidencia y revisión humana.

La evidencia compartida y el historial de la operación sobreviven a la expiración de la captura temporal de Feed. El resultado puede volver a consultarse sin repetir la acción; preparar otra escritura exige una simulación vigente. La primera misión conserva los asuntos históricos propios sin presentar una fuente vencida como disponible.

Alcance actual: herramientas personalizadas HTTP de la empresa. No genera automáticamente parámetros de acción desde cualquier prompt, ni convierte todas las herramientas nativas en operaciones de este puente. Probar una cuenta real y acordar el criterio de éxito de cada proveedor sigue siendo necesario.

## Gerencia y primera misión

Inicio y Gerencia priorizan decisiones, bloqueos y asuntos en curso sin duplicar el mismo objeto entre bandejas. Muestran responsable, plazo, motivo de prioridad y estado de evidencia. La primera misión acepta un objetivo libre, lo lleva a Activaciones y retoma una simulación guardada. No mezcla el objetivo de una simulación nueva con el resultado de otra antigua.

Se muestra uso registrado y acceso al panel existente de consumo. No se presentan ahorros, ingresos ni costos facturados inferidos. La medición comercial completa de margen, soporte y resultados atribuibles requiere conectar esas fuentes y acordar una base de comparación.
