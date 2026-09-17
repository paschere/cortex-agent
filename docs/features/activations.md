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
- Un cron de pg-boss cada cinco minutos encuentra revisiones pendientes. Un cambio del puntero de una fuente adelanta las activaciones `on_change`. No se ofrece todavía un endpoint de webhooks públicos.

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
- El diseñador propone una activación por turno, sin joins entre fuentes.
- Se muestra el último resultado y el historial de simulaciones; no hay todavía un panel completo de métricas de SLA.

## Verificación

Las pruebas de motor, planificación, Feed, scheduler y rutas se complementan con PGlite ejecutando las migraciones 0148–0151: aislamiento, cambios de fuente, citas, idempotencia, publicación y fencing de pausa. La validación visual usa fuentes sintéticas. Una integración externa real y su cuenta de empresa requieren validación autenticada adicional.
