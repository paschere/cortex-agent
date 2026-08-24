import { isInternalEmailDomain } from '@cortex/core';
import { generateText } from 'ai';
import type { Draft } from '../actions/draft';
import { classifyBulk, parseAddress } from '../inbox/filters';
import { utilityModel } from '../model';
import type { ArchivedThread } from './learn';

/**
 * QUÉ HACER CON LO QUE LLEGÓ ANOCHE — la parte que decide, separada de la que
 * ejecuta.
 *
 * El barrido de la mañana archiva todo lo que entró. Archivar es memoria y no
 * molesta a nadie. Lo de aquí es lo otro: mirar ese mismo montón y decidir de
 * qué merece la pena PROPONER algo, sabiendo que cada propuesta le cuesta a una
 * persona real un minuto de leerla y un clic de contestarla.
 *
 * ===========================================================================
 * LOS CUATRO FILTROS, EN ORDEN, Y NINGUNO ES DECORATIVO
 * ===========================================================================
 *   1. INTERNO, FUERA. Un correo entre colegas no genera un borrador
 *      automático: lo interno se resuelve hablando, y una propuesta de Cortex
 *      en medio es ruido con formato de trabajo. (Que se ARCHIVE en el espacio
 *      personal es otra cosa; ver `ingest-thread.ts`.)
 *   2. MASIVO, FUERA. Boletines, notificaciones de plataformas, «no responder».
 *      Se reutiliza `classifyBulk`, el mismo criterio con el que el digest ya
 *      decide qué no enseñar — porque si un correo no merece salir en el
 *      resumen, desde luego no merece un borrador de respuesta.
 *   3. LA PELOTA TIENE QUE SER SUYA. Si el último mensaje lo escribió el dueño
 *      del buzón, no hay nada que contestar: está esperando él. Proponerle
 *      responderse a sí mismo es la clase de error que hace que alguien apague
 *      la función entera.
 *   4. UNA VEZ POR HILO. Un hilo sobre el que ya hay una propuesta abierta (o
 *      una que alguien descartó ayer) no vuelve a proponerse. Descartar es una
 *      decisión, y volver a ofrecer lo mismo mañana es discutir con quien la
 *      tomó.
 *
 * ===========================================================================
 * Y EL TECHO
 * ===========================================================================
 * Cinco al día, como mucho. La misma cifra y la misma razón que en
 * `memory-derive.ts`: una cola que nadie puede enfrentar es una cola que nadie
 * vacía, y un trabajo desatendido es muy bueno produciendo una.
 */

export const MAX_PROPOSALS_PER_SWEEP = 5;

export interface ReplyCandidate {
  thread: ArchivedThread;
  /** A quién habría que contestarle. Sale del último mensaje, nunca se inventa. */
  to: string;
}

export interface PlanReplyInput {
  threads: ArchivedThread[];
  /** La dirección del dueño del buzón, para saber de quién es la pelota. */
  mailbox: string;
  /** Hilos sobre los que ya se propuso algo alguna vez. */
  alreadyProposed: Set<string>;
}

/**
 * Los hilos que merecen un borrador hoy. Función pura: es la parte de esta
 * función que una persona tiene que poder auditar sin levantar un buzón.
 */
export function planReplyProposals(input: PlanReplyInput): ReplyCandidate[] {
  const mailbox = input.mailbox.trim().toLowerCase();
  const out: ReplyCandidate[] = [];

  for (const thread of input.threads) {
    if (thread.internalOnly) continue;
    if (input.alreadyProposed.has(thread.threadId)) continue;

    const from = thread.lastFromEmail?.trim().toLowerCase() ?? null;
    if (!from) continue;
    // La pelota es suya sólo si el último que habló NO fue él.
    if (from === mailbox) continue;
    // Y el que habló tiene que ser de fuera: un hilo con un cliente donde el
    // último mensaje lo puso un colega se contesta entre colegas.
    if (isInternalEmailDomain(from)) continue;

    const verdict = classifyBulk({
      headers: thread.lastHeaders,
      labelIds: thread.lastLabelIds,
      from: parseAddress(thread.lastFrom ?? from),
    });
    if (verdict.bulk) continue;

    out.push({ thread, to: from });
  }

  // Lo más reciente primero: un correo de anoche se contesta hoy, y uno de hace
  // una semana ya perdió el momento en que la respuesta valía.
  return out
    .sort((a, b) => b.thread.lastMessageAt.localeCompare(a.thread.lastMessageAt))
    .slice(0, MAX_PROPOSALS_PER_SWEEP);
}

/**
 * El borrador.
 *
 * LO QUE EL MODELO PUEDE Y NO PUEDE HACER AQUÍ. Puede redactar. No puede
 * decidir el destinatario (sale del hilo), ni enviar (esto sólo escribe una
 * propuesta que una persona aprueba), ni afirmar hechos: la instrucción le
 * prohíbe explícitamente prometer fechas, cifras o compromisos, porque un
 * borrador que inventa una fecha de entrega es un borrador que alguien aprueba
 * distraído un martes.
 *
 * Y SI EL MODELO FALLA, NO SE PROPONE NADA. Devuelve null y el hilo se queda
 * para mañana. Un borrador vacío o genérico («Estimado cliente, gracias por su
 * correo») es peor que ninguno: enseña a la gente a aprobar sin leer.
 */
export async function draftReply(
  candidate: ReplyCandidate,
  opts: { authorName?: string | null } = {},
): Promise<Draft | null> {
  const { thread } = candidate;
  const instruction = [
    'Redactas el BORRADOR de una respuesta a un correo de trabajo. Lo va a leer una persona real antes de enviarlo, y puede editarlo.',
    '',
    'Reglas, todas obligatorias:',
    '- Español de Colombia, tratando de USTED a quien recibe.',
    '- Corto: cuatro frases como máximo, sin fórmulas de relleno.',
    '- NO prometas fechas, cifras, precios, plazos ni compromisos. Si el correo pide algo así, la respuesta acusa recibo y dice que se confirma en breve.',
    '- NO inventes nombres, números de factura, ni datos que no estén en el correo.',
    '- Si el correo es demasiado escueto para responder con sentido, contesta acusando recibo y preguntando lo que falta.',
    '- Escribe SOLO el cuerpo del correo. Sin asunto, sin encabezados, sin firma con nombre inventado.',
    '',
    `Asunto del hilo: ${thread.subject}`,
    `Quien escribió último: ${candidate.to}`,
    '',
    'Lo último que dijeron:',
    thread.lastSnippet || '(el correo llegó sin texto legible)',
  ].join('\n');

  try {
    const { text } = await generateText({
      model: utilityModel(),
      prompt: instruction,
      maxTokens: 400,
    });
    const body = text.trim();
    if (body.length < 20) return null;

    const signature = opts.authorName?.trim() ? `\n\n${opts.authorName.trim()}` : '';
    return {
      subject: thread.subject.toLowerCase().startsWith('re:')
        ? thread.subject
        : `Re: ${thread.subject}`,
      body: `${body}${signature}`,
      rationale: `${candidate.to} escribió el último mensaje de "${thread.subject}" y sigue sin respuesta.`,
    };
  } catch {
    return null;
  }
}
