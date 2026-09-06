# Gerencia de empresa

## Producto implementado

`/management`, accesible como **Gerencia** en el menú y la paleta. Reúne el trabajo de operación sin sustituir los módulos existentes.

- **Hoy en la empresa:** asuntos priorizados por reglas explicables, responsables, plazos, impacto declarado, próximo paso, revisión pendiente y dependencias. Las cifras se calculan sobre los registros disponibles; no son pronósticos.
- **Señales:** compromisos confirmados por vencer/vencidos, metas incumplidas o sin lectura del último período cerrado, aprobaciones propias sin resolver y encargos propios detenidos. Una fuente caída se muestra como no disponible. Convertir una señal en un asunto requiere una acción explícita; la base impide duplicarla. Si un compromiso, aprobación o encargo sigue pendiente después de cerrar su asunto, la mesa muestra la discrepancia y permite revisar/reabrir el cierre; las lecturas históricas de metas no se confunden con estado operativo actual.
- **Gestión:** organizar → en gestión/bloqueado → por verificar → cerrado con evidencia. El responsable, el creador o un administrador pueden registrar avances. Un administrador revisa la referencia, registra su veredicto y cierra. Cortex puede proponer evidencia, pero no darse a sí mismo la aprobación humana. Reabrir conserva todas las revisiones.
- **Dependencias:** misma empresa, sin ciclos. No se cierra un asunto cuya dependencia siga sin verificar.
- **Personalización:** alcance, prioridades, medidas de éxito acordadas, responsable de escalamiento y plazo inicial de revisión. Las medidas declaradas no crean métricas: `/goals` conserva la medición con fuente y método.
- **Manuales:** propósito, disparador, entradas, pasos, criterio de éxito, excepciones y autoridad. Se puede vincular un trámite enseñado y crear un asunto desde el manual. El manual es contexto; no concede permisos ni dispara el navegador.
- **Parte diario opcional:** una persona puede activar su parte de lunes a viernes a las 08:00 de Bogotá, entregado en una conversación por el planificador existente. Llamada fija de solo lectura, sin modelo generativo, correos ni ejecución de acciones. Activaciones repetidas reutilizan la rutina activa o pausada. Pausa/cancelación y errores se consultan en Rutinas.
- **Chat:** `management.brief`, `management.inspect`, `management.record`, `management.daily_brief`. El prompt orienta a consultar alcance y casos antes de proponer acciones. Registrar desde el chat pasa por la confirmación existente, igual que compromisos y metas. Los permisos por equipo y las reglas de seguridad siguen aplicándose.

## Datos y permisos

Migración `0130_management.sql`: `management_profiles`, `management_cases`, `management_events`; las tres clasificadas por empresa. RLS sin acceso para clientes anon/authenticated. Escrituras únicamente por RPC de servicio con empresa fijada por el cliente con alcance, validación de actor y miembros y bloqueo transaccional.

Cada cambio guarda el estado completo y la identidad del actor en el historial, en la misma transacción que la revisión del asunto. Los clientes con revisión desactualizada no sobrescriben cambios. La tabla de eventos no concede modificaciones al rol de servicio. La configuración también comprueba su revisión.

Los asuntos son compartidos con **todos los miembros de la empresa**. No son expedientes privados de RR. HH. Las aprobaciones y encargos originales siguen siendo personales; organizar una señal copia únicamente los datos que el usuario decide guardar en el asunto compartido. No se copian adjuntos, sesiones, cookies ni documentos al Brain. Una referencia de evidencia es un enlace con una observación humana, no una copia inmutable de su contenido externo ni una comprobación automática de autenticidad.

Las lecturas tienen límites explícitos: 500 asuntos recientes, 1.000 personas, 100 señales por fuente y 500 lecturas de metas. La UI y el parte advierten cuando la vista es parcial. El historial muestra las últimas 100 revisiones por asunto; la base conserva el resto.

## Alcance de la automatización

Las señales se consultan al abrir/actualizar la mesa o usar `management.brief`. El parte diario consulta los asuntos compartidos ya organizados; no crea casos ni incorpora aprobaciones/encargos privados. La fecha de revisión identifica trabajo pendiente, no ejecuta una tarea programada. El responsable de escalamiento queda identificado; este módulo no le envía mensajes automáticamente.

La ejecución de correos, cobros o trámites continúa en Acciones, Navegador, Flujos y sus herramientas, bajo los mandatos/aprobaciones existentes. Cerrar un asunto no marca como pagada una factura, cumplido un compromiso ni aprobado un trámite en la fuente original. Esas fuentes deben verificarse y actualizarse mediante su propio mecanismo.

## Despliegue y aceptación

