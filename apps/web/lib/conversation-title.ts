import { isControlHandoffMessage } from './confirmation-notes';

/**
 * TÍTULOS DE CONVERSACIÓN: en español, del primer pedido real.
 *
 * Los mensajes de control («Aprobé y ya se ejecutó…», «sigue», «va») no dicen
 * de qué trata un chat; el título sale del primer mensaje que sí lo dice.
 */

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|[-*+>]|\d+[.)])\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const TRIVIAL = new Set([
  'sigue',
  'sigo',
  'seguir',
  'continua',
  'continuar',
  'continue',
  'va',
  'vale',
  'dale',
  'ok',
  'okay',
  'listo',
  'si',
  'no',
  'adelante',
  'gracias',
  'aprobado',
  'hazlo',
  'hagale',
  'perfecto',
  'bueno',
  'claro',
  'entendido',
  'go ahead',
  'approved',
  'yes',
  'continua con eso',
  'sigue con eso',
  'sigue adelante',
  'continua adelante',
]);

export function isTrivialMessage(message: string): boolean {
  const n = norm(stripMarkdown(message));
  return n.length < 3 || TRIVIAL.has(n);
}

const ENGLISH_CONTROL =
  /^(approved|go ahead|continue the conversation|continue|come in|proceed|already executed)\b/i;

export function isControlLike(message: string): boolean {
  const t = stripMarkdown(message);
  return isControlHandoffMessage(message) || isTrivialMessage(message) || ENGLISH_CONTROL.test(t);
}

/** El primer mensaje de la persona que de verdad dice de qué trata el chat. */
export function firstRealRequest(
  messages: ReadonlyArray<{ role: string; content: string }>,
): string | null {
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    if (isControlLike(m.content)) continue;
    const clean = stripMarkdown(m.content);
    if (clean.length >= 4) return clean;
  }
  return null;
}

const EN = new Set(
  'the and for with from this that these those check approved already executed continue conversation go ahead come in forward new summary please create send show list report invoices invoice review update about what how can you your my our are was were have has will would should into out over under'.split(
    ' ',
  ),
);
const ES = new Set(
  'de la el los las y para con por un una en del al que se es su sus mi tu lo como mas sin sobre entre este esta estos estas ese esa pendientes factura facturas cliente clientes'.split(
    ' ',
  ),
);

/** ¿Parece un título en inglés, con markdown, o sacado de un mensaje de control? */
export function looksBadTitle(title: string | null | undefined): boolean {
  const t = (title ?? '').trim();
  if (!t) return true;
  if (/[*_`#]{2,}|^\s*[#>*-]\s/.test(t)) return true;
  if (/^(new conversation|nueva conversaci[oó]n|untitled)$/i.test(t)) return true;
  if (isControlLike(t) || /^aprob[eé]/i.test(t)) return true;
  const words = norm(t).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  let en = 0;
  let es = 0;
  for (const w of words) {
    if (EN.has(w)) en++;
    if (ES.has(w)) es++;
  }
  return en >= 1 && en > es;
}

/** Título sin modelo: el pedido recortado en un límite de palabra. */
export function titleFromText(text: string, max = 56): string {
  const clean = stripMarkdown(text)
    .replace(/^[¿¡"'«“\s]+/, '')
    .replace(/[?!."'»”\s]+$/, '');
  if (clean.length <= max) return clean.charAt(0).toUpperCase() + clean.slice(1);
  const cut = clean.slice(0, max);
  const base = cut.slice(0, Math.max(cut.lastIndexOf(' '), 20));
  const out = base.replace(/[,;:\s]+$/, '');
  return `${out.charAt(0).toUpperCase()}${out.slice(1)}…`;
}

export const TITLE_PROMPT = (request: string) =>
  [
    'Escribe el título de esta conversación de trabajo, en español de Colombia (tuteo).',
    'Máximo 6 palabras, sin comillas, sin punto final, sin markdown, sin emojis. Nómbralo por el tema (cliente, documento, tarea), no copies la frase entera.',
    `Primer pedido de la persona: «${request.slice(0, 400)}»`,
    'Responde solo con el título.',
  ].join('\n');

/** Limpia lo que devuelve el modelo; null si no sirve. */
export function cleanGeneratedTitle(raw: string): string | null {
  const t = stripMarkdown(raw)
    .split('\n')[0]
    ?.replace(/^(t[ií]tulo:?\s*)/i, '')
    .replace(/^["'«“\s]+|["'»”.\s]+$/g, '')
    .trim();
  if (!t || t.length < 3) return null;
  const out = t.slice(0, 80);
  return looksBadTitle(out) ? null : out;
}
