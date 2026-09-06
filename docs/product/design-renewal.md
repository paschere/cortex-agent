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

## Movimiento de marca

Por petición del usuario, la firma de Cortex ahora gira, respira y lleva un destello a través de sus trazos. El movimiento se comparte en portada, menú, chat y manuales: órbita de 28 segundos (36 en el menú), respiración de 8 segundos y recorrido luminoso de 6 segundos. Se anima el grupo interior del SVG, conservando la posición y rotación que cada pantalla ya usa.

Es identidad de marca, no una indicación de ejecución. No utiliza temporizadores ni bucles JavaScript. El navegador muestra el símbolo estático con reducción de movimiento y al imprimir. Validado en Chromium comprobando cambios reales de transformación y la desactivación al cambiar las preferencias; se generó un video local de vista previa.

## Landing espacial

La portada pública usa una galaxia procedural de cinco brazos alrededor de la
firma de Cortex. Paleta aislada en `.cosmos`: azul noche `#070912`, panel
`#101523`, blanco lunar `#eeeffa`, texto secundario `#a0aac4` y lavanda
`#b6b3f3`. Manrope mantiene la continuidad con el producto. El contenido se
presenta en flujo normal, sin una secuencia de scroll fijada: portada, ejemplos
interactivos de Gerencia/Feed/Trámites, procesos, control, preguntas y acceso.
Los ejemplos están identificados como ilustrativos; no consultan datos reales.
Las tarifas siguen sin publicarse y las llamadas a la acción abren registro/login.

`SpaceHero` carga `SpaceScene` por separado después del montaje. Three.js dibuja
polvo estelar, órbitas y luz mediante geometría procedural y shaders, sin el GLB
humano anterior. DPR máximo 1.5; 10.000 partículas de galaxia en escritorio,
4.500 en móvil, más 550 estrellas. Pausa manual, visibilidad de pestaña e
IntersectionObserver suspenden los cuadros continuos; el modo demand conserva
la escena al redimensionar. Movimiento reducido evita montar WebGL. Una firma
SVG y órbitas CSS conservan la composición si WebGL no está disponible.

Validación local: TypeScript y Biome; componentes reales montados en Chromium
con enlaces de Next adaptados para la previsualización. Se revisaron escritorio,
320/390/768 px, ejemplos, preguntas desplegables y movimiento reducido, sin
errores de shaders. Se instrumentaron las llamadas de dibujo para verificar
pausa y suspensión fuera de vista; se comprobó también la alternativa sin WebGL.
No incluye una publicación de producción ni pruebas nuevas de autenticación.

## Creación de asuntos

`NewCaseFields` separa la creación del seguimiento: resultado, criterio comprobable,
próximo paso, responsable, impacto y fechas. Fuente, dependencia y bloqueo se
pliegan en contexto adicional. La evidencia, los estados de cierre y el historial
siguen en la edición existente. Se añade una vista previa de agenda y dictado por
campo, con límites equivalentes al esquema y bloqueo de envío durante el dictado.
La agenda retira encabezado y estadísticas mientras el editor está abierto.
Errores de guardado reciben foco y se mantienen los datos introducidos.

Validación con componentes reales y acciones simuladas en Chromium: campos
obligatorios, dictado, revisión antes de guardar, conservación de fuente/fechas/
responsable, móvil, cierre con evidencia, historial, reapertura y creación desde
señales. No se ejecutaron escrituras en una empresa real.

## Chat y voz inmersiva

El chat presenta una portada con la firma de Cortex, compositor con más profundidad,
acceso visible a Hablar y control para detener respuestas. `buildSystemPrompt`
se inicia en paralelo a búsqueda y selección de herramientas; no cambia de modelo
ni reduce permisos. La cancelación del cliente se propaga al modelo.

La nueva sala de voz usa WebRTC con OpenAI Realtime: micrófono con cancelación de
eco, detección semántica de turnos, interrupción, silencio, transcripción visible
y firma visual sensible al nivel de audio. La transcripción permanece en memoria
hasta que la persona elige llevarla al borrador; ese paso conserva texto previo
y no envía el mensaje. El audio se transmite a OpenAI al conectar; se explica en
la pantalla de entrada. Hay pausa por silencio del micrófono, cierre explícito,
limpieza al desmontar y sesión de cliente limitada a 15 minutos.