1. Aplicar 0130 después de las migraciones anteriores en el entorno de prueba. No aplicada a ningún entorno compartido durante esta implementación.
2. Desplegar web y consumidores de agent-tools; el planificador existente debe estar operativo para entregar el parte.
3. Crear dos empresas y comprobar UI/API con usuarios diferentes; las pruebas aisladas cubren el motor SQL, pero no sustituyen la sesión real de Supabase/Better Auth.
4. Configurar alcance, responsable de escalamiento y un manual. Organizar una señal, asignar, bloquear, proponer evidencia, verificar y reabrir. Comprobar el historial y las dos pestañas con una revisión desactualizada.
5. Activar el parte con una cuenta de prueba, comprobar ejecución y conversación, pausar y cancelar. No se activó una rutina real en esta sesión.
6. Ensayar el proceso completo del primer cliente contra sus portales y datos autorizados antes de prometer operación administrada.

## Validación local

- Pruebas de criterios, fechas, evidencia, prioridad, aislamiento de lectura y negativa a la autoverificación en `management.test.ts`.
- Prueba PostgreSQL aislada `management.sql-test.mjs`: roles, aislamiento, concurrencia de revisión, duplicados, dependencias, historial, configuración y rutina idempotente. Usa PGlite instalado en `/tmp`, sin tocar las dependencias del proyecto ni una base de clientes.
- UI real compilada con esbuild y ejecutada en Chromium, con acciones de servidor simuladas: escritorio/móvil, creación desde señal/manual, edición, cierre, reapertura, historial y activación del parte. No es una prueba integrada contra el backend desplegado.

Para repetir la prueba SQL:

```sh
npm install --prefix /tmp/cortex-management-db --no-audit --no-fund @electric-sql/pglite
PGLITE_MODULE=/tmp/cortex-management-db/node_modules/@electric-sql/pglite/dist/index.js node packages/agent-tools/src/management/management.sql-test.mjs
```

El control global `lib/unchecked-reads.test.ts` señala dos fallos previos a esta implementación: lecturas sin manejo de error en `meetings/live/archive`, `meetings/live/voice-answer`, `voice/turn` y `weekly-report`, y una entrada de baseline desactualizada en `chat/route`. Ninguno apunta a las nuevas rutas de Gerencia. No se amplió el baseline para ocultarlos.

## Seguimiento ejecutable de cobro (0131)

Desde un asunto guardado, **Preparar un cobro** permite elegir una de las 100 facturas confirmadas más recientes y escribir el destinatario. Cortex consulta los movimientos vinculados exactamente por ID de factura y prepara una propuesta personal en Acciones, ligada al agente Cortex activo. El usuario revisa destinatario y texto y aprueba el envío por el mecanismo existente. El proceso y su evidencia son compartidos con la empresa; el buzón y la aprobación mantienen sus permisos personales.

El worker consulta procesos pendientes cada 15 minutos: propuesta pendiente, envío confirmado, respuesta o ausencia de respuesta, pagos confirmados. Una respuesta no demuestra pago. Los estados bloqueado, detenido y evidencia lista requieren intervención; no generan más mensajes. Un cobro fallido o ambiguo nunca se reenvía automáticamente. Detener es definitivo para ese proceso; un nuevo procedimiento requiere otro asunto.

La conciliación usa importes exactos de hasta dos decimales, misma moneda y movimientos confirmados. Resta anulaciones; bloquea ante movimientos reportados, en disputa, monedas distintas o lecturas incompletas. No consulta bancos ni empareja nombres. Antes de enviar vuelve a comprobar saldo, estado del asunto y vigencia del proceso; un borrador con saldo antiguo se bloquea. Antes de copiar evidencia al cierre vuelve a consultar los pagos. La comprobación es fechada, no una garantía frente a cambios posteriores.

El proceso conserva su posición y evidencia en PostgreSQL. El arrendamiento temporal y el token evitan que un worker antiguo registre avances; un disparador impide insertar una segunda propuesta para el mismo proceso incluso si la anterior fue aprobada o descartada. El saldo del borrador se guarda antes de crear la propuesta y también queda asociado a su justificación para recuperar interrupciones.

Herramientas: `management.collection_status`, `management.start_collection`, `management.advance_collection`. Iniciar o avanzar requiere confirmación; el envío necesita su propia aprobación. El chat no puede cerrar la revisión humana.

Para activar este recorrido hay que aplicar **0131 después de 0130**, desplegar web, registro de herramientas y worker de jobs, y verificar una cuenta de correo autorizada con su agente. Nada de eso se aplicó a producción en esta sesión. La aceptación debe incluir un cobro de prueba aprobado, respuesta real, pago parcial, pago final y rechazo de un borrador desactualizado.

Este primer recorrido no convierte manuales arbitrarios en programas ejecutables: Drive → DIAN, mapeo universal de documentos y medición monetaria de ahorro requieren sus implementaciones y validación específicas. No se atribuye al sistema dinero recuperado ni horas ahorradas sin una fuente y un método de medición.

