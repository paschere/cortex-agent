# Aprender del correo (Gmail)

Cortex puede leerse el buzón de una persona, guardarlo en su cerebro, y volver
cada mañana a leer sólo lo que llegó desde el día anterior. Este documento dice
exactamente qué lee, dónde lo guarda, quién puede verlo, qué hace por su cuenta
y cómo se apaga.

---

## Qué hace, en tres frases

1. **La carga histórica.** Al encenderlo, se trae hasta un año de
   correspondencia y la convierte en documentos buscables del cerebro: cada hilo
   es un documento, con quién escribió cada mensaje y cuándo.
2. **El barrido.** Cada diez minutos lee lo que entró desde el puntero anterior
   y lo archiva igual.
3. **Lo que propone.** De ese correo nuevo, elige como mucho **cinco al día**
   (ventana móvil de 24 h) de hilos de gente de fuera que están esperando
   respuesta y deja un borrador en `/actions`, para que una persona lo apruebe,
   lo edite o lo descarte.
4. **De qué avisa en el momento.** Ver más abajo; viene apagado.

**Nunca envía nada solo.** Aprobar es siempre un acto humano.

---

## Avisarte en el momento

El barrido corre **cada diez minutos** (antes era una vez al día). De lo que
encuentra, Cortex **interrumpe** solo cuando hay una razón para no esperar al
resumen de mañana:

| Razón | Cuándo |
|---|---|
| **Compromiso** | Escribió alguien con quien tienes algo prometido con fecha |
| **Cliente** | El dominio de quien escribe está registrado a nombre de un cliente |
| **Espera** | Alguien de fuera escribió y la respuesta está de tu lado |

Antes de eso pasa los filtros de siempre: lo interno no cuenta, los boletines no
cuentan, y si el último que habló fuiste tú tampoco. Es **el mismo criterio** con
el que se decide qué respuesta proponer (`mail/attention.ts`), a propósito: si
algo no merece un borrador, tampoco merece una interrupción.

**Los tres frenos**, en *Ajustes → Avisarme en el momento*:

- **Un hilo avisa una sola vez.** La segunda ya no es noticia, es seguimiento.
- **Un techo**, cinco por defecto, en una ventana móvil de 24 horas — no por día
  natural, que se puede agotar a las 23:50 y llenarse otra vez a las 00:10.
- **Una franja horaria**, la de tu zona. Fuera de ella no suena nada.

**Viene apagado.** Y lo que no avisa no se pierde: se archivó igual y sale en el
resumen de la mañana. La diferencia entre avisar y no avisar es *cuándo* te
enteras, nunca *si* te enteras.

> Al pasar de diario a cada diez minutos hubo que mover el techo de propuestas de
> respuesta: era «cinco por barrido», que con esta cadencia serían 720 al día.
> Ahora es un presupuesto de 24 horas.

---

## Lo que venía adjunto

Desde la migración 0124, **los archivos que trae el correo entran también** —
cada uno como su propio documento del cerebro, colgado del hilo que lo trajo.
Antes quedaba archivada la frase «te adjunto el contrato» y no el contrato.

| Entra | No entra |
|---|---|
| PDF, DOCX, TXT, MD, CSV | Todo lo demás (hojas de cálculo, .zip, vídeo…) |
| Hasta 25 MB | Más de 25 MB |
| Adjuntos de verdad | Firmas, logos incrustados, `.ics`, `.vcf`, `smime.p7s` |

Un adjunto **descartado también deja constancia**, con el motivo, en
`mail_attachment_ingests`. Sin eso el barrido volvería a descargarse el mismo
vídeo de 30 MB cada mañana para volver a tirarlo — y nadie podría contestar «¿por
qué no está la propuesta que me mandaron?».

Un PDF escaneado sin capa de texto se anota como *«no tiene texto dentro (puede
ser un escaneo sin OCR)»*: no es un fallo, es algo que hoy no se sabe leer.

El **archivo original se guarda**, no sólo su texto, así que se puede abrir,
descargar y volver a extraer el día que haya un parser mejor. El mismo archivo
reenviado tres veces es **un** documento: se de-duplica por `sha256` dentro del
espacio.

Lo mismo vale para Outlook, con el mismo código (`mail/attachments.ts`).

---

## Qué correo entra, y dónde queda

| Destino | Qué entra | Quién lo puede buscar |
|---|---|---|
| **Espacio personal** (el de siempre, el que se crea solo) | El buzón entero: clientes, proveedores **y correo interno** | Sólo su dueño |
| **Espacio compartido** de la empresa | Sólo hilos donde hay alguien de fuera de los dominios de la empresa | Todo el que pueda leer ese espacio |

