---
title: Atención a clientes por WhatsApp
summary: Cortex contesta a tus clientes por WhatsApp con tus datos (pedidos, facturas, saldo) y pasa a una persona lo que no sabe.
category: canales
module: whatsapp_service
route: /integrations/whatsapp/atencion
routes: [/integrations/whatsapp]
keywords: [whatsapp, atención al cliente, servicio al cliente, bot, estado del pedido, guía, rastreo, saldo, facturas pendientes, preguntas frecuentes]
updated: 2026-10-03
order: 2
---

Con **Atención a clientes**, cuando alguien que no es del equipo le escribe al número de WhatsApp de la empresa, Cortex le contesta con tus datos: el estado de su pedido o guía, sus facturas pendientes, su saldo y las preguntas frecuentes que tú apruebes. Lo que no sabe, una cotización, una queja o quien pide hablar con alguien, se lo pasa a una persona del equipo. Necesitas tener el número de la empresa conectado primero.

## Paso a paso

1. Conecta el número de la empresa en [WhatsApp](/integrations/whatsapp) y entra a **Atención a clientes**.
2. Ve a la pestaña **Ajustes** (solo un administrador puede cambiarlos). En **Encendido**, activa **Contestarle a los clientes que escriban** y define el **Máximo de respuestas automáticas por hora, por conversación**.
3. En **Qué se puede compartir** elige qué puede decir: **Estado de pedido o guía**, **Facturas pendientes de ESE cliente**, **Saldo de ESE cliente** y **Datos públicos de la empresa** (escribe abajo dirección, teléfonos, medios de pago).
4. En **Horario y mensajes** marca los días y horas de atención, y si quieres un saludo y un mensaje fuera de horario.
5. En **A quién se le pasa** elige la persona que atiende lo que el bot no resuelve (y, si quieres, el nombre del equipo).
6. En **Preguntas frecuentes aprobadas** usa **Agregar pregunta**: pregunta, palabras clave y la respuesta exacta. En **De dónde sale el estado de un pedido** usa **Agregar tabla** y elige la tabla de guías o pedidos y sus columnas (entrega estimada, cliente). Toca **Guardar ajustes**.
7. En la pestaña **Conversaciones** filtra por **Activas**, **Con una persona** o **Cerradas**. Al abrir una ves lo que escribió el cliente y lo que contestó Cortex, con de dónde salió cada dato. Con **Responder como persona** escribes y tocas **Enviar por WhatsApp**; también puedes **Cerrar** la conversación o tocar **Ver ficha** del cliente.

## Qué hace Cortex y qué haces tú

**Cortex:**
- Solo contesta a quien le escribió: nunca escribe primero ni hace envíos masivos, y respeta a quien pide no recibir más mensajes.
- Da facturas y saldo solo al propio cliente, cuando se identifica por el teléfono de un contacto suyo o con su NIT y el número de una de sus facturas. Nunca datos de otro cliente.
- Si no encaja con seguridad una pregunta frecuente o no entiende, pasa la conversación a la persona elegida, que recibe un aviso en la campana y la ve como trabajo suyo en Equipo.

**Tú:**
- Decides qué se puede compartir y apruebas las respuestas frecuentes.
- Contestas tú lo que se escala. Desde que respondes como persona, el bot no vuelve a meterse en esa conversación.

## Pídeselo en el chat

- «¿Quién escribió hoy por WhatsApp?»
- «¿Qué conversaciones están esperando a una persona?»
- «¿Qué le contestó el bot a Nexa?»
- «Contéstale a ese cliente que el pedido sale mañana» (te pide confirmación antes de enviar)

## Problemas comunes

**¿Por qué no puedo contestar una conversación?** Solo se puede dentro de las 24 horas desde el último mensaje del cliente, con la conversación abierta y si el cliente no pidió que no le escribieran. Si pasaron más de 24 horas, espera a que vuelva a escribir.

**¿Por qué no me deja responder aunque está abierta?** Solo un administrador o la persona que atiende esa conversación puede contestarla.

**¿Los clientes reciben «el número es solo para el equipo»?** La atención está apagada. Enciéndela en **Ajustes**.

**¿Sale «El número no está conectado»?** Vuelve a vincular el número de la empresa en [WhatsApp](/integrations/whatsapp).

**¿El bot no encuentra un pedido?** Revisa que la tabla de guías o pedidos esté agregada en **De dónde sale el estado de un pedido**. Si la guía es de otro cliente, Cortex responde que no la encontró.

## Relacionado

- [Vincular WhatsApp](/ayuda/whatsapp-vincular)
- [Clientes: todo de cada cliente en un lugar](/ayuda/clientes)
