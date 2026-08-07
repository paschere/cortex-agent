import { quoteSupportsDate } from '../commitments/extract';
import {
  type CanonicalSlot,
  type Currency,
  type DocumentTypeSpec,
  type FieldSpec,
  documentType,
} from './types';

/**
 * The gate. Everything a model proposes goes through here, and every check can
 * only reject.
 *
 * This is `commitments/extract.ts` generalised from dates to money, names and
 * identifiers, and the reasoning is unchanged — read that file's header first.
 * Its three rules become four here:
 *
 *   1. THE QUOTE MUST BE REAL. The sentence has to appear, verbatim (modulo
 *      whitespace and case), in a chunk of the document it claims to come from.
 *      A paraphrase is indistinguishable from an invention once it is stored.
 *
 *   2. THE VALUE MUST BE WRITTEN IN THAT QUOTE. This is the check that does the
 *      work, and the one this module exists to extend:
 *
 *        dates    day, month and year all present — `quoteSupportsDate`, the
 *                 same function that rejects "vigencia de doce meses desde el 1
 *                 de enero" proposed as the 1st of January the year after.
 *        amounts  the digits have to be on the page. A subtotal of 1.260.504
 *                 and an IVA of 239.496 do not vouch for a total of 1.500.000
 *                 unless that total is also printed. It usually is; when it is
 *                 not, the answer is a person, not arithmetic. THIS IS THE
 *                 WHOLE POINT for a module that feeds sums.
 *        NITs     digit for digit, ignoring the dots and the dash — that is
 *                 transcription, not calculation. A check digit the document
 *                 does not print is not added.
 *        text     the string has to be in the sentence, ignoring punctuation.
 *        currency has to be NAMED. A bare "$" is not a currency, and this is
 *                 the one place where refusing to guess is visibly annoying and
 *                 still right: see `readCurrency`.
 *
 *   3. THE VALUE MUST BE A VALUE. A parseable date inside a plausible window, a
 *      non-negative amount below any sane ceiling, a NIT of 5 to 15 digits.
 *
 *   4. ONE READING PER FIELD. A second proposal for `total` is a duplicate, not
 *      a second total.
 *
 * Everything that survives is still only a PROPOSAL. It is written pending and
 * counts towards nothing until a person confirms it — migration 0076 makes that
 * impossible to skip, and store.ts is where it happens.
 */

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Collapse whitespace and case. Accents are KEPT, for the reason
 * commitments/extract.ts keeps them: stripping them would let "esta" match
 * "está", and in a legal document those are different words.
 */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The same, minus punctuation, for comparing names.
 *
 * "COLTRANS S.A.S." from the model against "Coltrans S.A.S" on the page is the
 * same company and differs by one full stop. Requiring the punctuation to match
 * would reject correct readings all day, and nothing about a company name is
 * verified by its dots.
 */
function loose(text: string): string {
  return normalize(text)
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DocumentChunk {
  id: string;
  chunk_index: number;
  content: string;
}

export interface NormalizedChunk {
  chunk: DocumentChunk;
  text: string;
  looseText: string;
}

export function prepareChunks(chunks: DocumentChunk[]): NormalizedChunk[] {
  return chunks.map((c) => ({
    chunk: c,
    text: normalize(c.content),
    looseText: loose(c.content),
  }));
}

/** The chunk a quote actually appears in, or null. */
export function locateQuote(quote: string, chunks: NormalizedChunk[]): DocumentChunk | null {
  const needle = normalize(quote);
  if (needle.length < 8) return null;
  const exact = chunks.find((c) => c.text.includes(needle));
  if (exact) return exact.chunk;
  // A PDF that hyphenated a word across a line, or a table cell the parser
  // joined with a different amount of space, produces a quote that is the same
  // words with different punctuation. Falling back to the punctuation-blind
  // form keeps those, and it still cannot admit a sentence that is not there.
  const looseNeedle = loose(quote);
  if (looseNeedle.length < 8) return null;
  return chunks.find((c) => c.looseText.includes(looseNeedle))?.chunk ?? null;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const AMOUNT_CEILING = 1e14;

/**
 * Every number literally written in a sentence, read both the Colombian way
 * (1.500.000,50) and the American way (1,500,000.50).
 *
 * Both are returned rather than one being chosen, because the job here is not
 * to decide what the document meant — it is to answer "are these digits on the
 * page". A token that is unambiguous under one reading and nonsense under the
 * other simply contributes one plausible value and one implausible one, and the
 * implausible one matches nothing.
 */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const raw of text.match(/\d[\d.,]*\d|\d/g) ?? []) {
    for (const value of interpretations(raw)) {
      if (Number.isFinite(value)) out.push(value);
    }
  }
  return out;
}

