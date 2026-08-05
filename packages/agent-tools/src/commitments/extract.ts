import { generateText } from 'ai';
import { utilityModel } from '../model';
import { isoDate } from './shape';

/**
 * Reading dates out of a contract, and refusing most of what comes back.
 *
 * This is the only path in the module where a model touches a date, so it is
 * built as a filter rather than as an extractor. The model proposes; three
 * deterministic checks dispose, and every one of them can only reject:
 *
 *   1. THE QUOTE MUST BE REAL. The sentence the model says it read the date
 *      from has to appear, verbatim, in the chunk it names. A paraphrase is
 *      indistinguishable from an invention once it is in the database, and
 *      "the quote was approximately right" is not a standard anybody can audit.
 *
 *   2. THE DATE MUST BE IN THE QUOTE. Day, month and year all have to be
 *      present in those words. This is the check that does the real work,
 *      because the interesting hallucination is not a fabricated sentence, it
 *      is a real sentence with a COMPUTED date attached — "vigencia de doce
 *      meses desde el 1 de enero de 2026" proposed as 2027-01-01. That is
 *      arithmetic, possibly correct, and it is not what the document says. It
 *      gets rejected, and if the company wants it watched a person types it in
 *      and their name goes on it.
 *
 *   3. THE DATE MUST BE A DATE. Parseable, and not absurdly far from now.
 *
 * Whatever survives is still not watched. It is written with
 * `review_state='pending'` and waits for a human — see store.ts. Two gates for
 * one class of error is the correct amount, because this is the class of error
 * that discredits everything else the product says.
 */

export interface ExtractionCandidate {
  title: string;
  kind: string;
  dueOn: string;
  quote: string;
  counterparty?: string | null;
  amountCop?: number | null;
}

export interface VerifiedCandidate extends ExtractionCandidate {
  chunkId: string;
  chunkIndex: number;
}

export interface RejectedCandidate {
  candidate: ExtractionCandidate;
  reason: string;
}

export interface DocumentChunk {
  id: string;
  chunk_index: number;
  content: string;
}

// ---------------------------------------------------------------------------
// The deterministic core
// ---------------------------------------------------------------------------

/**
 * Collapse whitespace and case so a quote survives the difference between a PDF
 * with a line break in the middle of a sentence and the same sentence typed
 * out. Accents are kept — "diciembre" and "diciembre" differ in no way that
 * matters, but stripping accents would let "está" match "esta", and in a legal
 * document those are different words.
 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

const MONTHS_ES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** `setiembre` is common in Colombian legal prose and is the same month. */
const MONTH_ALIASES: Record<string, string[]> = { septiembre: ['setiembre'] };

/**
 * Does this sentence actually contain this date?
 *
 * Day, month and year each have to be findable in the words. The month counts
 * as found either as a number (`12`, `/12/`, `-12-`) or as its Spanish name.
 * Digits are matched on word boundaries so the "31" in a contract number does
 * not vouch for the 31st.
 */
export function quoteSupportsDate(quote: string, dueOn: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueOn);
  if (!m) return false;
  const [, year, month, day] = m as unknown as [string, string, string, string];
  const text = normalize(quote);

  if (!text.includes(year)) return false;

  const dayNum = String(Number(day));
  const hasDay = new RegExp(`(^|[^\\d])0?${dayNum}([^\\d]|$)`).test(text);
  if (!hasDay) return false;

  const monthName = MONTHS_ES[Number(month) - 1] ?? '';
  const names = [monthName, ...(MONTH_ALIASES[monthName] ?? [])].filter(Boolean);
  if (names.some((n) => text.includes(n))) return true;

  const monthNum = String(Number(month));
  return new RegExp(`(^|[^\\d])0?${monthNum}([^\\d]|$)`).test(text);
}

