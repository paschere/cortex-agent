---
title: Navegador y trámites en portales
summary: Enséñale a Cortex un trámite en un portal (DIAN, RUNT, SIMIT) para que lo repita, y entiende qué pasos siempre haces tú.
category: automatizacion
module: general
route: /browser
routes: [/errands]
keywords: [trámites, navegador, portal, dian, runt, simit, certificado, captcha, código del celular, firma electrónica, encargos]
updated: 2026-10-03
order: 4
---

En **Trámites**, Cortex abre un navegador propio donde entras a un portal (la DIAN, el RUNT, el SIMIT, una cámara de comercio o el portal de un cliente) y le enseñas un trámite haciéndolo una vez. Después lo puede repetir en segundos: sacar un certificado, consultar un estado, descargar facturas. Hay pasos que nunca hace solo, y este artículo te dice cuáles.

## Paso a paso

1. Entra a [Trámites](/browser). En **Perfil** elige o crea el tuyo (por ejemplo «Operaciones»). Tus cuentas quedan guardadas en ese perfil; es privado hasta que toques **Compartir con la compañía**, y puedes **Volver privado** cuando quieras.
2. Escribe la dirección del portal y toca **Abrir portal**. Inicia sesión dentro de Cortex antes de empezar.
3. Toca **Enseñar este trámite** y hazlo como siempre. Si el recorrido pasa por otro sitio, usa **Ir a otro sitio**. Con **Explicar este paso** le dejas contexto a un paso.
4. Toca **Terminar enseñanza**. Revisa los pasos, ponle **Nombre del trámite**, **Qué hace** y **Dirección de inicio**, y toca **Guardar propuesta** (o **Descartar enseñanza**). Lo que escribiste en los campos queda como variable, sin guardar su valor.
5. En la lista de trámites, abre el tuyo, llena los datos y toca **Correr** para probarlo. Su estado pasa de *Propuesto* a *Probado* cuando funciona; si el portal cambió, sale *Roto*.
6. Si quieres que corra solo dentro de un **Encargo**, marca **Cortex puede correr este trámite por su cuenta dentro de un encargo**. Los encargos se piden en [Encargos](/errands) con **Encargar**.

## Qué hace Cortex y qué haces tú

**Cortex:**
- Repite los pasos aprendidos, guarda lo que descarga en Brain Knowledge y te muestra qué hizo paso a paso.
- En una pestaña en vivo dentro del chat puede navegar un portal mientras lo ves; con **Tomar el control** conduces tú y con **Devolver el control** sigue él.
- Cuando llega a un paso que no puede hacer, se detiene y te pasa la pestaña. Si iba dentro de un encargo, el encargo queda en *Te pregunta algo* y te avisa.

**Tú:**
- **CAPTCHA o «no soy un robot».** Cortex no los resuelve. Te muestra la pantalla del portal, lo resuelves con tu mouse y tocas **Ya lo resolví, sigue** (o **Continuar el trámite** en el chat).
- **Código que llega al celular o al correo (OTP, SMS, doble factor).** El trámite se pausa y te lo pregunta. Lo escribes en la caja que aparece (o se lo dices en el chat) y sigue desde el mismo paso, en la misma sesión. El código sirve una sola vez y no se guarda.
- **Contraseñas.** Nunca las escribas en el chat. Inicias sesión tú en la pestaña, o en una caja enmascarada que va directo a la página; Cortex no ve el valor.
- **Firma electrónica** (por ejemplo, la de la DIAN). Cortex no firma: la haces tú en la pestaña en vivo.
- Apruebas cada trámite que radica, presenta, envía o paga algo en un portal. Esos siempre piden tu permiso, también dentro de un encargo.
- Decides si compartes un perfil: la compañía podrá usar las sesiones abiertas en él.

Cada pausa dura pocos minutos y la pantalla muestra el tiempo que queda. Si se vence, hay que correr el trámite otra vez.

## Pídeselo en el chat

Funcionan con trámites que ya le enseñaste, salvo la pestaña en vivo, que sirve para cualquier sitio:

- «Sácame el certificado de existencia de la empresa en el portal»
- «Consulta en el SIMIT si la placa ABC123 tiene multas»
- «Entra al portal del cliente y mira si ya aprobaron la factura»

## Problemas comunes

**¿El portal me vuelve a pedir la clave?** Los portales vencen su sesión según sus propias reglas. Abre el perfil e inicia sesión de nuevo.

**¿El trámite dice «Roto»?** Probablemente el portal cambió. Vuelve a enseñarlo.

**¿Se me pasó el tiempo de la pausa?** La pestaña se cierra sola a los pocos minutos. Corre el trámite otra vez.

**¿Un compañero no puede usar mi trámite?** Tu perfil es privado. Compártelo con la compañía; ni siquiera un administrador puede usar un perfil privado ajeno.

**¿Algo no se pudo enseñar?** Controles dibujados como imagen, arrastres o subir archivos a veces necesitan un paso manual. Una enseñanza admite hasta 60 pasos: si es más larga, divídela.

## Relacionado

- [Procesos listos para activar](/ayuda/procesos)
- [Aprobaciones y acciones seguras](/ayuda/aprobaciones-y-acciones-seguras)