function interpretations(token: string): number[] {
  const values = new Set<number>();
  const lastDot = token.lastIndexOf('.');
  const lastComma = token.lastIndexOf(',');

  // Both separators present: the LAST one is the decimal point, whichever it is.
  if (lastDot !== -1 && lastComma !== -1) {
    const decimalAt = Math.max(lastDot, lastComma);
    const intPart = token.slice(0, decimalAt).replace(/[.,]/g, '');
    const decPart = token.slice(decimalAt + 1).replace(/[.,]/g, '');
    values.add(Number(`${intPart}.${decPart}`));
    return [...values];
  }

  const sep = lastDot !== -1 ? '.' : lastComma !== -1 ? ',' : null;
  if (!sep) {
    values.add(Number(token));
    return [...values];
  }

  // One kind of separator. It is either a thousands mark or a decimal point,
  // and both readings are offered.
  values.add(Number(token.split(sep).join('')));
  const tail = token.slice(token.lastIndexOf(sep) + 1);
  if (!tail.includes(sep) && tail.length > 0 && tail.length <= 2) {
    const head = token.slice(0, token.lastIndexOf(sep)).split(sep).join('');
    values.add(Number(`${head}.${tail}`));
  }
  return [...values];
}

/**
 * Is this amount written in this sentence?
 *
 * Compared to the cent, because money is compared to the cent. A total that is
 * "about right" is the exact failure this module is built to prevent: it is the
 * one wrong number that never gets caught, since it looks like the answer.
 */
export function quoteSupportsAmount(quote: string, amount: number): boolean {
  if (!Number.isFinite(amount) || amount < 0 || amount >= AMOUNT_CEILING) return false;
  return numbersIn(quote).some((n) => Math.abs(n - amount) < 0.005);
}

// ---------------------------------------------------------------------------
// NITs
// ---------------------------------------------------------------------------

export function nitDigits(value: string): string {
  return value.replace(/\D+/g, '');
}

/**
 * The digit runs a sentence contains, with the dots and dashes INSIDE a number
 * closed up first, so "900.123.456-7" reads as one run of ten digits rather
 * than four short ones.
 */
function digitRuns(text: string): string[] {
  const joined = text.replace(/(\d)[.\-\s](?=\d)/g, '$1');
  return joined.match(/\d{4,}/g) ?? [];
}

/**
 * Is this NIT written in this sentence?
 *
 * Accepts the proposal when its digits are exactly a run on the page, or a run
 * minus the trailing verification digit — the document printed the DV and the
 * model left it off, which is still reading. It REFUSES the reverse: a proposal
 * one digit LONGER than anything printed means the model computed the check
 * digit, and a computed digit is not a read one, however easy the arithmetic
 * and however likely it is to be right. Reconciling the two representations is
 * `resolveClientByNit`'s job, where the checksum is actually verified.
 */
