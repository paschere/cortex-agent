import { isInternalEmailDomain } from '@cortex/core';
import type { MailHeader } from '../inbox/filters';
import { classifyBulk, parseAddress } from '../inbox/filters';

/**
 * «LA PELOTA ES SUYA»: los tres filtros que decidían qué proponer, ahora
 * también deciden de qué avisar.
 *
 * POR QUÉ SALEN AQUÍ. `planReplyProposals` los tenía escritos dentro, y estaban
 * bien — interno fuera, masivo fuera, y el último que habló no puede ser el
 * dueño del buzón. Cuando apareció el segundo lector de esa misma lista (los
 * avisos inmediatos de la 0126) había dos caminos: copiarlos, o sacarlos. Se
 * sacan, porque son la definición de «esto le toca a una persona», y una
 * definición con dos copias se convierte en dos definiciones el día que alguien
 * afine una: Cortex propondría responder a un boletín del que no avisó, o
 * avisaría de un correo interno que no propondría contestar. Las dos
 * incoherencias son visibles para el usuario y ninguna tiene explicación.
 *
 * El tipo es ESTRUCTURAL y no `ArchivedThread`: este módulo vive en `mail/`
 * como `audience.ts` y `attachments.ts`, y no debe saber si detrás hay Gmail o
 * Graph.
 */
export interface AttentionThread {
  threadId: string;
  subject: string;
  lastMessageAt: string;
  /** Verdadero cuando nadie de fuera de la empresa está en el hilo. */
  internalOnly: boolean;
  /** Quién escribió el último mensaje. De aquí sale de quién es la pelota. */
  lastFromEmail: string | null;
  /** La cabecera `From` cruda, para poder nombrar a quien escribió. */
  lastFrom: string | null;
  lastLabelIds: string[];
  lastHeaders: MailHeader[];
  counterpartDomain: string | null;
}

export type AttentionVerdict =
  | { needsYou: true; from: string }
  /** `why` es para el registro y para poder explicarlo, nunca para el usuario. */
  | { needsYou: false; why: 'internal' | 'no_sender' | 'you_spoke_last' | 'colleague' | 'bulk' };

/**
 * ¿Este hilo le toca a la persona del buzón?
 *
 *   1. INTERNO, FUERA. Lo interno se resuelve hablando, y Cortex en medio es
 *      ruido con formato de trabajo. (Que se ARCHIVE en el espacio personal es
 *      otra cosa; ver `gmail/ingest-thread.ts`.)
 *   2. LA PELOTA TIENE QUE SER SUYA. Si el último mensaje lo escribió el dueño
 *      del buzón, está esperando él y no hay nada que hacer.
 *   3. MASIVO, FUERA. Boletines, notificaciones de plataformas, «no responder».
 *      Mismo criterio con el que el resumen decide qué no enseñar: si algo no
 *      merece salir en el resumen, desde luego no merece una interrupción.
 */
export function needsYourAttention(thread: AttentionThread, mailbox: string): AttentionVerdict {
  if (thread.internalOnly) return { needsYou: false, why: 'internal' };

  const from = thread.lastFromEmail?.trim().toLowerCase() ?? null;
  if (!from) return { needsYou: false, why: 'no_sender' };
  if (from === mailbox.trim().toLowerCase()) return { needsYou: false, why: 'you_spoke_last' };
  // Un hilo con un cliente donde el último mensaje lo puso un colega se
  // contesta entre colegas.
  if (isInternalEmailDomain(from)) return { needsYou: false, why: 'colleague' };

  const verdict = classifyBulk({
    headers: thread.lastHeaders,
    labelIds: thread.lastLabelIds,
    from: parseAddress(thread.lastFrom ?? from),
  });
  if (verdict.bulk) return { needsYou: false, why: 'bulk' };

  return { needsYou: true, from };
}

