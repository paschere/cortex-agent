# Cortex: mesa de operaciones

El trabajo central es decidir qué requiere atención, avanzar un asunto y comprobar el resultado. La identidad visual gira alrededor de ese recorrido y del contexto activo de empresa.

## Dirección

- Papel blanco `#FFFFFF`: trabajo y documentos.
- Niebla `#F4F7F6`: navegación y fondo de aplicación.
- Tinta `#20312E`: lectura y jerarquía.
- Petróleo `#176B68`: acciones y selección.
- Ámbar `#966313`: espera, bloqueo e incertidumbre.
- Rojo `#B93E4C`: fallo y vencimiento crítico.

Manrope, ya disponible en la aplicación, para navegación, texto y títulos; números tabulares sin forzar monospace a toda cifra. JetBrains Mono se reserva para identificadores y contenido técnico. Títulos de 24 px, cuerpo de 14 px, controles de 13 px. Alineación izquierda y máximo de lectura acotado.

```
Empresa       | Operación / Gerencia                  Buscar   Avisos
Gerencia      | Qué necesita atención      Nuevo asunto
Conversación  | Prioridades y próximos pasos | Decisiones / Fuentes
Fuentes       | Asunto seleccionado          | Evidencia / Historial
Navegador     | Plan → preparar → aprobar → ejecutar → verificar
Operación     |
Resultados    |
Configuración |
```

La marca se expresa en el eje de progreso del asunto y en el verde petróleo, sin auroras ni animaciones decorativas. Navegación agrupada visible, controles con radios de 8 px, superficies definidas por espacio y bordes discretos, sombras reservadas a elementos flotantes. Conservamos el rail compacto del chat, con acceso por teclado, y los paneles que no desmontan la conversación.

La revisión del concepto descartó sustituir una colección de tarjetas por otra: el foco de Gerencia será una lista de trabajo con detalle y evidencia; los módulos de datos conservan sus tablas. Los tokens y componentes compartidos trasladan la renovación a las pantallas existentes sin reemplazar sus mecanismos de autorización.

## Implementación y revisión

El diseño se aplica desde tokens globales, botones, cabeceras, paneles y el marco de navegación. Gerencia pasa a ser el destino inicial después del onboarding. El menú muestra grupos y contadores, conserva el selector de empresa, se puede contraer/fijar y funciona como cajón en móvil. El chat conserva su menú compacto y los paneles; su entrada elimina el fondo animado y usa una pregunta orientada al trabajo.

Revisión local en Chromium con componentes reales y respuestas de servidor simuladas: 1440 px y 390 px, navegación, contracción y expansión, cajón móvil, asuntos, historial, revisión, configuración y preparación de cobro. No equivale a una auditoría visual individual de todos los módulos ni a una prueba de integración con servicios reales.

Validación final de esta entrega: typecheck web completo, 99 pruebas Vitest seleccionadas (gestión, cobro, acciones, seguridad, navegación, registros de tablas y jobs), 45 verificaciones PostgreSQL y recorridos visuales locales de Gerencia, Feed, entrada del chat y menú móvil. Las capturas usan datos ficticios; la aceptación de correo y portales externos queda pendiente en un entorno desplegado.

## Revisión visual: centro de mando

La composición anterior fue rechazada por parecer una aplicación administrativa genérica. Esta revisión sustituye las cuatro tarjetas iguales por una banda de indicadores, da prioridad visual al primer asunto y introduce una firma gráfica propia de Cortex.

Paleta del espacio autenticado: vacío `#0A0C13`, grafito `#121621`, tinta clara `#EDF1FF`, periwinkle `#6E7DFF`, señal cian `#74CFEF` y ámbar `#EFBF74`. Manrope se mantiene para lectura y títulos, con títulos de 36–60 px de peso medio y tracking ajustado. Las cifras se integran en la composición y los controles conservan tamaños utilizables.

La revisión del plan evitó limitarse a invertir los colores: menú flotante, banda de indicadores sin cajas, cabecera amplia, firma de líneas plegadas y agenda con profundidad diferenciada. La luz se concentra en la identidad y la selección; no hay movimiento ambiental ni estados de actividad inventados. El tema se aplica al espacio autenticado y sus portales; la impresión y las páginas públicas conservan su paleta legible.

La revisión oscura pasó 20 pruebas de navegación y continuidad de paneles, typecheck web y recorridos Chromium de Gerencia, Feed, chat, menú móvil, portales e impresión. Capturas locales con datos de ejemplo; no desplegada.

## Manuales como experiencia de trabajo

La biblioteca de procesos sustituye la lista de formularios en Configuración. Mantiene el tema grafito y la tipografía de Cortex, con fichas por propósito, búsqueda y lectura del recorrido. La creación parte de un único espacio amplio para explicar o dictar; el micrófono está antes del cuadro de texto y la guía contextual queda al lado en escritorio.

La propuesta se revisa como un documento: secciones completas resumidas, pasos y vacíos abiertos, dudas visibles y guardado explícito. La navegación conserva el borrador dentro de Gerencia y restablece la posición de lectura al cambiar de vista. El aviso al salir se reserva para borradores modificados. La vista de lectura distingue secuencia, condiciones, excepciones y evidencia de resultado.

La prueba visual usa narración y respuesta del modelo simuladas. Se comprobaron biblioteca, lectura, entrada por voz, revisión, guardado y tamaños móviles; no se presenta como prueba de reconocimiento de voz real.
