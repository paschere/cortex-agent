import { isControlHandoffMessage } from './confirmation-notes';

/**
 * QUÉ SE LE PREGUNTA A BRAIN KNOWLEDGE ANTES DE CONTESTAR.
 *
 * ===========================================================================
 * EL FALLO QUE ESTO ARREGLA
 * ===========================================================================
 * La búsqueda que se pega encima de cada pregunta se saltaba cualquier mensaje
 * de menos de ocho palabras, y buscaba sólo con el último. Las preguntas que la
 * gente le hace a un gerente son justo ésas: «¿cómo va Coltrans?», «cuánto nos
 * paga Nexa», «y la tarifa?». Con la regla vieja las tres se contestaban SIN
 * memoria de la empresa — y la tercera, además, no dice de qué habla: el
 * cliente estaba dos mensajes atrás. El propio banco de evaluación
 * (evaluation/suite.ts) está lleno de preguntas de cuatro palabras; pasaba
 * porque llama a la búsqueda directo y no por esta puerta.
 *
 * ===========================================================================
 * LA REGLA NUEVA
 * ===========================================================================
 *   - Lo que no es pregunta NO busca: acuses («ok», «gracias», «dale»),
 *     saludos solos y los avisos de control que escriben las tarjetas.
 *   - Un mensaje con sustancia busca, sea corto o largo.
 *   - Un mensaje CORTO se completa con lo que la persona dijo justo antes
 *     (hasta dos mensajes suyos), porque es ahí donde está el sujeto que falta.
 *     Los mensajes del asistente no entran: son largos, repiten lo recuperado
 *     y arrastrarían la búsqueda hacia la respuesta anterior en vez de hacia la
 *     pregunta nueva.
 *
 * Cuesta un embedding más por turno corto. Corre en paralelo con el ranking de
 * herramientas (ver «THE TWO EMBEDDINGS» en /api/chat), así que casi no se
 * nota en la espera; contestar sin memoria sí se notaba.
 */

const ACKNOWLEDGMENT_RE =
  /^(ok|okay|okey|yes|no|sure|thanks|got it|sounds good|proceed|continue|s[ií]|claro|dale|perfecto|de acuerdo|listo|gracias|muchas gracias|ok gracias|bueno|vale|genial|excelente|entendido|hecho|jaja+|ja+|👍|🙏)[.!?\s]*$/i;

const GREETING_RE =
  /^(hola|holi|buenas|buenos d[ií]as|buenas tardes|buenas noches|hey|hi|hello|qu[eé] m[aá]s|qu[eé] tal)[.!?,\s]*(cortex)?[.!?\s]*$/i;

/** Mensajes largos se buscan tal cual; por debajo de esto se les suma contexto. */
const SHORT_WORDS = 8;
const PREVIOUS_TURNS = 2;
const MAX_QUERY_CHARS = 600;

export interface ChatLine {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export type RagDecision =
  | { run: true; query: string; widened: boolean }
  | { run: false; reason: 'empty' | 'acknowledgment' | 'control' };

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function ragQueryFor(messages: readonly ChatLine[]): RagDecision {
  const users = messages.filter((m) => m.role === 'user');
  const last = users[users.length - 1]?.content.trim() ?? '';
  if (!last) return { run: false, reason: 'empty' };
  if (isControlHandoffMessage(last)) return { run: false, reason: 'control' };
  if (ACKNOWLEDGMENT_RE.test(last) || GREETING_RE.test(last))
    return { run: false, reason: 'acknowledgment' };

  if (words(last) >= SHORT_WORDS)
    return { run: true, query: last.slice(0, MAX_QUERY_CHARS), widened: false };

  const before = users
    .slice(0, -1)
    .slice(-PREVIOUS_TURNS)
    .map((m) => m.content.trim())
    .filter((text) => text && !isControlHandoffMessage(text) && !ACKNOWLEDGMENT_RE.test(text));
  if (!before.length) return { run: true, query: last, widened: false };
  // Lo último pesa más: va al final, que es donde el embedding lo lee con más
  // fuerza, y lo anterior se recorta primero si no cabe.
  const context = before.join(' · ').slice(-(MAX_QUERY_CHARS - last.length - 3));
  return { run: true, query: `${context} · ${last}`, widened: true };
}