La regla de la segunda fila es la misma que ya regía para Outlook desde la
migración 0078, y no cambió: el correo entre colegas es correspondencia privada
de un empleado y no se publica en un sitio donde otros buscan. Lo que se añadió
en la 0121 es la primera fila — el cuaderno propio de cada quien, que nadie más
puede leer, donde su propio buzón sí puede entrar completo.

Si `INTERNAL_EMAIL_DOMAINS` no está configurado, Cortex **no puede** distinguir
quién es de la empresa, así que se niega a archivar en un espacio compartido y
lo dice. Al espacio personal sigue entrando, porque ahí la pregunta no se hace.

---

## Cómo se enciende y se apaga

- **Desde la pantalla:** *Integraciones* → panel «Aprender de tu correo». Se
  elige cuánto histórico (1 mes, 90 días, 6 meses o 1 año) y se pulsa
  «Empezar a aprender». El botón «Apagar» detiene el barrido diario.
- **Desde el chat:** «aprende de mi correo del último año», «apaga el
  aprendizaje de mi buzón», «¿cómo va el aprendizaje de mi correo?».

**Apagar no borra nada.** Los documentos siguen en el cerebro y se borran desde
la pantalla de Brain Knowledge, como cualquier otro.

Nadie puede encender esto para el buzón de otra persona: ni la herramienta ni la
ruta de la API tienen un parámetro donde escribir el nombre de alguien. El buzón
que se lee es el de quien pide, y el destino es su propio espacio.

---

## El puntero, y qué pasa cuando caduca

El barrido diario usa el `historyId` de Gmail: «dime qué cambió desde este
punto». Es mejor que preguntar por fecha porque un correo con fecha vieja
—reenvíos, importaciones, relojes mal puestos— no se pierde.

Google **caduca** ese puntero tras varios días sin usarlo y contesta 404. Eso no
es un fallo: es lo que pasa si el producto estuvo caído un fin de semana largo.
Cuando ocurre, el barrido cae solo a una consulta por fecha desde el último
barrido, con un día de solapamiento, y vuelve a pedir el puntero para el día
siguiente. Volver a ver un hilo ya archivado no cuesta nada: el `sha256` del
documento corta antes de gastar un embedding.

---

## Piezas, para quien tenga que diagnosticar

| Pieza | Dónde |
|---|---|
| Tablas | `gmail_sync_state` (un buzón, su puntero y su cursor), `gmail_thread_ingests` (un hilo archivado, su documento y su hash) |
| Migraciones | `0121_gmail_brain.sql`, `0122_gmail_index.sql` |
| La ingesta | `packages/agent-tools/src/gmail/ingest-thread.ts` |
| Los adjuntos | `packages/agent-tools/src/mail/attachments.ts` (compartido con Outlook), `gmail/attachments.ts`, `outlook/attachments.ts` |
| El libro de adjuntos | `mail_attachment_ingests` (migración 0124) |
| La carga y el barrido | `packages/agent-tools/src/gmail/learn.ts` |
| Qué se propone | `packages/agent-tools/src/gmail/propose-replies.ts` |
| Los trabajos | `apps/web/inngest/functions/gmail-learn.ts` (`gmail/backfill.user`, `gmail/sweep`, `gmail/sweep.user`) |
| El cron | `services/jobs/src/manifest.ts` — `gmail/sweep`, `*/10 * * * *` |
| Los avisos | `packages/agent-tools/src/mail/alerts.ts` (qué), `mail_alerts` (libro), migración 0126 |

**Preguntas frecuentes al diagnosticar:**

- *«No archivó nada esta mañana.»* Mire `gmail_sync_state.paused` y
  `last_error`. Un permiso de Google revocado pausa el buzón y manda un aviso a
  su dueño; se reanuda volviendo a conectar la cuenta.
- *«La carga histórica lleva horas.»* Es normal en un buzón cargado: va por
  tandas de 60 hilos, y cada tanda se vuelve a encolar sola.
  `backfill_threads` dice cuántos lleva; `backfill_done_at` en null significa
  que sigue.
- *«Llegaron 500 correos de golpe.»* El barrido tiene un techo de 200 hilos por
  ejecución; el resto entra al día siguiente y queda anotado en `last_error`.

---

## Los permisos que pide

Ninguno nuevo. Usa `gmail.readonly`, que ya estaba en el conjunto que se otorga
al conectar Google. La escritura ocurre en el cerebro de Cortex, no en Gmail.
