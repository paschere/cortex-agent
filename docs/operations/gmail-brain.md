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
2. **El barrido diario.** Cada mañana a las 6:10 (hora de Bogotá) lee lo que
   entró desde el puntero del día anterior y lo archiva igual.
3. **Lo que propone.** De ese correo nuevo, elige como mucho **cinco** hilos de
   gente de fuera que están esperando respuesta y deja un borrador en
   `/actions`, para que una persona lo apruebe, lo edite o lo descarte.

**Nunca envía nada solo.** Aprobar es siempre un acto humano.

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
| La carga y el barrido | `packages/agent-tools/src/gmail/learn.ts` |
| Qué se propone | `packages/agent-tools/src/gmail/propose-replies.ts` |
| Los trabajos | `apps/web/inngest/functions/gmail-learn.ts` (`gmail/backfill.user`, `gmail/sweep`, `gmail/sweep.user`) |
| El cron | `services/jobs/src/manifest.ts` — `gmail/sweep`, `10 11 * * *` UTC (6:10 en Bogotá) |

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
