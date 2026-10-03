---
title: Cartera y cobros
summary: Mira cuánto te deben de verdad, anota los pagos que entran y deja que Cortex prepare los correos de cobro para que tú los apruebes.
category: plata
module: general
route: /payments
routes: [/clients, /actions, /piloto]
keywords: [cartera, cobros, cobrar, cuentas por cobrar, quién me debe, facturas vencidas, pagos, abonos, disputa, mora, recuperado]
updated: 2026-10-03
order: 1
---

La cartera es lo que te deben tus clientes: facturas confirmadas menos los pagos que ya entraron. En [Pagos](/payments) ves esa cifra con su base, anotas lo que te pagan y resuelves cuando dos fuentes no coinciden. Desde ahí y desde la ficha de cada cliente, Cortex te ayuda a cobrar lo vencido sin mandar nada sin tu visto bueno.

## Paso a paso

1. Entra a [Pagos](/payments). Arriba verás cuatro cifras:
   - **Cartera**: lo que te deben, a cuántos días y en cuántas facturas. Sólo cuenta facturas que alguien confirmó, y cada moneda va aparte.
   - **Sin revisar**: facturas leídas que todavía no entran en la cifra. Confírmalas para que cuenten.
   - **En disputa**: pagos que dos fuentes cuentan distinto.
   - **Sin emparejar**: pagos que todavía no tienen factura.
2. Para anotar un pago a mano, ve a **Anotar un pago**: llena **Valor**, **Moneda**, **Fecha del pago** y **Qué fue** (un abono, una anulación o devolución, o un ajuste). Si lo sabes, escoge el **Cliente** y escribe la **Factura que paga** y la **Referencia**. Toca **Registrar**. Si otra fuente ya lo había reportado, no se duplica: se enlaza.
3. En **Pagos en disputa** verás lo que dijo cada fuente (por ejemplo el banco y tu programa contable). Marca el valor correcto y toca **Dar por bueno este valor**, o toca **El pago no era real** para descartarlo. Mientras siga en disputa, ese pago no suma ni resta en ninguna cifra.
4. Para cobrar a un cliente, abre su ficha en [Clientes](/clients) y toca **Cobrar**. Se abre el chat con la orden de redactar el correo de cobro de sus facturas vencidas; Cortex lo deja en [Acciones](/actions) para que lo revises y lo apruebes.
5. Debajo de las cifras, **Recuperado con Cortex** te muestra cuánta plata entró este mes y en total por facturas que pagaron después de un cobro de Cortex.

Para traer los pagos del banco en bloque, mira [Subir extractos bancarios y conciliar](/ayuda/extractos-bancarios).

## Qué hace Cortex y qué haces tú

**Cortex:**
- Calcula la cartera sólo con facturas confirmadas y te dice cuántas quedan por fuera.
- Redacta correos de cobro y los deja esperando tu aprobación.
- Si le pides hacerle seguimiento a una factura desde [Gerencia](/management) con **Preparar un cobro**, revisa cada 15 minutos si hubo respuesta o pago y prepara el borrador.
- Si tienes encendido el [Piloto automático](/piloto) para cobros, cada mañana propone un correo para las facturas vencidas a 1, 30, 60 y 90 días.
- Si un borrador de cobro lleva un día esperando, te lo recuerda (un solo aviso por día). A los cinco días te pregunta si lo descarta, antes de que venza solo a los siete.

**Tú:**
- Apruebas cada correo de cobro antes de que salga. Ningún mensaje a un cliente sale sin que alguien lo mire, ni siquiera con el Piloto encendido.
- Decides qué versión vale en una disputa. Cortex sólo ordena las fuentes; no escoge por ti.
- Confirmas las facturas para que entren en la cartera.

## Pídeselo en el chat

- «¿Cuánto nos deben y cuánto hay vencido?»
- «¿Qué nos ha pagado Constructora Altos este mes?»
- «Cobra a Constructora Altos: redacta el correo de cobro de sus facturas vencidas y propónmelo para aprobar»
- «¿Cuánto me has ayudado a recuperar este mes?»

Registrar un pago o cerrar una disputa desde el chat siempre te pide confirmación.

## Problemas comunes

**¿Por qué la cartera sale más baja de lo que espero?** Sólo cuentan las facturas confirmadas. Mira la cifra **Sin revisar**: esas facturas están leídas pero nadie las ha confirmado. También puede haber pagos en disputa que no restan hasta que los resuelvas.

**¿Por qué no se suman pesos y dólares?** Cada moneda es su propia cartera. Cortex nunca convierte ni mezcla monedas, y por eso la moneda es obligatoria al anotar un pago.

**¿Por qué el correo de cobro no se envió?** Los cobros siempre esperan aprobación en [Acciones](/actions). Si el cliente no tiene contacto principal con correo, el Piloto sólo cuenta la factura y no prepara correo. Además necesitas tu correo conectado en [Datos y conexiones](/integrations).

**¿Por qué «Recuperado con Cortex» no cuenta un pago?** Sólo suma pagos que llegaron dentro de 45 días después de un cobro de Cortex, hasta lo que se debía y una sola vez. Es una cifra conservadora a propósito.

## Relacionado

- [Subir extractos bancarios y conciliar](/ayuda/extractos-bancarios)
- [Ventas, cotizaciones y factura electrónica](/ayuda/ventas-y-facturacion)
- [Piloto automático](/ayuda/piloto-automatico)
- [Clientes](/ayuda/clientes)
