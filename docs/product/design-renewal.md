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