El servidor crea la conexión mediante `/v1/realtime/calls`, conserva la clave en
el backend, comprueba sesión y plan, y usa el límite existente de conexiones por
minuto. El modelo se configura con `OPENAI_REALTIME_MODEL` (por defecto
`gpt-realtime-2.1`), voz `marin`, y requiere `OPENAI_API_KEY`. La configuración local
revisada no contiene esta clave. El modo compatible anterior queda disponible
por elección explícita; no se hicieron llamadas pagadas a proveedores.

Para hechos de la empresa y trabajo, Realtime usa `consult_cortex`, que llama a
la ruta de Cortex en modo texto, sin otra síntesis de voz. Mantiene identidad,
espacios seleccionados y controles de herramientas. Se retiró la confirmación
automática de la ruta de voz: una operación que necesita aprobación pide
continuar en el chat. Consultar datos internos todavía incurre en la latencia
de búsqueda y herramientas; no hay una cifra de latencia real medida aquí.

Referencia de protocolo: https://developers.openai.com/api/docs/guides/realtime-webrtc
Validación: TypeScript; pruebas de sesión, plan, secreto de API, errores del
proveedor, lectura incremental SSE, ámbito, confirmación, cancelación y texto
hablado. Chromium con WebRTC/micrófono simulados verificó conexión explícita,
silencio, consulta, interrupción, transcripción, conservación del borrador,
limpieza y móvil. Estas comprobaciones no requieren una llamada real y no sustituyen una prueba de audio de extremo
a extremo con la cuenta de OpenAI configurada.

### Conexión humana y espiral

La portada espacial permanece. Debajo, `ConnectionStory` presenta una escena
independiente dirigida por el scroll: retrato humano de filamentos, contacto con la
espiral, dispersión y convergencia de partículas en Cortex. `ConnectionScene`
usa una ilustración generada para este proyecto (`public/images/cortex-human-connection.png`)
como textura y origen de las partículas; no es un humano articulado en 3D.
Se retiró el uso del modelo robótico antiguo de esta landing. La nueva escena
se carga al entrar en vista. El panel queda sticky mientras el scroll controla
la conexión; retroceder revierte la animación y detenerse conserva el momento.
Incluye indicador de avance, salto al producto y vuelta al inicio. No intercepta
la rueda ni los gestos táctiles. Se detiene fuera de vista y deja una firma
estática, sin tramo largo de scroll, sin WebGL o con movimiento reducido.

El logo compartido vuelve a una sola espiral continua, con grosor variable,
acabado perlado y giro lento, sin deformaciones de la silueta. Conserva los
controles de pausa de la portada y la voz, y queda estático al imprimir.
Validación local: TypeScript, Biome en los componentes cambiados y Chromium
con WebGL real para avance y retroceso por scroll, posición sticky, salto,
reinicio, ausencia de reproducción automática, escritorio y móvil.

`ScrollExperience` coordina el recorrido completo con una sola escucha de scroll:
la cámara de la galaxia se acerca y gira al salir del hero, el fondo espacial
acompaña toda la página, las secciones aparecen al entrar en vista y el logo del
cierre cambia de orientación. La escena humana consume el mismo estado global.
La línea superior muestra el avance total. Los enlaces de sección conservan sus
posiciones naturales: el movimiento se aplica al contenido, no a sus anclas.
El modo de movimiento reducido y la impresión dejan la página estática.

El fondo estelar toma como referencia visual la presentación de GPT-6 Astra
(https://openai.com/index/gpt-6-astra/). `StarField` distribuye 600 estrellas con
semilla fija en tres planos de profundidad, con tamaños irregulares, blancos,
azules y algunos tonos cálidos. Nueve estrellas cercanas tienen un halo suave.
Los planos usan el progreso global del scroll sin otro bucle de animación.
La galaxia añade puntos destacados con halo en su shader. El fondo es decorativo,
no captura interacciones, reduce intensidad en móvil y se oculta con movimiento
reducido o al imprimir. Se revisó visualmente el hero y el cierre en navegador.
