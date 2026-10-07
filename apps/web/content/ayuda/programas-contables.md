---
title: Conectar Siigo, Alegra o QuickBooks
summary: Conecta tu programa contable y Cortex inicia la carga de terceros, productos, ventas y pagos; Siigo también carga el historial de compras.
category: conexiones
module: general
route: /integrations
routes: [/trackers]
keywords: [siigo, alegra, quickbooks, contabilidad, programa contable, facturas, recibos de caja, pagos, cartera, sincronizar, world office, helisa]
updated: 2026-10-06
order: 2
---

Si llevas la contabilidad en **Siigo Nube**, **Alegra** o **QuickBooks Online**, conéctalo una vez y Cortex comienza a traer terceros, productos, facturas de venta y pagos recibidos a tablas de la empresa. Las facturas con saldo entran a la cartera y a la plata en riesgo. En Siigo también se cargan las facturas de compra a cuentas por pagar.

## Paso a paso

1. Entra a [Datos y conexiones](/integrations) y baja a **Conecta algo nuevo**, grupo **Programa contable**. Ahí está la tarjeta de cada programa. Solo los dueños y administradores de la empresa pueden conectarlo o cambiarlo.
2. En la tarjeta elige qué traer (Clientes, Productos, Facturas de venta y Pagos recibidos, que en Siigo se llaman Recibos de caja), **Cada cuánto** (de cada 15 minutos a una vez al día; por defecto, cada hora) y si quieres la casilla **Avisarme cuando entren facturas o pagos nuevos**.
3. Pon la llave según tu programa:
   - **Siigo**: en Siigo Nube, menú Alianzas, «Mi credencial API». Copia el usuario API y la access key y pégalos en la tarjeta.
   - **Alegra**: en Alegra, Configuración, «API - Integraciones con otros sistemas». Copia el correo de la cuenta y el token.
   - **QuickBooks**: no hay llave que copiar. Toca **Conectar con QuickBooks**, entra con tu usuario de Intuit, elige la empresa y da permiso de lectura.
4. En Siigo y Alegra toca **Probar y conectar**. Cortex prueba la llave contra el programa antes de guardarla: si no sirve, no se guarda y te dice por qué.
5. En **Siigo**, la primera carga recorre todos los terceros (clientes, proveedores y otros; activos e inactivos), productos, facturas de venta, recibos de caja y facturas de compra disponibles por API. Puede necesitar varias corridas: la tarjeta indica qué categorías siguen cargándose. En Alegra y QuickBooks, la primera carga de facturas y pagos cubre el último año. Al terminar, la tarjeta muestra qué trajo y enlaza las tablas en [Tablas](/trackers).
6. Después tienes **Sincronizar ahora**, **Ajustes** (qué traer, frecuencia, avisos y **Pausar la sincronización**), **Cambiar llave** (en QuickBooks, **Volver a conectar**) y **Desconectar**.

## Qué hace Cortex y qué haces tú

**Cortex:**
- Trae lo nuevo y lo modificado en cada corrida, sin duplicar filas.
- En Siigo, repasa periódicamente el historial de compras para captar correcciones antiguas.
- Pone las facturas en la cartera con el saldo que dice tu programa, que ya descontó los pagos.
- Respeta las columnas que tu equipo agregue a esas tablas, como «gestor» o «notas».

**Tú:**
- Conectas el programa (la llave nunca pasa por el chat).
- Decides qué traer y cada cuánto.
- Esta sincronización solo lee. Otras acciones, como emitir una factura, tienen su propia aprobación.

## Pídeselo en el chat

- «¿Cómo va la conexión con Siigo? ¿Cuándo trajo datos por última vez?»
- «Trae ya las facturas nuevas de Alegra.» (te pide confirmar antes)
- «¿Por qué no me aparecen las facturas de QuickBooks en la cartera?»

## Problemas comunes

**¿No veo la tarjeta para conectar, o no me deja?** Solo un dueño o administrador de la empresa puede conectar o cambiar el programa contable. Pídeselo a esa persona.

**¿La tarjeta de QuickBooks dice «Falta configurar la app de QuickBooks»?** La conexión con Intuit todavía no está registrada en tu instalación y el botón queda apagado. Escríbele al equipo de Cortex.

**¿Dice «Con error»?** Lee el mensaje en la tarjeta. Lo más común es una llave que cambió o venció: usa **Cambiar llave** (o **Volver a conectar** en QuickBooks). En Alegra, la cuenta suspendida o un plan sin acceso a la API también lo causan.

**¿Un abono no se refleja en el saldo de una factura vieja de Alegra?** Alegra no avisa qué facturas cambiaron, así que el pago aparece en la tabla de pagos en la hora, pero el saldo de esa factura se corrige en el repaso diario (hasta 24 horas).

**¿Uso otro programa, como World Office o Helisa?** Todavía no se conecta directo. Exporta el archivo desde tu programa y súbelo con **Subir el archivo** en la tarjeta **Otro programa contable**: Cortex lo lee y te propone la tabla.

**¿Si desconecto pierdo lo que ya trajo?** No. Desconectar borra la llave y deja de traer datos, pero las tablas, la cartera y los pagos se quedan.

## Relacionado

- [Cartera y cobros](/ayuda/cartera-y-cobros)
- [Tablas y vistas](/ayuda/tablas-y-vistas)
- [Pulso de la empresa: cómo va todo en una vista](/ayuda/pulso-de-la-empresa)