/** A date has to be a date, and within a window where a deadline is plausible. */
export function isPlausibleDueDate(dueOn: string, today: string): boolean {
  if (!isoDate.safeParse(dueOn).success) return false;
  const t = Date.parse(`${dueOn}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  const now = Date.parse(`${today}T00:00:00Z`);
  const years = (t - now) / (365.25 * 86_400_000);
  // Five years back covers a contract whose lapse is being discovered late;
  // twenty years forward covers a long lease. Outside that, the "date" is
  // almost always a page number or an amount that acquired a year.
  return years > -5 && years < 20;
}

/**
 * The gate. Everything that reaches the database goes through here first.
 *
 * Returns what survived and, separately, what did not and why — because the
 * rejections are the interesting output. A reviewer who can see that four of
 * six proposals were thrown out for citing sentences that are not in the
 * document learns something true about how much to trust the two that remain.
 */
export function verifyCandidates(
  candidates: ExtractionCandidate[],
  chunks: DocumentChunk[],
  today: string,
): { accepted: VerifiedCandidate[]; rejected: RejectedCandidate[] } {
  const accepted: VerifiedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  const normalized = chunks.map((c) => ({ chunk: c, text: normalize(c.content) }));

  for (const candidate of candidates) {
    const quote = (candidate.quote ?? '').trim();
    if (quote.length < 8) {
      rejected.push({ candidate, reason: 'la cita es demasiado corta para verificarla' });
      continue;
    }
    if (!isPlausibleDueDate(candidate.dueOn, today)) {
      rejected.push({ candidate, reason: `"${candidate.dueOn}" no es una fecha usable` });
      continue;
    }

    const needle = normalize(quote);
    const hit = normalized.find((n) => n.text.includes(needle));
    if (!hit) {
      rejected.push({
        candidate,
        reason: 'la cita no aparece textualmente en el documento',
      });
      continue;
    }
    if (!quoteSupportsDate(quote, candidate.dueOn)) {
      rejected.push({
        candidate,
        reason: `la cita no dice ${candidate.dueOn}; la fecha estaría calculada, no leída`,
      });
      continue;
    }

    accepted.push({
      ...candidate,
      quote,
      chunkId: hit.chunk.id,
      chunkIndex: hit.chunk.chunk_index,
    });
  }

  // Two proposals for the same date and the same words are one proposal.
  const seen = new Set<string>();
  const deduped = accepted.filter((c) => {
    const key = `${c.dueOn}#${normalize(c.quote).slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { accepted: deduped, rejected };
}

// ---------------------------------------------------------------------------
// The part that needs a model
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `Estás leyendo un documento de una empresa de logística postal y aduanera en Colombia. Encuentra los COMPROMISOS CON FECHA que el documento establece: vencimientos, plazos, renovaciones, fechas de pago.

Para cada uno devuelve:
- "title": qué es, en una frase corta en español (ej. "Renovación contrato Servientrega").
- "kind": uno de soat, rtm, contract, policy, warranty, customs, payment, other.
- "dueOn": la fecha en formato YYYY-MM-DD.
- "quote": la frase EXACTA del documento donde aparece esa fecha, copiada carácter por carácter. No la resumas, no la corrijas, no la traduzcas.
- "counterparty": con quién es, si el documento lo dice. Si no, null.
- "amountCop": el valor en pesos como número entero, sólo si el documento lo dice. Si no, null.

REGLAS QUE NO PUEDES ROMPER:
1. La cita tiene que estar en el texto que te di, literal. Si tienes que cambiar una palabra, no la incluyas.
2. La fecha tiene que estar ESCRITA en esa misma cita: día, mes y año. Si tuviste que calcularla ("doce meses desde…"), NO la devuelvas. Calcular no es leer.
3. Si el documento no fija fechas, devuelve una lista vacía. Una lista vacía es una respuesta correcta y frecuente.

Devuelve SÓLO JSON: {"commitments":[...]}`;

function parseCandidates(raw: string): ExtractionCandidate[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let parsed: { commitments?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { commitments?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.commitments)) return [];

  return parsed.commitments.flatMap((entry): ExtractionCandidate[] => {
    if (!entry || typeof entry !== 'object') return [];
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    const dueOn = typeof e.dueOn === 'string' ? e.dueOn.trim() : '';
    const quote = typeof e.quote === 'string' ? e.quote.trim() : '';
    if (!title || !dueOn || !quote) return [];
    const amount = typeof e.amountCop === 'number' ? Math.round(e.amountCop) : null;
    return [
      {
        title: title.slice(0, 200),
        kind: typeof e.kind === 'string' ? e.kind : 'other',
        dueOn,
        quote: quote.slice(0, 600),
        counterparty: typeof e.counterparty === 'string' ? e.counterparty.slice(0, 160) : null,
        amountCop: amount != null && amount >= 0 ? amount : null,
      },
    ];
  });
}

/** How much of a document goes to the model. Enough for a contract's dated clauses. */
const MAX_PROMPT_CHARS = 30_000;

export async function proposeCommitments(chunks: DocumentChunk[]): Promise<ExtractionCandidate[]> {
  if (chunks.length === 0) return [];
  const text = chunks
    .slice()
    .sort((a, b) => a.chunk_index - b.chunk_index)
    .map((c) => c.content)
    .join('\n\n')
    .slice(0, MAX_PROMPT_CHARS);

  const result = await generateText({
    model: utilityModel(),
    system: EXTRACTION_PROMPT,
    prompt: text,
    maxTokens: 1500,
  });
  return parseCandidates(result.text);
}
