# Conectar una API de empresa con documentación

Integraciones enlaza a Herramientas propias (`/tools#herramientas-propias`). El
administrador describe la tarea, indica la URL base y pega documentación, carga
texto/OpenAPI JSON o YAML (50 KB) o proporciona un enlace público sin parámetros.
Cortex prepara una operación por vez y ofrece preguntas que pueden responderse
para regenerar el borrador. Es interpretación asistida, no un importador completo
del estándar OpenAPI. No ejecuta la API ni guarda la documentación en el cerebro.
El contenido se envía al modelo configurado y las credenciales se introducen aparte.

El lector de documentación reutiliza el cliente HTTP con IP validada, HTTPS,
límite de tamaño y timeout. No sigue redirecciones ni transmite credenciales.
Documentación privada o renderizada con JavaScript debe pegarse o cargarse como
texto. Preparación limitada a administradores, cuota del plan y 3 solicitudes por
minuto y persona. No lee ni escribe herramientas de otras empresas.

El servidor valida el borrador con el contrato HTTP existente y restringe su
origen al de la API indicada. Descarta credenciales y cabeceras generadas salvo
Accept/Content-Type; las cabeceras adicionales se revisan manualmente. Fuerza
confirmación, HTTPS, sin redirecciones y estado desactivado. No puede preparar
OAuth, firmas dinámicas ni operaciones que requieren varias peticiones.

El formulario guiado muestra propósito y acceso, con detalles técnicos plegados.
Guardar reutiliza `/api/custom-tools`, con cifrado y alcance de empresa existentes,
y abre el probador. La prueba realiza una llamada real: puede modificar datos si la
operación es de escritura. Activar sigue siendo una decisión posterior del admin.
El siguiente turno de chat carga las herramientas activas por empresa mediante el
motor existente, con permisos, confirmaciones y auditoría.

Validación: pruebas de aislamiento de la preparación, entradas inválidas, origen,
credenciales generadas, postura del borrador y documentación bloqueada; recorrido
visual con respuesta de modelo simulada. Una integración privada completa requiere
la documentación y credenciales de su proveedor, y una prueba autorizada.