/**
 * ¿MERECE ESTE HILO SER MEMORIA?
 *
 * ===========================================================================
 * EL ERROR QUE ESTO CORRIGE
 * ===========================================================================
 * Hasta aquí, archivar no filtraba NADA. La carga histórica pedía
 * `in:anywhere` —correo, archivado, papelera y spam— y metía el buzón entero
 * en el espacio personal, con el argumento de que «archivar es memoria y no
 * molesta a nadie porque nadie más lo lee».
 *
 * Ese argumento es falso en tres sitios, y los tres se vieron el mismo día:
 *
 *   LA RECUPERACIÓN. Cada promoción es un documento más compitiendo en cada
 *   búsqueda. Preguntas por una tarifa y pelea un correo de marketing que usa
 *   la misma palabra.
 *
 *   EL DINERO. Cada hilo se trocea y se vectoriza. Un mes de buzón personal es
 *   mayoritariamente campañas, y la cuenta de embeddings se agotó indexando
 *   «50% de descuento este fin de semana».
 *
 *   LA CONFIANZA. El día que Cortex cite un boletín como si fuera conocimiento
 *   de la empresa, deja de creérsele. Con razón.
 *
 * Y lo peor: el criterio ya existía. `classifyBulk` decide desde hace tiempo
 * qué NO sale en el resumen diario. Estaba escrito, probado y en uso; sólo que
 * nadie lo cruzó con la ingesta, porque las dos cosas se construyeron en
 * momentos distintos.
 *
 * ===========================================================================
 * LA REGLA: SE MIRA EL HILO ENTERO, NO EL ÚLTIMO MENSAJE
 * ===========================================================================
 * Un hilo se descarta sólo si NINGUNO de sus mensajes parece escrito por una
 * persona. Basta con que uno lo parezca para archivarlo entero.
 *
 * Es la dirección segura, y la diferencia importa: contestarle a un boletín
 * —«¿me pueden dar de baja de esto?», «¿cuánto vale el plan de arriba?»—
 * convierte una campaña en correspondencia. Mirar sólo el último mensaje se
 * equivocaría en los dos sentidos: descartaría ese hilo si el último en hablar
 * fue el robot, y guardaría una campaña entera porque el primero de doce venía
 * limpio.
 *
 * LO INTERNO NO SE TOCA AQUÍ. Un correo entre colegas no es basura: es el
 * trabajo de esa persona, y en su cuaderno privado es exactamente lo que quiere
 * que Cortex sepa. Quien decide si lo interno entra a un espacio COMPARTIDO es
 * la regla de audiencia (`mail/audience.ts`), que no cambia.
 *
 * LO QUE SE DESCARTA NO SE PIERDE. Sigue en Gmail, y Cortex sabe buscarlo en
 * vivo con `gmail.search` cuando alguien lo pida. La diferencia entre archivar
 * y no archivar no es «tenerlo o no tenerlo»: es si vale la pena convertirlo en
 * memoria permanente, con lo que eso cuesta en dinero y en ruido.
 */
export interface RememberableMessage {
  from: string | null;
  lastFrom?: string | null;
  labelIds: string[];
  headers: MailHeader[];
}

export type RememberVerdict =
  | { remember: true }
  /** `reason` está escrito para poder enseñárselo a una persona. */
  | { remember: false; reason: string };

export function worthRemembering(messages: RememberableMessage[]): RememberVerdict {
  if (messages.length === 0) return { remember: false, reason: 'no traía ningún mensaje' };

  let lastReason = 'es correo masivo, no correspondencia';
  for (const m of messages) {
    const verdict = classifyBulk({
      headers: m.headers,
      labelIds: m.labelIds,
      from: parseAddress(m.lastFrom ?? m.from ?? ''),
    });
    // Uno solo que parezca humano salva el hilo entero.
    if (!verdict.bulk) return { remember: true };
    if (verdict.reason) lastReason = verdict.reason;
  }
  return { remember: false, reason: lastReason };
}
