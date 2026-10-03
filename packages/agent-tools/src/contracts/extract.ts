import { generateText } from 'ai';
import { isPlausibleDueDate } from '../commitments/extract';
import { quoteStatesDate, readValidity } from '../doc-expirations/dates';
import { documentText } from '../documents/extract';
import {
  type DocumentChunk,
  locateQuote,
  numbersIn,
  prepareChunks,
  quoteSupportsAmount,
  quoteSupportsText,
} from '../documents/verify';
import { UTILITY_MODEL, utilityModel } from '../model';
import {
  OBLIGATION_CATEGORIES,
  OBLIGATION_PARTIES,
  OBLIGATION_RECURRENCES,
  type ObligationCategory,
  type ObligationParty,
  type ObligationRecurrence,
  type Renewal,
} from './shape';
import { foldText, numberToSpanish } from './text';

/**
 * LO QUE DICE UN CONTRATO FIRMADO: quién se obligó a qué, para cuándo, con qué
 * sanción, y la vigencia (inicio, fin, renovación, aviso previo, valor).
 *
 * El mismo molde que `doc-expirations/detect.ts` y `commitments/extract.ts`:
 * el modelo PROPONE y reglas deterministas DISPONEN, y cada regla sólo puede
 * quitar.
 *
 *   1. CADA OBLIGACIÓN TRAE SU FRASE, y la frase tiene que estar en el
 *      contrato (literal salvo espacios y mayúsculas). Sin frase no hay
 *      obligación: se rechaza y se dice por qué.
 *   2. UNA FECHA TIENE QUE ESTAR ESCRITA EN ESA FRASE. «Treinta días después
 *      de la firma» no es una fecha: queda como nota («cuándo») y sin fecha,
 *      para que una persona la ponga.
 *   3. UNA PERIODICIDAD («cada mes») TIENE QUE DECIRSE en la frase.
 *   4. UNA SANCIÓN se guarda con su propia frase literal, o no se guarda.
 *   5. LA VIGENCIA: cada dato (inicio, fin, renovación automática, días de
 *      aviso, valor) con su frase y comprobado contra ella.
 *
 * La CONFIANZA sale de cuántas reglas pasaron, nunca del modelo. Y todo lo que
 * sale de aquí es una PROPUESTA: se guarda en `contract_obligations` con
 * estado «propuesta» y una persona la confirma (0195, la regla de 0069).
 */

export const CONTRACT_EXTRACTOR_VERSION = 'v1';
const MAX_OBLIGATIONS = 25;

// ---------------------------------------------------------------------------
// Lo que propone el modelo
// ---------------------------------------------------------------------------

export interface ObligationClaim {
  party: string;
  responsible: string | null;
  category: string;
  description: string;
  quote: string;
  dueOn: string | null;
  recurrence: string;
  dueNote: string | null;
  penaltyQuote: string | null;
}

export interface TermClaim {
  startOn: string | null;
  startQuote: string | null;
  endOn: string | null;
  endQuote: string | null;
  renewal: string | null;
  renewalQuote: string | null;
  noticeDays: number | null;
  noticeQuote: string | null;
  valueAmount: number | null;
  valueQuote: string | null;
}

export interface ContractClaims {
  obligations: ObligationClaim[];
  term: TermClaim | null;
}

