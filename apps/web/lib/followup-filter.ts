/**
 * THE BAR A FOLLOW-UP QUESTION HAS TO CLEAR.
 *
 * A generic suggestion is worse than no suggestion. "¿Quieres saber más?" costs
 * a row of screen and — the expensive part — teaches the person that the strip
 * is noise, which makes the good suggestions after it invisible. Two useful
 * chips beat three where one is filler.
 *
 * The prompt asks the model for specificity. This CHECKS it, because a prompt
 * is a request and a filter is a guarantee. The rule is deliberately mechanical
 * rather than clever: a follow-up survives only if it reuses a substantial word
 * that actually appears in the answer. "¿Cuánto suman los tres SOAT vencidos?"
 * passes because "soat" and "vencidos" are in the text; "¿Quieres que
 * profundice?" fails because none of its words are.
 *
 * That single rule kills nearly the whole family of generic questions without
 * enumerating them, and it fails in the safe direction: an over-strict filter
 * shows fewer chips, never a wrong one.
 *
 * Lives here rather than in the route because a Next.js route file may only
 * export handlers and a few config fields — and because a rule this load-bearing
 * should be testable without standing up a request.
 */

/** Openers that are filler whatever follows them. */
const GENERIC = [
  'saber m',
  'ampl',
  'mas detalles',
  'mas informacion',
  'profundiz',
  'en que mas',
  'algo mas',
  'otra cosa',
  'ayudar en algo',
  'continu',
  'cuentame mas',
];

/**
 * Words worth matching on: long enough to carry meaning, and not the Spanish
 * connective tissue that appears in every sentence ever written.
 */
const STOPWORDS = new Set([
  'para',
  'como',
  'cual',
  'cuales',
  'donde',
  'cuando',
  'cuanto',
  'cuanta',
  'cuantos',
  'cuantas',
  'esta',
  'este',
  'estos',
  'estas',
  'esos',
  'esas',
  'pero',
  'porque',
  'sobre',
  'entre',
  'desde',
  'hasta',
  'tiene',
  'tienen',
  'puede',
  'pueden',
  'hacer',
  'estar',
  'tener',
  'estan',
  'otros',
  'otras',
  'quiero',
  'quieres',
  'todos',
  'todas',
  'algun',
  'alguna',
  'mismo',
  'misma',
]);

export function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of fold(text).split(/[^a-z0-9]+/)) {
    if (raw.length >= 4 && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

/**
 * Does this follow-up name something the answer actually said?
 *
 * `answerWords` is built once from the answer with `contentWords`.
 */
export function keepIfSpecific(
  suggestion: string,
  answerWords: ReadonlySet<string>,
  asked: string,
): boolean {
  const trimmed = suggestion.trim();
  if (trimmed.length < 12 || trimmed.length > 120) return false;

  const folded = fold(trimmed);
  if (GENERIC.some((g) => folded.includes(g))) return false;
  // Asking back what was just asked is the other way to waste the row.
  if (folded.replace(/[¿?.]/g, '').trim() === fold(asked).replace(/[¿?.]/g, '').trim()) {
    return false;
  }

  for (const word of contentWords(trimmed)) {
    if (answerWords.has(word)) return true;
  }
  return false;
}

/** Split the model's reply into candidates, tolerating bullets and quotes. */
export function parseSuggestions(text: string): string[] {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
        .replace(/^["'“«]+|["'”»]+$/g, '')
        .trim(),
    )
    .filter((line) => line.length > 0);
}
