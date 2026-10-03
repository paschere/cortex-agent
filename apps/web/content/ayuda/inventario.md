---
title: Inventario y compras
summary: Lleva existencias por bodega, mira qué hay que pedir antes de que se acabe y maneja las órdenes de compra hasta que llega la mercancía.
category: operacion
module: inventory
route: /inventario
routes: [/approvals, /pagar]
keywords: [inventario, existencias, stock, bodega, orden de compra, compras, reponer, mínimo, conteo, proveedor, kardex, costo promedio]
updated: 2026-10-03
order: 2
---

Inventario y compras te muestra lo que hay en cada bodega y cuánto vale, te dice qué hay que pedir antes de que se acabe y lleva cada orden de compra desde que se aprueba hasta que llega la mercancía y la factura. Te sirve si compras y vendes productos y quieres dejar de enterarte de que algo se acabó cuando ya no hay.

## Paso a paso

1. Entra a [Inventario y compras](/inventario). Si tienes Siigo, Alegra o QuickBooks conectado, los productos y existencias llegan de ahí. Si no, toca **Importar hoja**: sube un CSV o pega las filas con encabezados (código, producto, existencias, mínimo, cantidad a pedir, costo, proveedor, días de entrega) y toca **Importar**.
2. En **Productos** ves existencias, valor al costo promedio y alertas. Abre un producto para ver su **Consumo por semana**, sus **Movimientos** y cuánto hay **Por bodega**.
3. Para registrar un movimiento, en el producto usa **Registrar**: escoge **Entrada**, **Salida** o **Conteo**, la cantidad y la **Bodega**, y toca **Registrar entrada**, **Registrar salida** o **Ajustar al conteo**. En **Reposición** fija el **Mínimo**, la **Cantidad a pedir** y los **Días de entrega**, y toca **Guardar**.
4. En **Por reponer** ves lo que hay que pedir, agrupado por proveedor, ya descontando lo que viene en camino. Si falta el proveedor de un producto, escríbelo y toca **Fijar proveedor**. Luego toca **Crear órdenes de compra** (o **Sólo esta orden**).
5. En **Órdenes de compra** filtra por **Abiertas**, **Por aprobar**, **En camino** o **Todas**. En cada orden puedes **Pedir aprobación**, **Aprobar**, **Aprobar y enviar** o **Enviar al proveedor**: sale un correo desde tu Gmail con el PDF de la orden con la marca de tu empresa.
6. Cuando llegue la mercancía, toca **Recibir mercancía**, escribe lo que llegó y toca **Registrar lo recibido**. Si llegó una parte, lo que falte queda pendiente.
7. En **Bodegas** creas una con **Nueva bodega** y **Crear bodega**. En **Conteo** escoge la bodega, escribe lo **Contado** de cada producto y toca **Guardar conteo**: sólo se ajusta lo que no cuadra.

## Qué hace Cortex y qué haces tú

**Cortex:**
- Calcula el costo promedio, el consumo diario y cuántos días te alcanza cada producto.
- Te avisa lo agotado, lo que está bajo el mínimo, lo que se acabará antes de que llegue un pedido y lo que no se mueve.
- Sugiere cantidades a pedir con la cuenta que las justifica.
- Cuando llega la factura del proveedor de una orden, la marca **Facturada** y la cruza con [Por pagar](/pagar). Las órdenes aprobadas entran en la proyección de caja.

**Tú:**
- Apruebas las órdenes de compra. Sólo quien administra la empresa o quien aprueba las compras de ese proveedor puede hacerlo; las pendientes salen en [Aprobaciones](/approvals).
- Decides enviarlas: Cortex no le escribe al proveedor sin que tú lo confirmes.
- Registras lo que llegó y los conteos.

## Pídeselo en el chat

- «¿Qué está bajo el mínimo?»
- «¿Qué tengo que comprar esta semana?»
- «Pídele a Ferretería Central 200 tornillos 10mm a $300»
- «De la OC-12 llegaron 30 de los 50 guantes»

Registrar movimientos, crear, enviar o recibir órdenes desde el chat te pide confirmación.

## Problemas comunes

**¿No veo Inventario y compras en el menú?** Es un módulo que viene apagado: no todas las empresas manejan bodega. Un administrador lo prende en [Ajustes → Módulos](/settings/modulos).

**¿Por qué un producto no aparece en Por reponer?** Necesita un mínimo o consumo para calcular, y Cortex ya descuenta lo que viene en órdenes abiertas. Revisa el **Mínimo** en **Reposición**.

**¿Por qué no puedo enviar la orden al proveedor?** La orden debe estar aprobada, el proveedor necesita un correo y tu Gmail debe estar conectado en [Datos y conexiones](/integrations).

**¿Por qué cambió el costo de un producto?** Cada entrada con costo, y cada recepción de una orden, actualiza el costo promedio ponderado.

**¿Cancelar una orden le avisa al proveedor?** No. La orden sale de la proyección de caja y se retira su aprobación pendiente, pero al proveedor tienes que avisarle tú.

## Relacionado

- [Cuentas por pagar](/ayuda/por-pagar)
- [Ventas, cotizaciones y factura electrónica](/ayuda/ventas-y-facturacion)