const PROMPT = `Estás leyendo un CONTRATO firmado por una empresa colombiana («nosotros» = la empresa que te lo entregó; «contraparte» = la otra parte). Saca sus obligaciones y su vigencia.

Devuelve SÓLO JSON:
{"obligations":[{"party":"nosotros|contraparte|ambas","responsible":"<cómo la nombra el contrato, p. ej. EL CONTRATISTA>","category":"pago|entrega|reporte|renovacion|confidencialidad|garantia|otra","description":"<qué debe hacer, en una frase corta>","quote":"<frase EXACTA del contrato que la establece>","dueOn":"<YYYY-MM-DD o null>","recurrence":"none|monthly|quarterly|yearly","dueNote":"<cuándo, con las palabras del contrato, o null>","penaltyQuote":"<frase EXACTA de la sanción o multa por incumplirla, o null>"}],
 "term":{"startOn":"<YYYY-MM-DD o null>","startQuote":"<frase exacta o null>","endOn":"<YYYY-MM-DD o null>","endQuote":"<frase exacta o null>","renewal":"automatica|prorroga|ninguna|null","renewalQuote":"<frase exacta o null>","noticeDays":<número o null>,"noticeQuote":"<frase exacta del aviso previo o null>","valueAmount":<número o null>,"valueQuote":"<frase exacta del valor o null>"}}

REGLAS QUE NO PUEDES ROMPER:
1. Cada cita tiene que estar en el texto que te di, LITERAL. Si tienes que cambiar una palabra, no la devuelvas.
2. Una fecha (dueOn, startOn, endOn) va sólo si está ESCRITA en su cita con día, mes y año. «Treinta días después de la firma», «un año desde el inicio»: deja la fecha en null y pon el «cuándo» en dueNote. Calcular no es leer.
3. Si el contrato no dice algo, null. No completes con lo usual.
4. Máximo ${MAX_OBLIGATIONS} obligaciones: primero las que tienen plata, fecha o sanción.`;

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() && value.trim() !== 'null'
    ? value.trim().slice(0, max)
    : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function parseContractClaims(raw: string): ContractClaims {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { obligations: [], term: null };
  let parsed: { obligations?: unknown; term?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as typeof parsed;
  } catch {
    return { obligations: [], term: null };
  }
  const obligations = Array.isArray(parsed.obligations)
    ? parsed.obligations.slice(0, MAX_OBLIGATIONS).flatMap((entry): ObligationClaim[] => {
        if (!entry || typeof entry !== 'object') return [];
        const e = entry as Record<string, unknown>;
        return [
          {
            party: str(e.party, 20) ?? '',
            responsible: str(e.responsible, 200),
            category: str(e.category, 30) ?? 'otra',
            description: str(e.description, 600) ?? '',
            quote: str(e.quote, 800) ?? '',
            dueOn: str(e.dueOn, 10),
            recurrence: str(e.recurrence, 20) ?? 'none',
            dueNote: str(e.dueNote, 300),
            penaltyQuote: str(e.penaltyQuote, 600),
          },
        ];
      })
    : [];
  let term: TermClaim | null = null;
  if (parsed.term && typeof parsed.term === 'object') {
    const t = parsed.term as Record<string, unknown>;
    term = {
      startOn: str(t.startOn, 10),
      startQuote: str(t.startQuote, 800),
      endOn: str(t.endOn, 10),
      endQuote: str(t.endQuote, 800),
      renewal: str(t.renewal, 20),
      renewalQuote: str(t.renewalQuote, 800),
      noticeDays: num(t.noticeDays),
      noticeQuote: str(t.noticeQuote, 800),
      valueAmount: num(t.valueAmount),
      valueQuote: str(t.valueQuote, 800),
    };
  }
  return { obligations, term };
}

// ---------------------------------------------------------------------------
// Lo que se cree
// ---------------------------------------------------------------------------

export interface VerifiedObligation {
  party: ObligationParty;
  responsibleLabel: string | null;
  category: ObligationCategory;
  description: string;
  quote: string;
  chunkId: string;
  dueOn: string | null;
  recurrence: ObligationRecurrence;
  dueNote: string | null;
  penalty: string | null;
  confidence: 'alta' | 'media' | 'baja';
  reviewNote: string | null;
}

export interface RejectedObligation {
  description: string;
  reason: string;
}

const RECURRENCE_CUES: Record<Exclude<ObligationRecurrence, 'none'>, string[]> = {
  monthly: ['mensual', 'cada mes', 'mes vencido', 'mes anticipado', 'de cada mes', 'mensualmente'],
  quarterly: ['trimestr', 'cada tres meses'],
  yearly: ['anual', 'cada ano', 'cada año', 'por ano', 'por año', 'anualmente'],
};

function hasCue(quote: string, cues: string[]): boolean {
  const f = foldText(quote);
  return cues.some((c) => f.includes(foldText(c)));
}

function asEnum<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  const v = foldText(value).replace(/[^a-z_]/g, '');
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * La puerta de las obligaciones. Lo que pasa sigue siendo una propuesta;
 * lo que no, vuelve en `rejected` con su razón para que la pantalla lo diga.
 */
