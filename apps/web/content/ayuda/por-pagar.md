---
title: Cuentas por pagar
summary: Recibe las facturas de tus proveedores, revisa lo raro, apruébalas y programa cada pago contra la caja.
category: plata
module: payables
route: /pagar
routes: [/finance]
keywords: [por pagar, cuentas por pagar, proveedores, facturas de proveedor, aprobar facturas, programa de pagos, retenciones, retefuente, doble cobro, factura electrónica]
updated: 2026-10-03
order: 4
---

Por pagar reúne las facturas de tus proveedores desde que llegan hasta que se pagan. Cortex las recibe solas, las revisa en busca de cosas raras y te propone qué día pagar cada una sin que la caja baje del mínimo. Te sirve para no pagar dos veces la misma factura y para saber qué sale cada semana.

## Paso a paso

1. Entra a [Por pagar](/pagar). Arriba verás **Por aprobar**, **Aprobadas sin día**, **Pagos esta semana** y **Vencidas sin pagar**.
2. Las facturas llegan solas: del correo conectado (el ZIP o XML de la factura electrónica), de los PDF que confirmes como «por pagar» en la Bandeja y de las compras de tu programa contable. Toca **Revisar el correo ahora** si acabas de recibir una y no la ves.
3. Si te llegó una factura por otro lado, toca **Anotar una factura** y llena **Proveedor**, **Número de la factura**, **Emitida**, **Vence** y **Total con IVA** (el NIT y el IVA son opcionales). Luego toca **Anotar**.
4. En la pestaña **Facturas** abre una para ver el detalle: valores, retenciones, el valor **A pagar (neto)**, la orden de compra y quién aprueba. En **Lo que encontró la revisión** verás alertas como posible doble cobro, factura a nombre de otro NIT, precio fuera de lo normal, retención que falta o diferencias con la orden de compra. Lo marcado como **Detiene** no deja pasar la factura a aprobación hasta que se resuelva.
5. Decide con **Aprobar**, o con **Rechazar** escribiendo **Por qué no se paga**. Una rechazada se puede **Reabrir** después.
6. Con la factura aprobada, toca **Programar el pago**. Cortex propone el día: el vencimiento, o una semana después si pagar ese día dejaría la caja por debajo del mínimo. Puedes cambiarlo con **Cambiar el día**.
7. Cuando pagues en el banco, toca **Marcar pagada** y escribe la fecha y el número del comprobante. Si subes el extracto, Cortex reconoce la salida y la marca pagada solo.
8. En **Programa de pagos** ves lo que sale cada semana contra la **Caja al cierre**, y si alguna semana queda **Debajo del mínimo**. Con **Programar todas contra la caja** le pones día a todas las aprobadas de una vez.
9. En **Proveedores** defines por cada uno el plazo, las retenciones (ReteFuente, ReteIVA, ReteICA) y quién aprueba sus facturas.

## Qué hace Cortex y qué haces tú

**Cortex:**
- Lee las facturas que llegan al correo sin archivar, etiquetar ni responder nada. Las notas crédito y débito se anotan pero no se pagan.
- No duplica una factura: reconoce el mismo proveedor y número, o el mismo código CUFE.
- Revisa cada factura y propone el día de pago contra la proyección de caja.

**Tú:**
- Apruebas o rechazas. Sólo aprueba quien está asignado como aprobador del proveedor, un dueño o un administrador.
- Pagas en el banco. Cortex nunca mueve plata: aprobar y programar no pagan nada.
- Configuras plazos, retenciones y aprobadores (sólo dueños o administradores).

## Pídeselo en el chat

- «¿Qué facturas de proveedor tengo por aprobar?»
- «Llegó la factura 1234 de Papelería El Cóndor por 2.380.000, vence el 28»
- «¿Qué hay que pagar esta semana y alcanza la caja?»
- «Aprueba las facturas de Transportes Andinos y prográmalas contra la caja»

Anotar, aprobar, rechazar o programar desde el chat te pide confirmación.

## Problemas comunes

**¿Por qué no llegan las facturas del correo?** Necesitas tu correo de Gmail o Outlook conectado en [Datos y conexiones](/integrations). Cortex lee los adjuntos ZIP o XML de la factura electrónica; un PDF suelto no basta, súbelo a la Bandeja o anota la factura a mano.

**¿Por qué no puedo aprobar una factura?** Puede que tenga una alerta que la detiene, o que el aprobador de ese proveedor sea otra persona. Un dueño o un administrador siempre puede aprobar.

**¿Por qué el día de pago quedó después del vencimiento?** Pagar en la fecha de vencimiento dejaba la caja por debajo del mínimo. Cortex te dice cuántos días la movió y por qué; puedes escoger otro día con **Cambiar el día**.

**¿Por qué no puedo marcar varias como pagadas a la vez?** Pagada se marca una por una, con su comprobante.

## Relacionado

- [Finanzas y proyección de caja](/ayuda/finanzas-y-proyeccion-de-caja)
- [Subir extractos bancarios y conciliar](/ayuda/extractos-bancarios)
- [Inventario y compras](/ayuda/inventario)
