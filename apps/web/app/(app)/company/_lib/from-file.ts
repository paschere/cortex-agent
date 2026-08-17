import type { Identity } from './extract';
import type { FactCandidate } from './proposal';
import { labelKey } from './proposal';

/**
 * UN DOCUMENTO SUBIDO A MANO, Y LO QUE SE LE PUEDE CREER.
 *
 * ===========================================================================
 * AQUÍ SÍ HAY UN MODELO EN EL CAMINO, Y POR ESO ESTE ARCHIVO ES UN FILTRO
 * ===========================================================================
 * `gather.ts` decidió que ningún valor propuesto lo redacta un modelo, y esa
 * decisión sigue en pie. Lo que cambia con un documento subido a mano es que la
 * persona está diciendo «los datos están AQUÍ», y una expresión regular sólo
 * sabe encontrar el NIT y la razón social — el certificado de cámara de
 * comercio trae también el domicilio, el objeto social y la fecha de
 * constitución, escritos con palabras que ninguna expresión regular general
 * puede anclar.
 *
 * Así que se usa el mismo trato que `commitments/extract.ts` le dio a las
 * fechas: EL MODELO PROPONE Y LA ARITMÉTICA DISPONE. El modelo señala dónde
 * está cada dato; estas funciones —puras, sin red, sin reloj— comprueban que:
 *
 *   1. LA CITA ESTÉ EN EL DOCUMENTO, literal. Una paráfrasis es indistinguible
 *      de una invención una vez tiene un chip debajo.
 *   2. EL VALOR ESTÉ DENTRO DE LA CITA, literal. Éste es el que trabaja: la
 *      alucinación interesante no es una frase inventada, es una frase real con
 *      un valor REDACTADO al lado. Un valor que el modelo no pudo copiar
 *      carácter por carácter no se propone.
 *   3. EL CAMPO EXISTA EN EL CATÁLOGO. Una sección o una etiqueta que el
 *      registro no conoce no es un campo nuevo: es el modelo improvisando.
 *
 * Cada comprobación sólo puede rechazar. Lo que sobrevive entra al MISMO
 * `selectProposal` que la búsqueda web, con `kind: 'document'`, y desemboca en
 * el mismo panel donde una persona aprueba campo por campo.
 *
 * La identidad (NIT y razón social) NO pasa por el modelo: la sigue sacando
 * `pickIdentity`, con su dígito de verificación y su ancla en el nombre
 * tecleado. Al modelo se le prohíben esas dos etiquetas para que una respuesta
 * suya no compita con la determinista.
 */

// ---------------------------------------------------------------------------
// Qué archivos se aceptan
// ---------------------------------------------------------------------------

/**
 * Los mismos cuatro tipos que el chat (`/api/chat/attachments`), porque el
 * lector es el mismo: `parseDocument` sabe PDF, DOCX y texto plano, y lo que él
 * no sepa leer aquí tampoco se acepta. Un escaneo sin capa de texto entra como
 * PDF y sale con el texto vacío — ese caso se dice aparte, no aquí.
 */
export const COMPANY_DOC_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
]);

/** El mismo techo que los adjuntos del chat, y por el mismo camino (PostgREST). */
export const COMPANY_DOC_MAX_BYTES = 10 * 1024 * 1024;

/** Para el `accept` del input. Informativo: el servidor vuelve a comprobar. */
export const COMPANY_DOC_ACCEPT = '.pdf,.docx,.txt,.md';

/** `application/pdf;charset=x` → `application/pdf`. Igual que los adjuntos. */
export function baseMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Qué tiene de malo este archivo, en español, o null si no tiene nada.
 *
 * Devuelve la frase y no un código porque la frase ES el producto aquí: el
 * mismo texto se enseña tal cual en el panel.
 */
export function describeUploadProblem(mime: string, sizeBytes: number): string | null {
  if (!COMPANY_DOC_MIME_TYPES.has(baseMime(mime)))
    return 'Por ahora Cortex sólo lee PDF, DOCX, TXT y MD. Un escaneo en imagen todavía no.';
  if (sizeBytes > COMPANY_DOC_MAX_BYTES) return 'El archivo pasa de 10 MB.';
  if (sizeBytes === 0) return 'El archivo llegó vacío.';
  return null;
}

// ---------------------------------------------------------------------------
// Lo que el modelo devuelve, y lo que se le cree
// ---------------------------------------------------------------------------

/** Una respuesta del modelo, todavía sin verificar. */
export interface FieldAnswer {
  section: string;
  label: string;
  value: string;
  /** La frase del documento donde dice estar el valor. Se comprueba, no se cree. */
  quote: string;
}

/**
 * Espacios plegados y minúsculas, TILDES INTACTAS — la misma normalización que
 * `commitments/extract.ts` y por el mismo motivo: un PDF parte las frases con
 * saltos de línea que no significan nada, pero «está» y «esta» son palabras
 * distintas en un documento legal y plegarlas dejaría pasar citas que no están.
 */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Lo más larga que puede venir una cita. Una frase de certificado, no una página. */
const QUOTE_MAX = 300;

/**
 * El JSON del modelo, leído a la defensiva.
 *
 * Mismo trato que `parseCandidates` en commitments: se busca el primer `{` y el
 * último `}` porque los modelos envuelven, y todo lo que no tenga la forma
 * exacta se descarta sin ruido — la verificación de después es la que habla.
 */
