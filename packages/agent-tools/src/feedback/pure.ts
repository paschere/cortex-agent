/**
 * Lo puro del 👍/👎: motivos, y qué comentarios son una CORRECCIÓN que vale la
 * pena recordar. Sin base de datos, para poder probarlo.
 *
 * POR QUÉ UNA HEURÍSTICA Y NO UN MODELO. El comentario de un 👎 es la voz de la
 * persona y ya es una cita suya; lo único que se decide aquí es si además
 * enuncia un hecho o una regla («el precio es 0,80 por kilo», «a ese cliente no
 * se le escribe los viernes») en vez de una queja («está mal», «muy lento»).
 * Equivocarse hacia «no es corrección» cuesta una propuesta menos, equivocarse
 * hacia «sí» cuesta una propuesta de más que una persona descarta con un clic:
 * las propuestas nunca escriben solas (memory_proposals espera aprobación).
 */

export const FEEDBACK_REASONS = ['wrong_data', 'not_requested', 'slow', 'other'] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export const FEEDBACK_REASON_LABEL: Record<FeedbackReason, string> = {
  wrong_data: 'Dato equivocado',
  not_requested: 'No hizo lo que pedí',
  slow: 'Muy lento',
  other: 'Otro',
};

export function isFeedbackReason(value: unknown): value is FeedbackReason {
  return typeof value === 'string' && (FEEDBACK_REASONS as readonly string[]).includes(value);
}

/** Palabras que anuncian una regla permanente. */
const RULE_WORDS =
  /\b(siempre|nunca|jam[aá]s|no se (le|les|lo|la)|no (le|les) (escrib|mand|cobr|llam)|hay que|tiene que|tienen que|debe|deben|se debe|a partir de|desde ahora|de ahora en adelante|cada vez que)\b/i;

/** Palabras que anuncian un hecho («es», «cuesta», «queda en»…) junto a un dato. */
const FACT_WORDS =
  /\b(es|son|era|fue|cuesta|cuestan|vale|valen|queda|quedamos|quedó|subi[oó]|baj[oó]|cobramos|pagamos|tarifa|precio|plazo|contacto|se llama|se llaman)\b/i;

const COMPLAINT_ONLY =
  /^(mal|est[aá] mal|no (sirve|es (correcto|as[ií]))|incorrecto|error|falso|muy lento|lento|no|nada)[\s.!¡¿?]*$/i;

export type CorrectionKind = 'agreement' | 'price' | 'contact' | 'decision' | 'process' | 'other';

/** ¿Este comentario enuncia algo que Cortex debería recordar? */
export function looksLikeCorrection(comment: string | null | undefined): boolean {
  const text = (comment ?? '').trim();
  if (text.length < 12 || text.length > 600) return false;
  if (COMPLAINT_ONLY.test(text)) return false;
  if (RULE_WORDS.test(text)) return true;
  const hasNumber = /\d/.test(text);
  return hasNumber && FACT_WORDS.test(text);
}

/** El tipo de recuerdo que mejor describe el comentario. */
export function inferCorrectionKind(comment: string): CorrectionKind {
  const text = comment.toLowerCase();
  if (/(precio|tarifa|cuesta|vale|cobramos|\$|\bpor (kilo|hora|viaje|unidad))/.test(text))
    return 'price';
  if (RULE_WORDS.test(text)) return 'process';
  if (/(contacto|correo|tel[eé]fono|se llama)/.test(text)) return 'contact';
  if (/(quedamos|acordamos|acuerdo|plazo)/.test(text)) return 'agreement';
  return 'other';
}

export interface FeedbackInput {
  rating: 1 | -1;
  reason?: FeedbackReason | null;
  comment?: string | null;
}

/** Limpia lo que escribe la persona: sin espacios sobrantes, con tope. */
export function cleanComment(comment: string | null | undefined): string | null {
  const text = (comment ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  return text.length > 0 ? text : null;
}

/** Recorte para guardar la pregunta o la respuesta tal como estaban. */
export function clip(text: string | null | undefined, max: number): string | null {
  const value = (text ?? '').trim();
  if (!value) return null;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
