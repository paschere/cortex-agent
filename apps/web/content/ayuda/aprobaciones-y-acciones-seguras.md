---
title: Aprobaciones y acciones seguras
summary: Revisa y aprueba lo que Cortex quiere hacer por ti y entérate de por qué nunca manda dos veces lo mismo.
category: automatizacion
module: general
route: /approvals
routes: [/actions, /commitments]
keywords: [aprobaciones, aprobar, rechazar, borradores, correos de cobro, permiso, confirmar, verificado, duplicado, enviar dos veces]
updated: 2026-10-03
order: 2
---

Cortex no manda un correo, no escribe en una tabla ni cambia algo importante por ti sin tu permiso. Todo eso te llega primero para que lo revises en **Aprobaciones** o en **Acciones**. Además, las acciones importantes están protegidas para no repetirse por error y, cuando se puede, Cortex comprueba que de verdad se hicieron.

## Paso a paso

1. Entra a [Aprobaciones](/approvals). En **Esperan tu permiso** está lo que Cortex quiere hacer y no hace sin ti. Cada tarjeta muestra cuánto tiempo le queda antes de vencer.
2. Toca **Ver lo que se va a enviar** para mirar exactamente qué saldría. Si está bien, toca **Aprobar y ejecutar**; si no, **Rechazar**.
3. Si hay varias parecidas, Cortex las agrupa: puedes aprobarlas de una vez o tocar **Revisar uno por uno**.
4. En la misma pantalla verás **Prospectos nuevos** y **Rutinas que fallan** (con **Ver el error** y **Ver en Rutinas**).
5. Entra a [Acciones](/actions) para ver los correos que Cortex ya redactó, por ejemplo cobros de cartera. En **Esperando tu aprobación** puedes **Editar** el borrador, **Aprobar y enviar** o **Descartar**.
6. Más abajo, **Enviadas, sin respuesta todavía** te muestra lo que salió y nadie ha contestado, y **Cerradas** lo que ya terminó. Los borradores que llevan más de cinco días esperando se agrupan con la pregunta «¿Los descarto?»: descartarlos no envía nada.

## Qué hace Cortex y qué haces tú

**Cortex:**
- Redacta el mensaje o prepara la acción y te la deja lista para revisar.
- Si algo ya se hizo y se intenta otra vez (un reintento, un doble clic en aprobar), no lo repite: te dice «Ya lo había hecho… no lo repetí». Esto cubre correos, eventos de calendario, pagos registrados y filas nuevas en tablas, entre otros.
- Después de un envío o un registro importante, revisa que haya quedado: un correo que aparece en Enviados sale como **Verificado**.

**Tú:**
- Apruebas, editas, rechazas o descartas. Nada de esto sale sin tu clic.
- Si de verdad quieres repetir algo, lo pides claro en el chat («sí, envíalo otra vez») y la tarjeta lo marca como repetición.

## Pídeselo en el chat

- «Prepárame el cobro de Coltrans»
- «Redacta un correo cordial para un cliente con una factura vencida y muéstramelo antes de enviarlo»
- «¿Qué tengo pendiente por aprobar?»

## Problemas comunes

**¿Por qué una tarjeta dice que repite algo?** Ya se hizo lo mismo hace poco (por ejemplo, el mismo correo en las últimas 24 horas). Si apruebas, se hace otra vez a sabiendas. Si no era tu intención, recházala.

**¿Qué significa «Aprobada; ya estaba hecha»?** Otra tarjeta igual se ejecutó antes. Cortex no la repitió.

**¿Por qué sale «No se pudo verificar»?** Cortex no logró confirmar el resultado en ese momento. No quiere decir que no se haya hecho: por ejemplo, Outlook a veces manda en diferido. Revisa tus Enviados antes de volver a intentar.

**¿Por qué desapareció una aprobación?** Las aprobaciones tienen un plazo («quedan 3h»). Si vence sin respuesta, no se ejecuta nada. Pídeselo de nuevo a Cortex si todavía lo necesitas.

**¿Dónde están los correos que Cortex redactó?** Los borradores listos para enviar están en [Acciones](/actions), no en Aprobaciones.

## Relacionado

- [Piloto automático y permisos «Sin preguntar»](/ayuda/piloto-automatico)
- [Vencimientos](/commitments)
