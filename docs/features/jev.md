# Jev en Cortex (opcional)

Contrato revisado el 18 de septiembre de 2026: [TypeSafe HTTP API](https://docs.typesafe.ai/api).
Jev evalúa preguntas tipadas sobre datos suministrados. No descubre sitios ni ejecuta el navegador por sí mismo.

## Integración inicial

- `web.search` sigue obteniendo resultados de Tavily. Jev puede reordenar hasta diez resultados según su relevancia; conserva las mismas URLs, textos y puntuaciones de Tavily. No crea hechos ni modifica la respuesta sintetizada del buscador.
- Ante un cambio de diseño en un trámite aprendido, Jev puede elegir un control equivalente entre los elementos reales y compatibles de la página. No cambia la acción, el valor, el perfil, la autorización ni el proceso. Una negativa o baja confianza detiene esa reparación; un error de servicio conserva el proveedor anterior.
- No sustituye el planificador de navegación libre, ni convierte Cortex en un agente de navegación completamente basado en Jev.
- En navegación libre, `browser.read_page` acepta `findControl: { goal, action }` y devuelve una sugerencia `ref/name` de la página actual. El planificador decide si usarla con `browser.act`, que vuelve a comprobar el elemento y conserva los permisos/perfil existentes. La sugerencia no hace clic ni escribe datos. Si hay más de 50 controles, se usa la paginación existente.

## Configuración

En el entorno **servidor de la aplicación web**, configurar `TYPESAFE_API_KEY` de [TypeSafe Console](https://console.typesafe.ai) y habilitar por separado:

```
JEV_WEB_SEARCH=on
JEV_BROWSER_REPAIR=on
JEV_BROWSER_NAVIGATION=on
JEV_MODEL=jev-latest
```

Las tres funciones están apagadas por defecto. Una clave sola no las enciende. No configurar variables `NEXT_PUBLIC_…`, subir claves al repositorio ni pegarlas en el chat. No requiere cambios del servicio Chromium de Railway: las decisiones se hacen en el paquete de herramientas del servidor web.

## Datos y límites

La búsqueda envía la consulta, títulos, fragmentos y nombres de dominio. Las consultas pueden contener datos del usuario: activar este proveedor es una decisión de configuración de la instalación. La reparación envía etiquetas de controles, título/encabezados y contexto corto del paso. No envía valores de campos, cookies, selectores, cuerpo completo, URLs de sesión ni credenciales. Etiquetas y encabezados aún pueden contener información de la empresa; el modo navegador tiene su propia habilitación.

Cada llamada tiene un máximo de dos segundos y no se reintenta automáticamente. Respuestas parciales, inválidas o fallos mantienen el comportamiento anterior. Las respuestas son sugerencias probabilísticas; la confianza no certifica exactitud ni reemplaza permisos. El contenido de páginas se trata como datos, no como instrucciones.

La estimación del costo de reparaciones aceptadas usa el precio publicado al revisar la integración: USD 0,042 por millón de tokens de entrada y salida sin cargo ([TypeSafe](https://typesafe.ai)). El registro existente de reparaciones no equivale a la factura total del proveedor. El costo de reordenamiento y llamadas fallidas debe comprobarse en su consola.

## Validación

Pruebas con respuestas simuladas: contrato HTTP, cancelación/timeout, referencias inventadas, negativas, incompatibilidad de controles, conservación de resultados y minimización de datos. Para activar en producción falta una clave autorizada y un piloto real que compare aciertos, latencia y costo con el proveedor existente. No se atribuye una mejora de velocidad o calidad antes de medirla.