## Manuales: biblioteca y dictado

Los manuales ahora tienen una biblioteca independiente dentro de Gerencia, con búsqueda, lectura del recorrido y contexto de entradas, excepciones, permisos y evidencia. Desde Configuración se accede a esta biblioteca; el formulario repetido de manuales se retiró. Se conservan edición, eliminación explícita y creación de un asunto a partir de un manual.

Un administrador puede contar un proceso completo en un solo cuadro, por texto o con dictado continuo del navegador, hasta 18.000 caracteres. El micrófono requiere un navegador compatible y permiso; el servicio de reconocimiento puede procesar audio remotamente. Cortex recibe la transcripción. Se puede escribir o editar directamente si el dictado no está disponible. Al detenerlo se espera el cierre del reconocimiento antes de habilitar el análisis, para recibir sus resultados finales.

`organizeManual` usa el modelo configurado en la app, salida estructurada validada con Zod, límite de cuatro solicitudes por minuto por usuario, comprobación de disponibilidad del plan y timeout de 60 segundos. No ejecuta herramientas ni guarda el manual. Solicita campos vacíos ante información ausente o contradicciones no resueltas y hasta cuatro preguntas de aclaración; descarta enlaces que no aparezcan literalmente en la explicación.

El borrador permite editar cada sección, revisar la explicación utilizada y ampliar la narración. Se señalan vacíos y se exige revisar las dudas propuestas antes de compartir. Guardar usa la revisión del perfil capturada al iniciar para evitar sobreescribir cambios concurrentes y mantiene la autorización de administrador en el servidor. El dictado se detiene al abandonar la pestaña; el borrador se conserva al cambiar de sección en Gerencia y se avisa antes de cerrar la página. No es almacenamiento persistente de borradores.

Validación: 11 pruebas de contrato y fronteras del analizador, 20 pruebas de navegación/paneles, typecheck web y recorrido Chromium con voz/modelo simulados (dictar, conservar entre pestañas, analizar, completar vacíos, revisar dudas, guardar y móvil). La calidad de transcripción real depende del navegador y el análisis en producción requiere las credenciales del modelo configurado. No se hizo una llamada real al proveedor ni se compartieron manuales de clientes durante las pruebas.

## Puesta en marcha y conversación conectadas (septiembre 2026)

`/onboarding` abre ahora con una puesta en marcha de seis bases: encargo guardado, contexto disponible, responsable de escalamiento, meta activa, manual y primer cierre verificado. Son lecturas de los módulos existentes, sin nuevas tablas ni casillas de progreso. Una lectura no disponible se muestra como desconocida; no se confunde con cero. Tener contexto preparado no acredita la calidad de ese contexto ni concede permisos. Los mandatos conservan su revisión independiente. Fuentes, invitaciones y la guía previa siguen disponibles en un desplegable.

`/management?tab=settings` y `?tab=processes` abren directamente la sección correspondiente. La agenda ofrece volver al chat con una pregunta editable; el enlace nunca envía el turno automáticamente. Metas, compromisos, aprobaciones, rutinas y Feed permanecen en sus módulos y se accede desde la agenda.

Un administrador puede dictar o escribir el encargo completo y preparar alcance, prioridades y criterios de éxito con el modelo configurado. El análisis no guarda, no ejecuta herramientas, no modifica permisos ni crea métricas. Incluye límites de entrada, frecuencia, plan y tiempo. Los campos ausentes permanecen vacíos y las dudas se presentan para revisión. Se detiene el dictado antes de analizar o guardar, y el guardado conserva el control de revisión del perfil existente.

El chat incorpora entradas de entender, decidir y dar seguimiento; cada ejemplo llena el compositor. Las preguntas con opciones permiten respuesta libre multilínea y dictado. Las respuestas conservan sus fuentes, acciones, confirmaciones y orden de herramientas. El prompt compartido pide consultar antes de afirmar, preguntar solo por información que desbloquea el siguiente paso y distinguir evidencia, propuesta y ejecución verificada. Esto orienta el modelo; no constituye una garantía de acierto ni añade capacidades a las herramientas.

Validación: contratos de preparación de empresa, límites/permisos del analizador, regresiones de configuración y preguntas, TypeScript y Chromium de componentes reales con backend/modelo simulados para revisión visual e interacciones. La prueba visual no valida persistencia con una sesión real ni rendimiento de voz/OpenAI. No se aplicaron migraciones ni se activaron rutinas de clientes en esta implementación. Los flujos existentes siguen requiriendo sus migraciones y workers operativos.

## Onboarding permanente y ampliado