export function parseFieldAnswers(raw: string): FieldAnswer[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let parsed: { fields?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { fields?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.fields)) return [];

  return parsed.fields.flatMap((entry): FieldAnswer[] => {
    if (!entry || typeof entry !== 'object') return [];
    const e = entry as Record<string, unknown>;
    const section = typeof e.section === 'string' ? e.section.trim() : '';
    const label = typeof e.label === 'string' ? e.label.trim() : '';
    const value = typeof e.value === 'string' ? e.value.replace(/\s+/g, ' ').trim() : '';
    const quote = typeof e.quote === 'string' ? e.quote.trim() : '';
    if (!section || !label || !value || !quote) return [];
    return [{ section, label, value, quote: quote.slice(0, QUOTE_MAX) }];
  });
}

export interface VerifyOptions {
  /** Los campos sugeridos por sección — el catálogo real, bajado como dato. */
  suggested: Record<string, string[]>;
  /**
   * Etiquetas que el modelo tiene prohibidas aunque estén en el catálogo.
   * La identidad va aquí: la saca `pickIdentity`, con dígito de verificación.
   */
  excludeLabels?: string[];
}

export interface VerifyResult {
  accepted: FieldAnswer[];
  /** Cuántas respuestas se tiraron y por qué clase de fallo, para la nota. */
  rejectedCount: number;
}

/** Una cita más corta que esto no identifica un sitio del documento. */
const QUOTE_MIN = 8;

/**
 * LA PUERTA. Cada `continue` sólo puede rechazar; nada de aquí corrige nada.
 *
 * El orden de las comprobaciones va de la más barata a la más cara, pero
 * ninguna depende de otra: una respuesta tiene que pasarlas todas.
 */
export function verifyFieldAnswers(
  answers: FieldAnswer[],
  documentText: string,
  opts: VerifyOptions,
): VerifyResult {
  const text = normalizeForMatch(documentText);
  const excluded = new Set((opts.excludeLabels ?? []).map(labelKey));
  const accepted: FieldAnswer[] = [];
  const seen = new Set<string>();
  let rejectedCount = 0;

  for (const answer of answers) {
    // El campo tiene que existir en el catálogo, con su etiqueta sugerida.
    // Compararlas con `labelKey` deja pasar «razon social» por «Razón social»,
    // pero lo que se guarda es LA DEL CATÁLOGO — si no, la misma pregunta
    // acabaría escrita de dos formas y la regla 3 de `selectProposal` (no pisar
    // lo escrito) dejaría de reconocerla.
    const catalogLabels = opts.suggested[answer.section];
    const canonical = catalogLabels?.find((l) => labelKey(l) === labelKey(answer.label));
    if (!catalogLabels || !canonical) {
      rejectedCount += 1;
      continue;
    }
    if (excluded.has(labelKey(canonical))) {
      rejectedCount += 1;
      continue;
    }

    const quote = answer.quote.trim();
    if (quote.length < QUOTE_MIN) {
      rejectedCount += 1;
      continue;
    }

    // 1. La cita está en el documento, literal.
    if (!text.includes(normalizeForMatch(quote))) {
      rejectedCount += 1;
      continue;
    }
    // 2. El valor está dentro de la cita, literal. Redactar no es citar.
    if (!normalizeForMatch(quote).includes(normalizeForMatch(answer.value))) {
      rejectedCount += 1;
      continue;
    }

    // Dos respuestas a la misma pregunta del mismo documento son una. Gana la
    // primera, que es la que el modelo puso con más confianza.
    const key = `${answer.section} ${labelKey(canonical)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    accepted.push({ ...answer, label: canonical, quote });
  }

  return { accepted, rejectedCount };
}

// ---------------------------------------------------------------------------
// De hallazgos a candidatos
// ---------------------------------------------------------------------------

export interface DocumentCandidatesInput {
  /** El nombre del archivo tal como lo subieron. Es lo que dice el chip. */
  fileName: string;
  /** «hoy», ya formateado. El chip no formatea fechas. */
  readAt?: string;
  /** Lo que sacó `pickIdentity`, con sus renglones. */
  identity: Identity;
  /** Lo que sobrevivió a `verifyFieldAnswers`. */
  fields: FieldAnswer[];
}

/**
 * Los candidatos, en la MISMA forma que produce `gather.ts`, porque van al
 * mismo sitio: `selectProposal` y de ahí el panel de propuestas. Un documento
 * subido no es un flujo aparte — es una fuente más, con `kind: 'document'`,
 * que le gana a la web y pierde contra el registro, como cualquier documento.
 */
export function buildDocumentCandidates(input: DocumentCandidatesInput): FactCandidate[] {
  const provenance = (quote: string) => ({
    kind: 'document' as const,
    source: input.fileName,
    readAt: input.readAt,
    quote,
  });

  const candidates: FactCandidate[] = [];

  if (input.identity.legalName) {
    candidates.push({
      section: 'identidad',
      label: 'Razón social',
      value: input.identity.legalName.value,
      provenance: provenance(input.identity.legalName.quote),
    });
  }
  if (input.identity.nit) {
    candidates.push({
      section: 'identidad',
      label: 'NIT',
      value: input.identity.nit.value,
      provenance: provenance(input.identity.nit.quote),
    });
  }

  for (const field of input.fields) {
    candidates.push({
      section: field.section,
      label: field.label,
      value: field.value,
      provenance: provenance(field.quote),
    });
  }

  return candidates;
}
