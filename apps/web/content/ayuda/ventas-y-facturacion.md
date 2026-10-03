---
title: Ventas, cotizaciones y factura electrónica
summary: Cotiza con tu marca, deja que el cliente acepte desde un enlace y emite la factura electrónica por Siigo o Alegra con tu aprobación.
category: plata
module: sales
route: /ventas
routes: [/ventas/nueva, /clients]
keywords: [ventas, cotización, cotizar, pedido, factura electrónica, facturar, dian, siigo, alegra, iva, retenciones, cliente aceptó]
updated: 2026-10-03
order: 5
---

En Ventas armas cotizaciones con tu marca, se las mandas al cliente para que las acepte con un clic, las conviertes en pedido y emites la factura electrónica. La factura la emite tu programa contable (Siigo o Alegra) y siempre con tu aprobación. Te sirve para llevar todo el negocio de una venta en un solo lugar, sin copiar datos de un lado a otro.

## Paso a paso

1. Entra a [Ventas](/ventas). Arriba ves **Cotizado esperando respuesta**, **Aceptado sin facturar** y **Facturado este mes**, y pestañas para cotizaciones, pedidos y facturas.
2. Toca **Nueva cotización**. En **Cliente** escribe el nombre o el NIT. En **Qué se vende** busca el producto en el catálogo o escríbelo, pon la **Cantidad** y el precio, y usa **Agregar línea** para más.
3. Llena **Válida hasta**, la **Forma de pago** (**De contado** o **A crédito** con sus días), y si quieres **Notas para el cliente** y **Condiciones**. Si el cliente te practica retenciones, ábrelas en **Retenciones que practica el cliente (opcional)** para ver el **Neto a recibir**. Toca **Guardar cotización**.
4. En la cotización toca **Enviar**: escribe el correo en **Para** y un mensaje, y toca **Enviar por correo**. Sale desde tu correo con un enlace privado donde el cliente ve la cotización, descarga el PDF y toca **Aceptar cotización**. También puedes **Copiar enlace** y mandarlo por otro lado.
5. En **Seguimiento** ves si ya se envió, si **El cliente la abrió** y si fue **Aceptada** o **Rechazada**. Si el cliente aceptó por otro lado, toca **Marcar aceptada** y escribe quién la aceptó. Si dijo que no, anota el motivo: ayuda a cotizar mejor la próxima.
6. Con la cotización aceptada, toca **Convertir en pedido** si la vas a despachar por partes, o directamente **Facturar**.
7. Al facturar, Cortex le pregunta a tu programa contable cómo saldría la factura y te muestra cliente, documento, fecha, forma de pago y total. Si algo falla, verás **Antes de emitir hay que arreglar:** con la lista. Si todo está bien, toca **Aprobar y emitir** y confirma. Después puedes abrirla con **Ver en el programa**.

## Qué hace Cortex y qué haces tú

**Cortex:**
- Busca el cliente por nombre o NIT y cruza cada línea con el catálogo de productos de tu programa contable (lo necesita la factura electrónica).
- Calcula el IVA (19 % por defecto, o 5 %, 0 %, exento o excluido por línea), descuentos y retenciones, y numera las cotizaciones.
- Te muestra si el cliente ya abrió o aceptó la cotización.

**Tú:**
- Revisas y mandas la cotización. Cortex no la envía sola.
- Apruebas cada factura electrónica. Nunca se emite desde una rutina ni sin una persona: tu aprobación queda a tu nombre.
- Anulas una factura emitida desde tu programa contable, con nota crédito: desde Cortex no se puede deshacer.

## Pídeselo en el chat

- «Hazle una cotización a Nexa de 10 fletes Bogotá–Cali a $1.2M»
- «Mándale la COT-12 a compras@nexa.com»
- «¿Qué cotizaciones tengo pendientes? ¿Nexa aceptó?»
- «Factura la COT-12»

Crear, enviar y facturar desde el chat te pide confirmación. Antes de emitir, Cortex te muestra cómo quedaría la factura.

## Problemas comunes

**¿Por qué la factura dice «preparada» y no «emitida»?** No hay programa contable conectado. La factura queda preparada en Cortex, pero no se ha enviado a la DIAN. Un administrador conecta Siigo o Alegra en [Datos y conexiones](/integrations).

**¿Por qué no puedo emitir?** Mira la lista **Antes de emitir hay que arreglar:**. Lo común es una línea sin producto del catálogo del programa contable, un cliente sin NIT o que no está creado en el programa, o una factura en otra moneda: por ahora Cortex sólo emite facturas en pesos. Los errores del programa contable te llegan en español con lo que hay que corregir.

**¿Por qué no se pudo enviar la cotización?** Se manda desde tu Gmail o Outlook, así que tu correo debe estar conectado. Si la cotización no tiene correo del cliente, escríbelo en **Para**.

**¿Los precios incluyen IVA?** No: los precios van antes de IVA, salvo que digas otra cosa. El IVA se suma por línea.

## Relacionado

- [Cartera y cobros](/ayuda/cartera-y-cobros)
- [Inventario y compras](/ayuda/inventario)
- [Impuestos y calendario tributario](/ayuda/impuestos)