export function verifyObligations(
  claims: ObligationClaim[],
  chunks: DocumentChunk[],
  today: string,
): { accepted: VerifiedObligation[]; rejected: RejectedObligation[] } {
  const prepared = prepareChunks(chunks);
  const accepted: VerifiedObligation[] = [];
  const rejected: RejectedObligation[] = [];
  const seen = new Set<string>();

  for (const claim of claims) {
    const label = (claim.description || claim.quote).slice(0, 160) || 'obligación sin texto';
    if (!claim.quote) {
      rejected.push({ description: label, reason: 'no trajo la frase del contrato que la dice' });
      continue;
    }
    const chunk = locateQuote(claim.quote, prepared);
    if (!chunk) {
      rejected.push({ description: label, reason: 'la frase no está en el contrato' });
      continue;
    }
    const notes: string[] = [];
    let failures = 0;

    const party = asEnum<ObligationParty>(claim.party, OBLIGATION_PARTIES, 'ambas');
    if (!(OBLIGATION_PARTIES as readonly string[]).includes(foldText(claim.party))) {
      notes.push('no quedó claro quién debe cumplirla');
      failures += 1;
    }
    const category = asEnum<ObligationCategory>(claim.category, OBLIGATION_CATEGORIES, 'otra');
    const responsibleLabel =
      claim.responsible &&
      quoteSupportsText(chunks.map((c) => c.content).join('\n'), claim.responsible)
        ? claim.responsible
        : null;

    // La fecha: escrita en la frase, o nada.
    let dueOn: string | null = null;
    if (claim.dueOn) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(claim.dueOn) || !quoteStatesDate(claim.quote, claim.dueOn)) {
        notes.push(`la frase no dice ${claim.dueOn}: la fecha sería calculada, no leída`);
        failures += 1;
      } else if (!isPlausibleDueDate(claim.dueOn, today)) {
        notes.push(`${claim.dueOn} no es una fecha creíble para una obligación`);
        failures += 1;
      } else {
        dueOn = claim.dueOn;
      }
    }

    // La periodicidad: dicha en la frase.
    let recurrence = asEnum<ObligationRecurrence>(claim.recurrence, OBLIGATION_RECURRENCES, 'none');
    if (recurrence !== 'none' && !hasCue(claim.quote, RECURRENCE_CUES[recurrence])) {
      notes.push('la frase no dice que se repita');
      recurrence = 'none';
      failures += 1;
    }

    // El «cuándo» en palabras: sólo si está en la frase.
    const dueNote =
      claim.dueNote && quoteSupportsText(claim.quote, claim.dueNote) ? claim.dueNote : null;
    if (!dueOn && !dueNote && recurrence === 'none') {
      notes.push('sin fecha: ponla al confirmar si tiene una');
    }

    // La sanción, con su propia frase literal.
    let penalty: string | null = null;
    if (claim.penaltyQuote) {
      if (locateQuote(claim.penaltyQuote, prepared)) penalty = claim.penaltyQuote.slice(0, 600);
      else notes.push('la sanción que propuso no está escrita en el contrato');
    }

    const description =
      claim.description.trim().length >= 3 ? claim.description.trim() : claim.quote.slice(0, 300);
    const key = `${foldText(claim.quote).slice(0, 200)}#${party}`;
    if (seen.has(key)) continue;
    seen.add(key);

    accepted.push({
      party,
      responsibleLabel,
      category,
      description: description.slice(0, 600),
      quote: claim.quote.slice(0, 800),
      chunkId: chunk.id,
      dueOn,
      recurrence,
      dueNote,
      penalty,
      confidence: failures === 0 ? 'alta' : failures === 1 ? 'media' : 'baja',
      reviewNote: notes.length ? notes.join('; ').slice(0, 600) : null,
    });
  }
  return { accepted, rejected };
}

/** Un dato de la vigencia, con la frase que lo dice (o por qué no se cree). */
export interface TermFact<T> {
  value: T | null;
  quote: string | null;
  note: string | null;
}

export interface VerifiedTerm {
  startOn: TermFact<string>;
  endOn: TermFact<string>;
  renewal: TermFact<Renewal>;
  noticeDays: TermFact<number>;
  valueAmount: TermFact<number>;
}

const EMPTY = <T>(note: string | null = null): TermFact<T> => ({ value: null, quote: null, note });

const AUTOMATIC_CUES = [
  'prorroga automatica',
  'prorrogara automaticamente',
  'renovara automaticamente',
  'se renovara',
  'se prorrogara',
  'se entendera renovado',
  'se entendera prorrogado',
  'renovacion automatica',
  'automaticamente',
];
const EXTENSION_CUES = ['prorroga', 'prorrogar', 'renovar', 'renovacion'];

/** ¿Dice esta frase un plazo de `n` días, en cifras o en letras? */
export function quoteStatesDays(quote: string, n: number): boolean {
  if (!Number.isInteger(n) || n < 0) return false;
  if (numbersIn(quote).some((x) => x === n)) return true;
  if (n < 2) return false;
  const words = foldText(numberToSpanish(n));
  return new RegExp(`(^|[^a-z])${words.replace(/ /g, '\\s+')}([^a-z]|$)`).test(foldText(quote));
}

