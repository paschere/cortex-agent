---
title: Subir extractos bancarios y conciliar
summary: Sube el extracto de tu banco en Excel o CSV y Cortex ata cada abono a la factura que paga sin duplicar nada.
category: plata
module: general
route: /payments
routes: [/finance, /pagar]
keywords: [extracto, extracto bancario, conciliar, conciliación, bancolombia, davivienda, bbva, banco de bogotá, abonos, movimientos del banco, csv, excel]
updated: 2026-10-03
order: 2
---

El extracto del banco es la prueba de lo que de verdad entró. Lo descargas de la banca en línea, lo subes en Pagos y Cortex toma los abonos, busca la factura que paga cada uno y te deja por revisar sólo lo dudoso. Te sirve cada vez que cierras la semana o el mes y quieres saber qué facturas se pagaron.

## Paso a paso

1. En la banca en línea descarga los movimientos de la cuenta en **Excel (.xlsx)** o **CSV**. El Excel antiguo (.xls) y el PDF no se leen: ábrelo en Excel y guárdalo como .xlsx o CSV. El archivo puede pesar hasta 10 MB.
2. Entra a [Pagos](/payments), baja hasta **Importar extracto del banco** y escoge el extracto en **Archivo**.
3. En **Cuenta** escribe un nombre para esa cuenta, por ejemplo «Bancolombia corriente 1234». Usa siempre el mismo nombre para la misma cuenta: así Cortex reconoce lo que ya importaste.
4. En **Moneda** elige la moneda de la cuenta. Cortex nunca la supone.
5. Toca **Ver qué trae**. Verás el banco detectado, el periodo, cuántos abonos hay, cuántos son nuevos, cuántos **Ya importados (se saltan)**, cuántos **Se atan solos**, cuántos quedan **Por revisar** y cuántos **Sin factura**, con la factura probable de cada abono. Todavía no se ha guardado nada.
6. Si sale **No reconocí todas las columnas**, indica en qué fila están los encabezados y qué columna es la fecha, los créditos, los débitos (o el valor con signo), la descripción, la referencia y el NIT de quien paga. Luego toca **Leer con estas columnas**.
7. Si todo cuadra, toca **Importar N abonos**. Si no, **Cancelar**.
8. Revisa **Conciliación del banco**, en la misma página. Tiene tres pestañas:
   - **Por revisar**: abonos con una o varias facturas probables y el porqué. Toca **Es esta** para atarlo, o abre la lista **Es otra factura…**, escoge cualquier factura abierta de la misma moneda y toca **Atar**.
   - **Sin factura**: abonos sin candidata. Abre **Escoger la factura…**, elige una y toca **Atar**.
   - **Atados a su factura**: los más recientes ya conciliados.

Se reconocen solos los formatos de Bancolombia, Davivienda, BBVA y Banco de Bogotá. Con otros bancos funciona si el archivo trae encabezados reconocibles; si no, escoges las columnas a mano.

## Qué hace Cortex y qué haces tú

**Cortex:**
- Lee sólo lo que entró como pago de clientes. Las salidas van al libro de [Finanzas](/finance) como gastos, y si alguna paga una factura de proveedor que estaba [por pagar](/pagar), la deja saldada.
- Ata solo un abono cuando no hay duda: valor exacto y el número de la factura o el NIT del cliente en la descripción, sin otra factura que compita.
- No duplica nada aunque subas el mismo archivo o meses que se cruzan.
- Si el banco y otra fuente (por ejemplo tu programa contable) dicen cosas distintas sobre un pago, lo saca de las cifras y lo pone en disputa.

**Tú:**
- Escoges la cuenta, la moneda y, si hace falta, las columnas.
- Confirmas cada abono dudoso con **Es esta** o escogiendo la factura. Queda con tu nombre.

## Pídeselo en el chat

Adjunta el archivo en el chat y escribe:

- «Mira este extracto de Bancolombia y dime qué trae antes de importarlo»
- «Importa este extracto a la cuenta Bancolombia corriente 1234 en pesos»
- «¿Qué pagos del banco no sé de qué son?»
- «Ata el abono de 4.500.000 del 12 de septiembre a la factura FE-1032»

Cortex siempre te muestra el resumen antes de importar y te pide confirmación para importar o atar un pago.

## Problemas comunes

**¿Por qué me dice que el archivo es de Excel antiguo o PDF?** Esos formatos no se leen. Exporta de nuevo desde la banca en línea en .xlsx o CSV, o abre el archivo en Excel y guárdalo como .xlsx.

**¿Por qué se duplicaron movimientos?** Casi siempre es porque cambiaste el nombre de la cuenta entre una importación y otra. Escoge el nombre de la lista de sugerencias para que coincida.

**¿Por qué un abono quedó Sin factura?** Puede que la factura no esté confirmada en Cortex, que sea de otra moneda, que ya esté pagada o que el abono sea anterior a la fecha de la factura. Confirma la factura y vuelve a mirar: la lista se recalcula cada vez que abres la página.

**¿Puedo repartir un abono entre varias facturas?** Todavía no. Cada abono se ata a una sola factura.

## Relacionado

- [Cartera y cobros](/ayuda/cartera-y-cobros)
- [Finanzas y proyección de caja](/ayuda/finanzas-y-proyeccion-de-caja)
- [Aprobaciones y acciones seguras](/ayuda/aprobaciones-y-acciones-seguras)