export function quoteSupportsNit(quote: string, nit: string): boolean {
  const candidate = nitDigits(nit);
  if (candidate.length < 5 || candidate.length > 15) return false;
  return digitRuns(quote).some(
    (run) =>
      run === candidate || (run.startsWith(candidate) && run.length - candidate.length === 1),
  );
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function quoteSupportsText(quote: string, value: string): boolean {
  const needle = loose(value);
  if (needle.length < 2) return false;
  return loose(quote).includes(needle);
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

const CURRENCY_TOKENS: Array<{ currency: Currency; tokens: string[] }> = [
  {
    currency: 'COP',
    tokens: [
      'cop',
      'pesos colombianos',
      'peso colombiano',
      'pesos',
      'm/cte',
      'mcte',
      'm/l',
      'moneda legal',
      'moneda corriente',
    ],
  },
  {
    currency: 'USD',
    tokens: ['usd', 'us$', 'u$s', 'dólares', 'dolares', 'dólar', 'dolar'],
  },
  { currency: 'EUR', tokens: ['eur', 'euros', 'euro', '€'] },
];

/**
 * The currency NAMED in a sentence, or null.
 *
 * A bare "$" returns null, and that is deliberate even though almost every
 * Colombian invoice writes exactly that. The alternative is a default, and a
 * default here means every dollar-denominated import invoice — the ones this
 * customs agency handles all day — silently enters the ledger multiplied by
 * four thousand. Null costs one click in the review screen, where the reviewer
 * is already looking at the document. It is the cheapest possible place to
 * resolve an ambiguity, and the only place where somebody actually knows.
 */
export function readCurrency(quote: string): Currency | null {
  const text = normalize(quote);
  for (const { currency, tokens } of CURRENCY_TOKENS) {
    if (tokens.some((t) => text.includes(t))) return currency;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date has to be a date, and inside a window where a business document's date
 * is plausible. Twenty years back covers an old contract that is still in
 * force; twenty forward covers a long lease. Outside that, a "date" is a page
 * number or an amount that acquired a year.
 */
export function isPlausibleDocumentDate(value: string, today: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(t) || Number.isNaN(now)) return false;
  const years = (t - now) / (365.25 * 86_400_000);
  return years > -20 && years < 20;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** What the model proposes for one field. */
export interface FieldCandidate {
  fieldKey: string;
  /** Exactly one of these is meaningful, decided by the field's kind. */
  text?: string | null;
  number?: number | null;
  date?: string | null;
  quote: string;
}

export interface VerifiedField {
  fieldKey: string;
  spec: FieldSpec;
  valueText: string | null;
  valueNumber: number | null;
  valueDate: string | null;
  currency: Currency | null;
  quote: string;
  chunkId: string;
}

export interface RejectedField {
  fieldKey: string;
  /** What it proposed, for the "descartado" list a reviewer reads. */
  proposed: string;
  /** Spanish, because it is shown to a person. */
  reason: string;
}

export interface VerificationResult {
  accepted: VerifiedField[];
  rejected: RejectedField[];
}

function display(candidate: FieldCandidate): string {
  if (candidate.number != null) return String(candidate.number);
  if (candidate.date) return candidate.date;
  return candidate.text ?? '';
}

/**
 * Verify a whole document's worth of proposals against its own text.
 *
 * The rejections are returned rather than swallowed, for the reason
 * commitments/extract.ts returns them: a reviewer who can see that four of six
 * readings were thrown out for citing sentences that are not in the document
 * has learned something true about how far to trust the two that remain.
 */
export function verifyFields(
  candidates: FieldCandidate[],
  chunks: DocumentChunk[],
  typeId: string,
  today: string,
): VerificationResult {
  const spec = documentType(typeId);
  const accepted: VerifiedField[] = [];
  const rejected: RejectedField[] = [];
  if (!spec) {
    return {
      accepted,
      rejected: candidates.map((c) => ({
        fieldKey: c.fieldKey,
        proposed: display(c),
        reason: `"${typeId}" no es un tipo de documento que Cortex sepa leer`,
      })),
    };
  }

  const prepared = prepareChunks(chunks);
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const field = spec.fields.find((f) => f.key === candidate.fieldKey);
    if (!field) {
      rejected.push({
        fieldKey: candidate.fieldKey,
        proposed: display(candidate),
        reason: `"${candidate.fieldKey}" no es un campo de ${spec.label.toLowerCase()}`,
      });
      continue;
    }
    if (seen.has(field.key)) continue;

    const quote = (candidate.quote ?? '').trim();
    if (quote.length < 8) {
      rejected.push({
        fieldKey: field.key,
        proposed: display(candidate),
        reason: 'la cita es demasiado corta para verificarla',
      });
      continue;
    }

    const chunk = locateQuote(quote, prepared);
    if (!chunk) {
      rejected.push({
        fieldKey: field.key,
        proposed: display(candidate),
        reason: 'la cita no aparece textualmente en el documento',
      });
      continue;
    }

    const outcome = checkValue(field, candidate, quote, today);
    if ('reason' in outcome) {
      rejected.push({ fieldKey: field.key, proposed: display(candidate), reason: outcome.reason });
      continue;
    }

    seen.add(field.key);
    accepted.push({
      fieldKey: field.key,
      spec: field,
      valueText: outcome.valueText,
      valueNumber: outcome.valueNumber,
      valueDate: outcome.valueDate,
      currency: outcome.currency,
      quote: quote.slice(0, 600),
      chunkId: chunk.id,
    });
  }

  return { accepted, rejected };
}

type ValueOutcome =
  | {
      valueText: string | null;
      valueNumber: number | null;
      valueDate: string | null;
      currency: Currency | null;
    }
  | { reason: string };

function checkValue(
  field: FieldSpec,
  candidate: FieldCandidate,
  quote: string,
  today: string,
): ValueOutcome {
  switch (field.kind) {
    case 'date': {
      const value = (candidate.date ?? '').trim();
      if (!isPlausibleDocumentDate(value, today)) {
        return { reason: `"${value}" no es una fecha usable` };
      }
      if (!quoteSupportsDate(quote, value)) {
        return {
          reason: `la cita no dice ${value}; la fecha estaría calculada, no leída`,
        };
      }
      return { valueText: null, valueNumber: null, valueDate: value, currency: null };
    }
    case 'amount': {
      const value = candidate.number;
      if (value == null || !Number.isFinite(value)) {
        return { reason: 'no trae un valor numérico' };
      }
      if (value < 0 || value >= AMOUNT_CEILING) {
        return { reason: `${value} no es un importe usable` };
      }
      if (!quoteSupportsAmount(quote, value)) {
        return {
          reason: `la cita no tiene escrito ${value}; el importe estaría calculado, no leído`,
        };
      }
      // The currency is read from the SAME sentence as the figure. A currency
      // taken from elsewhere in the document is an inference about which of
      // several amounts it governs, and on an import invoice that carries both
      // FOB dollars and a peso total, that inference is wrong half the time.
      return {
        valueText: null,
        valueNumber: value,
        valueDate: null,
        currency: readCurrency(quote),
      };
    }
    case 'nit': {
      const raw = (candidate.text ?? '').trim();
      const digits = nitDigits(raw);
      if (digits.length < 5 || digits.length > 15) {
        return { reason: `"${raw}" no tiene forma de NIT` };
      }
      if (!quoteSupportsNit(quote, raw)) {
        return { reason: `la cita no tiene escrito el NIT ${raw}` };
      }
      return { valueText: digits, valueNumber: null, valueDate: null, currency: null };
    }
    default: {
      const value = (candidate.text ?? '').trim();
      if (value.length < 1) return { reason: 'viene vacío' };
      if (value.length > 400) return { reason: 'el valor es demasiado largo para ser un campo' };
      if (!quoteSupportsText(quote, value)) {
        return { reason: `la cita no contiene "${value}"` };
      }
      return { valueText: value, valueNumber: null, valueDate: null, currency: null };
    }
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface ClassificationClaim {
  docType: string | null;
  quote: string;
}

export type ClassificationOutcome =
  | { docType: string; spec: DocumentTypeSpec; quote: string; chunkId: string }
  | { docType: null; reason: string };

/**
 * Accept a classification only when the document SAYS what it is.
 *
 * Two conditions, both about words on the page: the quoted sentence exists, and
 * it contains one of the phrases that name the type. These documents are forms
 * — a factura says "FACTURA ELECTRÓNICA DE VENTA" across the top, a guía says
 * "GUÍA No.", a declaration says "DECLARACIÓN DE IMPORTACIÓN" — so the check is
 * cheap to satisfy when the answer is right and impossible to satisfy on a
 * hunch.
 *
 * NOT CLASSIFYING IS A RESULT, NOT A FAILURE. An unlabelled scan or an email
 * printed to PDF returns `{docType: null}` with a reason in Spanish, the row is
 * stored as `unclassified`, and a person decides. The alternative — picking the
 * likeliest type — would then run that type's field list over a document that is
 * not one, and produce a full page of confident readings from the wrong form.
 */
export function verifyClassification(
  claim: ClassificationClaim,
  chunks: DocumentChunk[],
): ClassificationOutcome {
  if (!claim.docType) {
    return { docType: null, reason: 'el documento no dice de qué tipo es' };
  }
  const spec = documentType(claim.docType);
  if (!spec) {
    return { docType: null, reason: `"${claim.docType}" no es un tipo que Cortex sepa leer` };
  }
  const quote = (claim.quote ?? '').trim();
  if (quote.length < 8) {
    return { docType: null, reason: 'no citó ninguna frase que nombre el tipo de documento' };
  }
  const chunk = locateQuote(quote, prepareChunks(chunks));
  if (!chunk) {
    return { docType: null, reason: 'la frase que citó no aparece en el documento' };
  }
  const looseQuote = loose(quote);
  const named = spec.cues.some((cue) => looseQuote.includes(loose(cue)));
  if (!named) {
    return {
      docType: null,
      reason: `la frase citada no nombra ${spec.label.toLowerCase()}; el tipo estaría deducido, no leído`,
    };
  }
  return { docType: spec.id, spec, quote: quote.slice(0, 600), chunkId: chunk.id };
}

// ---------------------------------------------------------------------------
// Canonical values
// ---------------------------------------------------------------------------

export interface CanonicalValues {
  doc_number: string | null;
  counterparty_nit: string | null;
  counterparty_name: string | null;
  total_amount: number | null;
  tax_amount: number | null;
  currency: string | null;
  issued_on: string | null;
  due_on: string | null;
}

export const EMPTY_CANONICAL: CanonicalValues = {
  doc_number: null,
  counterparty_nit: null,
  counterparty_name: null,
  total_amount: null,
  tax_amount: null,
  currency: null,
  issued_on: null,
  due_on: null,
};

/** A field as it stands after review: the correction if there is one, else the reading. */
export interface ResolvedField {
  fieldKey: string;
  reviewState: 'pending' | 'confirmed' | 'rejected';
  text: string | null;
  number: number | null;
  date: string | null;
  currency: string | null;
}

/**
 * The queryable columns, computed from CONFIRMED fields only.
 *
 * This function is the boundary between "a model read something" and "the
 * company has a number". Everything the aggregation tools add up comes from
 * here, and a pending field contributes nothing — not a smaller amount, not an
 * estimate: it is absent, and the tools say how many documents were absent.
 */
export function canonicalFrom(typeId: string | null, fields: ResolvedField[]): CanonicalValues {
  const spec = documentType(typeId);
  const out: CanonicalValues = { ...EMPTY_CANONICAL };
  if (!spec) return out;

  for (const field of fields) {
    if (field.reviewState !== 'confirmed') continue;
    const declared = spec.fields.find((f) => f.key === field.fieldKey);
    const slot: CanonicalSlot | undefined = declared?.canonical;
    if (!slot) continue;
    switch (slot) {
      case 'doc_number':
        out.doc_number = field.text ?? out.doc_number;
        break;
      case 'counterparty_nit':
        out.counterparty_nit = field.text ? nitDigits(field.text) : out.counterparty_nit;
        break;
      case 'counterparty_name':
        out.counterparty_name = field.text ?? out.counterparty_name;
        break;
      case 'total_amount':
        if (field.number != null) {
          out.total_amount = field.number;
          // The currency travels with the total and with nothing else. Reading
          // it off the IVA line would let a document whose tax happens to be
          // quoted in dollars re-denominate its peso total.
          out.currency = field.currency ?? out.currency;
        }
        break;
      case 'tax_amount':
        if (field.number != null) out.tax_amount = field.number;
        break;
      case 'issued_on':
        out.issued_on = field.date ?? out.issued_on;
        break;
      case 'due_on':
        out.due_on = field.date ?? out.due_on;
        break;
    }
  }
  return out;
}
