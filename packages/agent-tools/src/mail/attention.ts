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