export function verifyTerm(
  claim: TermClaim | null,
  chunks: DocumentChunk[],
  today: string,
): VerifiedTerm {
  if (!claim) {
    return {
      startOn: EMPTY(),
      endOn: EMPTY(),
      renewal: EMPTY(),
      noticeDays: EMPTY(),
      valueAmount: EMPTY(),
    };
  }
  const prepared = prepareChunks(chunks);
  const located = (q: string | null) => (q ? locateQuote(q, prepared) !== null : false);

  const date = (
    iso: string | null,
    quote: string | null,
    which: 'from' | 'until',
  ): TermFact<string> => {
    if (!quote || !located(quote)) {
      return EMPTY(iso ? 'la frase que la diría no está en el contrato' : null);
    }
    if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) && quoteStatesDate(quote, iso)) {
      if (!isPlausibleDueDate(iso, today)) return EMPTY(`${iso} no es una fecha creíble`);
      return { value: iso, quote, note: null };
    }
    const validity = readValidity(quote);
    const read = which === 'until' ? validity.until : validity.from;
    if (read && isPlausibleDueDate(read.iso, today)) {
      return { value: read.iso, quote, note: `leída de la frase («${read.raw}»)` };
    }
    return { value: null, quote, note: 'la frase no dice la fecha con día, mes y año' };
  };

  const startOn = date(claim.startOn, claim.startQuote, 'from');
  const endOn = date(claim.endOn, claim.endQuote, 'until');
  if (startOn.value && endOn.value && startOn.value > endOn.value) {
    endOn.value = null;
    endOn.note = 'el fin quedaba antes del inicio';
  }

  let renewal: TermFact<Renewal> = EMPTY();
  if (claim.renewal && claim.renewalQuote && located(claim.renewalQuote)) {
    const r = foldText(claim.renewal);
    if (r === 'automatica' && hasCue(claim.renewalQuote, AUTOMATIC_CUES)) {
      renewal = { value: 'automatica', quote: claim.renewalQuote, note: null };
    } else if (r === 'prorroga' && hasCue(claim.renewalQuote, EXTENSION_CUES)) {
      renewal = { value: 'prorroga', quote: claim.renewalQuote, note: null };
    } else if (r === 'ninguna') {
      renewal = { value: 'ninguna', quote: claim.renewalQuote, note: null };
    } else {
      renewal = {
        value: null,
        quote: claim.renewalQuote,
        note: 'la frase no dice cómo se renueva',
      };
    }
  }

  let noticeDays: TermFact<number> = EMPTY();
  if (claim.noticeDays !== null && claim.noticeQuote && located(claim.noticeQuote)) {
    noticeDays =
      claim.noticeDays >= 0 &&
      claim.noticeDays <= 730 &&
      quoteStatesDays(claim.noticeQuote, claim.noticeDays)
        ? { value: Math.round(claim.noticeDays), quote: claim.noticeQuote, note: null }
        : {
            value: null,
            quote: claim.noticeQuote,
            note: `la frase no dice ${claim.noticeDays} días`,
          };
  }

  let valueAmount: TermFact<number> = EMPTY();
  if (claim.valueAmount !== null && claim.valueQuote && located(claim.valueQuote)) {
    valueAmount = quoteSupportsAmount(claim.valueQuote, claim.valueAmount)
      ? { value: claim.valueAmount, quote: claim.valueQuote, note: null }
      : { value: null, quote: claim.valueQuote, note: 'la cifra no está escrita en la frase' };
  }

  return { startOn, endOn, renewal, noticeDays, valueAmount };
}

// ---------------------------------------------------------------------------
// Leer de punta a punta
// ---------------------------------------------------------------------------

const CONTRACT_CUES = [
  'contrato',
  'clausula',
  'se obliga',
  'obligaciones',
  'las partes',
  'otrosi',
  'acuerdo',
];

/** ¿Vale la pena pagar una llamada? Sin modelo. */
export function looksLikeContract(text: string): boolean {
  const f = foldText(text.slice(0, 40_000));
  return CONTRACT_CUES.filter((c) => f.includes(c)).length >= 2;
}

export interface ContractReading {
  obligations: VerifiedObligation[];
  rejected: RejectedObligation[];
  term: VerifiedTerm;
  modelCalled: boolean;
  modelId: string | null;
  reason: string | null;
}

export async function readContract(
  chunks: DocumentChunk[],
  today: string,
): Promise<ContractReading> {
  const empty = verifyTerm(null, chunks, today);
  if (chunks.length === 0) {
    return {
      obligations: [],
      rejected: [],
      term: empty,
      modelCalled: false,
      modelId: null,
      reason: 'el documento todavía no tiene texto (se está leyendo o es una imagen sin OCR)',
    };
  }
  const text = documentText(chunks);
  if (!looksLikeContract(text)) {
    return {
      obligations: [],
      rejected: [],
      term: empty,
      modelCalled: false,
      modelId: null,
      reason: 'no parece un contrato (no habla de cláusulas, partes ni obligaciones)',
    };
  }
  const result = await generateText({
    model: utilityModel(),
    system: PROMPT,
    prompt: text,
    maxTokens: 3500,
  });
  const claims = parseContractClaims(result.text);
  const { accepted, rejected } = verifyObligations(claims.obligations, chunks, today);
  return {
    obligations: accepted,
    rejected,
    term: verifyTerm(claims.term, chunks, today),
    modelCalled: true,
    modelId: UTILITY_MODEL,
    reason: accepted.length === 0 ? 'no encontré obligaciones con su frase en el contrato' : null,
  };
}