`/onboarding` sustituye el checklist anterior por diez etapas agrupadas en empresa, información/equipo, operación y primera misión. Incluye ficha, encargo por dictado integrado, Feed/cerebro/integraciones, responsable, metas, manuales, navegador, mandatos, rutinas y cierre con evidencia. Siete bases participan en el progreso; navegador, autonomía y rutinas se revisan según la operación, sin obligar a conceder permisos para completar la configuración.

El inicio `/` con una sesión válida siempre abre la puesta en marcha. El enlace está fijado en el menú para administradores y miembros, en escritorio y móvil. Las marcas antiguas `dismissed_at` y la finalización del checklist de cinco pasos ya no deciden esta entrada. Ir a la agenda no oculta la configuración. Los enlaces profundos a módulos conservan su destino: no se interceptan con un modal.

Las etapas consultan datos con alcance de empresa; perfiles del navegador y rutinas respetan propiedad personal/compartida. Solo un administrador recibe el conteo de mandatos. Cada lectura fallida se representa como desconocida. El progreso señala bases disponibles, no acredita calidad, sincronización, disponibilidad del portal ni un proceso probado. El resultado final exige un asunto verificado. Se ofrece comprobación explícita y se conserva la etapa seleccionada en la URL.

No se agregaron tablas ni se modificaron permisos o datos de clientes. El encargo se edita con las acciones existentes y su control de revisión. Los formularios de las demás etapas permanecen en su módulo de origen, con enlaces de continuación.

### Diagnóstico, misión y revisión de resultados

La puesta en marcha ejecuta comprobaciones de lectura personales y por empresa:
conexiones registradas, documentos de espacios visibles, tabla de procesos,
rutinas activas y salud del servicio de navegador. Cada resultado explica la
operación afectada y distingue bloqueo de verificación pendiente. La salud HTTP
no certifica la credencial, Chromium ni el acceso a un portal; tener OAuth
registrado tampoco certifica que el proveedor acepte los permisos.

`/management/mission` reutiliza CaseEditor y el proceso de cartera. Después de
guardar conserva el asunto creado para continuar al cobro, las aprobaciones y
la evidencia. `/management/control` explica sus permisos efectivos, muestra los
mandatos existentes (globales o aislados por rutina), documentos visibles
con vigencia/reemplazo y las inconsistencias entre asuntos y señales.

El worker deja avisos dentro de Cortex por respuesta, falta de respuesta,
bloqueo y evidencia lista. No infiere destinatarios externos ni manda correos.
La migración 0132 agrega identidad permanente a los avisos: reintentar el mismo
suceso no incrementa su contador ni revive uno leído. El proceso conserva el
resultado y la respuesta dentro del asunto; nunca verifica un pago por respuesta.

`/management/review` consulta la última semana cerrada en Bogotá. Los cierres
requieren transición documentada a verified y evidencia, con revisión anterior
exacta; editar un asunto ya verificado no cuenta como cierre nuevo. La lectura
está acotada a 100 revisiones y declara truncamiento o antecedentes faltantes.
Los informes semanales guardados incorporan el mismo bloque. Los bloqueos y las
decisiones en la pantalla son la situación actual y se identifican como tal.
No se atribuyen ahorros o ingresos sin medición acordada.

### Mandatos por rutina, comparación de fuentes e historial de metas

La migración 0133 permite limitar un mandato a una rutina existente. Al concederlo,
la rutina queda en modo de mandatos: la autorización antigua de ejecución sin
preguntar deja de aplicar, incluso si después se revoca el mandato. Cada llamada
a una herramienta consulta de nuevo el estado y el propietario de la rutina.
Pausarla impide la siguiente acción; no revierte una acción ya iniciada. Una
rutina en este modo no hereda mandatos globales ni de otras rutinas. El chat no
puede usar permisos exclusivos de una rutina. Los bloqueos no delegables siguen
vigentes. Este alcance corresponde a rutinas ejecutables, no a todos los manuales.

La migración 0134 guarda revisiones personales de dos documentos visibles. El
usuario indica la decisión afectada; el modelo compara hasta ocho fragmentos por
fuente y solo se conservan propuestas con citas literales comprobadas. Se vuelve
a comprobar el acceso antes de guardar. Cada conclusión humana exige un criterio
y queda inmutable. No cambia el documento ni declara una fuente como verdad de
la empresa. La pantalla muestra hasta 50 revisiones recientes. No es un escaneo
exhaustivo de todas las contradicciones del cerebro.

La revisión semanal y el informe guardado incluyen altas y retiros de metas, con
objetivo, fecha y responsable. La definición de una meta es inmutable: cambiarla
requiere retirar la anterior y crear otra. Se declaran fallos y truncamiento.

La validación completa de cobro necesita factura, cuenta de correo y destinatario
autorizados. Las pruebas de componentes y SQL aisladas no sustituyen ese ensayo.
