# Cortex: identidad, empresas y modo fundador

Decisiones acordadas con el usuario el 6 de septiembre de 2026. Una identidad puede ser propietaria en una empresa y colaboradora en otra. Ser propietario del espacio personal nunca otorga permisos empresariales.

## Contrato de producto

- Cada cuenta tiene un espacio personal automático y exclusivo, con asuntos, cerebro, herramientas y procesos propios. La migración no mueve contenido existente: las organizaciones actuales siguen siendo empresas.
- El inicio global muestra espacios autorizados, decisiones, pendientes, bloqueos y acceso al detalle. El rol se resuelve por empresa. No se consolidan monedas, periodos o indicadores incompatibles.
- Cada pestaña fija su contexto empresarial en `?workspace=`. El servidor revalida la membresía; un contexto revocado nunca cae silenciosamente en otra empresa. Las rutas globales permiten volver al inicio incluso después de perder acceso a un espacio.
- El chat global usa selección explícita: algunos, todos o ninguno. Ninguno significa sin herramientas ni cerebros, no el espacio personal. Cambiar el alcance inicia otra conversación.
- El historial global pertenece a la identidad, no al cerebro personal ni al de una empresa. Reabrirlo exige conservar las membresías de todos los espacios fuente.
- Una acción global tiene destino explícito, input validado e inmutable y aprobación individual. Las acciones con varias fuentes requieren propiedad actual en todos los espacios fuente; la pertenencia como trabajador no permite transferir información de un empleador.
- Los fundadores pueden supervisar trabajo corporativo, chats e informes. Esto se informa a los miembros. La supervisión es de lectura: no permite continuar conversaciones como su autor ni entrar a sus espacios personales.
- Los grupos empresariales organizan compañías y no otorgan membresías, permisos ni conexiones.
- Las notificaciones son globales por identidad, con empresa visible, filtros, prioridad y resumen plegable. El stream vuelve a comprobar membresías y sesión.
- Al retirar una membresía se conservan los registros corporativos y se pausan rutinas/consulta de correo; se revocan las conexiones y tokens privados de esa persona en esa empresa. Sus otros espacios permanecen intactos.
- Pagos ejecutables, borrados y cambios de acceso identificados en el catálogo requieren aprobación humana, incluso con mandatos. El chat comprueba la propuesta persistida y reclama la ejecución atómicamente antes de actuar.

## Integración implementada

Rutas: `/overview`, `/chat/global`, `/notifications`, `/team/activity` y sus APIs. Se reutilizan el directorio por organización, los cerebros/espacios existentes, los permisos de herramientas, la seguridad y ejecución del registro de herramientas, el onboarding empresarial, los perfiles de navegador y las conexiones por tenant.

Migraciones: `0137_personal_workspaces`, `0138_member_offboarding`, `0139_global_conversations`, `0140_company_groups`, `0141_global_action_proposals`. No se borran ni se reclasifican los documentos existentes.

El alcance de consulta global inicial incluye cerebros, Gmail, metas y pendientes mediante una lista de lectores revisada. La preparación global incluye herramientas del registro que requieren confirmación y una lista explícita de operaciones de gestión. Las APIs personalizadas y servidores MCP siguen disponibles dentro de su empresa; su ejecución global dinámica no se ha añadido.

## Límites que deben conservarse visibles

- La actualización de avisos usa SSE con consulta periódica del servidor (3 segundos), no eventos de base de datos instantáneos. Revalida la sesión cada 10 segundos y reconecta al cerrar la función.
- Una revocación no puede deshacer una llamada externa que ya comenzó; la salida detiene el acceso posterior y el trabajo que todavía no empezó. El cierre remoto inmediato de una sesión de navegador ya abierta requiere trabajo adicional.
- El historial global se limita a 100 mensajes por conversación; la UI lista las 50 conversaciones más recientes. Cada conversación admite 30 propuestas de acción.
- Las acciones globales inciertas no se reintentan automáticamente. Es necesario comprobar evidencia antes de formular otra propuesta.
- El resumen plegable de notificaciones es una preferencia de presentación local. No reemplaza las preferencias de entrega, horarios y canales de cada empresa.
- Facturación por empresa con nivel personal gratuito/ampliable es dirección acordada; no se cambiaron tarifas ni checkout. Las respuestas globales se contabilizan en el espacio personal.
- Compartir bibliotecas entre empresas mediante copia versionada o referencia revocable requiere un flujo específico posterior; esta entrega mantiene separación y no copia cerebros automáticamente.
- La interfaz de transferencias de propiedad con verificación reforzada y la delegación granular de supervisión a gerentes son trabajo posterior. En esta entrega la supervisión completa se limita a propietarios; el overview de administradores conserva los permisos existentes.

## Validación

Pruebas unitarias focalizadas de autenticación, propiedad, contexto por pestaña, notificaciones, aprobaciones y seguridad; migraciones y operaciones SQL ejecutadas con PGlite y fixtures aislados. QA visual con componentes reales, datos ficticios y streaming/aprobación simulados en escritorio y móvil de 390 px. Las pruebas de fixtures no equivalen a validación autenticada completa de producción.
