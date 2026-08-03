import { MEMORY_MAX_CHARS } from './types';

/**
 * What may never become a memory.
 *
 * A memory is injected into EVERY prompt, so it lands in every provider request
 * and every log line, forever, for as long as the person keeps it. That is a
 * completely different exposure profile from a Knowledge Base document, which
 * is read only when a question happens to look like it. So the bar for what
 * gets in is much higher than "is it true".
 *
 * This screen runs on every write path — the `cortex.remember` tool, accepting a
 * nightly suggestion, and the nightly job's own candidates — because the risk is
 * in the storage, not in who asked for it.
 *
 * It is deliberately a REFUSAL, not a redaction. Silently stripping the number
 * out of "Ana earns 4,500 USD" leaves "Ana earns", which is worse than useless:
 * the person believes Cortex learned something and cannot see what. Saying no,
 * with a reason and a place to put it instead, is the honest failure.
 */

export type MemoryRejection =
  | 'credential'
  | 'compensation'
  | 'contact-detail'
  | 'identifier'
  | 'too-long'
  | 'too-short';

export interface MemoryScreenResult {
  ok: boolean;
  reason?: MemoryRejection;
  /** What to tell the person, in Cortex's voice. Present iff ok is false. */
  message?: string;
}

const OK: MemoryScreenResult = { ok: true };

/**
 * Secrets. Two shapes: something that names itself ("my API key is …") and
 * something that looks like a key regardless of what it is called. The second
 * matters more — people paste tokens without labelling them.
 */
// "clave" and "secret" on their own are ordinary words in both languages ("un
// cliente clave", "the secret sauce"), so they only count when they are
// carrying something: `clave de acceso`, `client secret`.
const CREDENTIAL_LABEL =
  /\b(api[\s_-]?key|access[\s_-]?key|private[\s_-]?key|secret[\s_-]?key|client[\s_-]?secret|token|password|passwd|contraseña|clave de (acceso|api)|bearer|credential|credencial)\b/i;
/** Recognisable key prefixes, then any long unbroken high-entropy run. */
const CREDENTIAL_SHAPE =
  /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;
const HIGH_ENTROPY_RUN = /\b(?=[A-Za-z]*\d)(?=[\dA-Za-z]*[A-Za-z])[A-Za-z0-9_+/-]{28,}\b/;

/**
 * Compensation. Not "any number" — "costs always in USD" and "we quote in
 * monthly rates" are exactly the preferences this feature is for. What is
 * refused is a pay word standing next to an amount, which is the shape of a
 * specific person's or client's figure.
 */
const PAY_WORD =
  /\b(salary|salario|sueldo|pay[\s_-]?rate|bill[\s_-]?rate|compensation|compensación|payroll|nómina|nomina|earns?|gana|cobra|paid|comisión|commission|bonus|equity|severance|liquidación)\b/i;
const MONEY =
  /(\$\s?\d|\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?\b|\b\d{4,}\b|\b\d+(?:[.,]\d+)?\s?(usd|cop|mxn|eur|k\b|mil\b))/i;

/** Contact details: a colleague's address in every prompt is nobody's preference. */
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3}[\s.-]?\d{3,4}[\s.-]?\d{2,4}\b/;

/** Government / national identifiers, written the way people write them. */
const NATIONAL_ID =
  /\b(ssn|social security|cédula|cedula|\bcurp\b|\brfc\b|\bnit\b|passport|pasaporte|tax[\s_-]?id|dni)\b/i;
const CARD_LIKE = /\b(?:\d[ -]?){13,19}\b/;

const MESSAGES: Record<MemoryRejection, string> = {
  credential:
    "I won't keep that as a memory — it looks like a secret, and memories go into every single conversation I have. Store credentials in the integration that needs them, never in something I recite.",
  compensation:
    "I won't keep a pay figure as a memory. Memories ride along in every conversation, and compensation shouldn't. If it's a rate the team should be able to look up, save it to a Knowledge Base space instead.",
  'contact-detail':
    "I won't keep an email address or phone number as a memory — that would carry someone's contact details into every conversation I have. Tell me the person or the account instead and I'll look them up when I need them.",
  identifier:
    "I won't keep an ID number as a memory. Memories are part of every conversation, and identity documents shouldn't be.",
  'too-long': `That's longer than a memory should be — keep it under ${MEMORY_MAX_CHARS} characters. If it needs more room than that, it's a document, and it belongs in the Knowledge Base where I can look it up when it's relevant.`,
  'too-short': "That's too short for me to make sense of later. Give me a full sentence.",
};

function reject(reason: MemoryRejection): MemoryScreenResult {
  return { ok: false, reason, message: MESSAGES[reason] };
}

/**
 * Decide whether a sentence may be stored as a memory. Pure — no I/O, no
 * network — so both the tool and the nightly job can call it without a context.
 */
export function screenMemory(raw: string): MemoryScreenResult {
  const content = raw.trim();
  if (content.length < 3) return reject('too-short');
  if (content.length > MEMORY_MAX_CHARS) return reject('too-long');

  if (CREDENTIAL_SHAPE.test(content) || HIGH_ENTROPY_RUN.test(content)) {
    return reject('credential');
  }
  if (CREDENTIAL_LABEL.test(content)) return reject('credential');

  if (EMAIL.test(content)) return reject('contact-detail');
  if (NATIONAL_ID.test(content)) return reject('identifier');
  if (CARD_LIKE.test(content.replace(/\s/g, ' '))) return reject('identifier');
  if (PAY_WORD.test(content) && MONEY.test(content)) return reject('compensation');
  // Checked after the money rules so "we quote 8,500 USD" is judged as a rate,
  // not misread as a phone number.
  if (PHONE.test(content)) return reject('contact-detail');

  return OK;
}
