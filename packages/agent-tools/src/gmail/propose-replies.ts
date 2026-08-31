import { generateText } from 'ai';
import type { Draft } from '../actions/draft';
import { needsYourAttention } from '../mail/attention';
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
 * Cinco al día, como mucho — al DÍA, no por barrido; ver `MAX_PROPOSALS_PER_DAY`
 * más abajo. La misma cifra y la misma razón que en `memory-derive.ts`: una cola
 * que nadie puede enfrentar es una cola que nadie vacía, y un trabajo
 * desatendido es muy bueno produciendo una.
 */

/**
 * Cinco, y desde la 0126 es POR VENTANA DE 24 HORAS y no por barrido.
 *
 * Era lo mismo mientras el barrido corría una vez al día. Al pasar a cada diez
 * minutos dejó de serlo: cinco por barrido son setecientas veinte al día, que
 * no es un techo, es un grifo. El presupuesto que queda lo calcula quien llama
 * —contando lo ya propuesto— y entra por `budget`.
 */
export const MAX_PROPOSALS_PER_DAY = 5;

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
  /**
   * Cuántas propuestas caben todavía. Omitido significa el techo entero, que es
   * lo correcto para un barrido diario y lo que hacía esta función antes de que
   * el barrido pasara a correr cada diez minutos.
   */
  budget?: number;
}

/**
 * Los hilos que merecen un borrador hoy. Función pura: es la parte de esta
 * función que una persona tiene que poder auditar sin levantar un buzón.
 */
export function planReplyProposals(input: PlanReplyInput): ReplyCandidate[] {
  const mailbox = input.mailbox.trim().toLowerCase();
  const out: ReplyCandidate[] = [];

  for (const thread of input.threads) {
    if (input.alreadyProposed.has(thread.threadId)) continue;

    // Los filtros 1 a 3 viven ahora en `mail/attention.ts`, porque desde la
    // 0126 los usa también quien decide de qué AVISAR. Escritos dos veces se
    // habrían separado el día que alguien afinara uno, y el síntoma sería
    // visible y sin explicación: Cortex proponiendo responder a un boletín del
    // que no avisó, o avisando de un correo interno que no propondría contestar.
    const verdict = needsYourAttention(thread, mailbox);
    if (!verdict.needsYou) continue;

    out.push({ thread, to: verdict.from });
  }

  // Lo más reciente primero: un correo de anoche se contesta hoy, y uno de hace
  // una semana ya perdió el momento en que la respuesta valía.
  return out
    .sort((a, b) => b.thread.lastMessageAt.localeCompare(a.thread.lastMessageAt))
    .slice(0, Math.max(0, input.budget ?? MAX_PROPOSALS_PER_DAY));
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
