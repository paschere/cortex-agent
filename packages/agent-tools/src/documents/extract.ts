import { generateText } from 'ai';
import { UTILITY_MODEL, utilityModel } from '../model';
import { DOCUMENT_TYPES, type DocumentTypeSpec, documentType } from './types';
import {
  type ClassificationOutcome,
  type DocumentChunk,
  type FieldCandidate,
  type RejectedField,
  type VerifiedField,
  verifyClassification,
  verifyFields,
} from './verify';

/**
 * The two model calls, and everything that is done to their output before any
 * of it is believed.
 *
 * TWO CALLS, NOT ONE. Classification is a short question with a short answer,
 * and it decides which of six field lists is even relevant. Asking for the type
 * and the fields together means every document is read against a union of forty
 * possible fields, which costs more, reads worse, and — the part that matters —
 * makes "I do not recognise this document" impossible to answer cleanly,
 * because the model has already been handed a list of things to find. Here, an
 * unrecognised document costs one short call and stops.
 *
 * The model's output is a proposal in the strict sense: nothing it says is
 * stored until `verify.ts` has confirmed the sentence exists and the value is
 * written inside it, and nothing that survives that counts towards any total
 * until a person confirms it.
 */

/** How much of a document goes to the model. A long contract's front matter and
 * its dated clauses both fit; a 300-page annex does not need to. */
const MAX_PROMPT_CHARS = 30_000;

/** Bumped when the prompts or the field specs change in a way that would make
 * an old row's readings incomparable to a new one's. Stored on every row. */
export const EXTRACTOR_VERSION = 'v1';

export function documentText(chunks: DocumentChunk[]): string {
  return chunks
    .slice()
    .sort((a, b) => a.chunk_index - b.chunk_index)
    .map((c) => c.content)
    .join('\n\n')
    .slice(0, MAX_PROMPT_CHARS);
}

// ---------------------------------------------------------------------------
// 1. What is this?
// ---------------------------------------------------------------------------

function classificationPrompt(): string {
  const catalogue = DOCUMENT_TYPES.map(
    (t) => `- ${t.id}: ${t.blurb} Suele decir: ${t.cues.slice(0, 4).join(', ')}.`,
  ).join('\n');

  return `Estás clasificando un documento de una empresa colombiana de logística postal y aduanera.

Los tipos que existen:
${catalogue}

Devuelve SÓLO JSON: {"docType": "<id o null>", "quote": "<frase exacta del documento que dice qué es>"}

REGLAS QUE NO PUEDES ROMPER:
1. La "quote" tiene que estar en el texto que te di, LITERAL, y tiene que ser la frase donde el documento SE NOMBRA a sí mismo ("FACTURA ELECTRÓNICA DE VENTA No. FE-4471", "GUÍA DE TRANSPORTE No 88213", "DECLARACIÓN DE IMPORTACIÓN"). No la resumas ni la corrijas.
2. Si el documento no dice de qué tipo es, devuelve {"docType": null, "quote": ""}. NO adivines por el contenido. Un documento sin clasificar es una respuesta correcta y frecuente; una factura clasificada como guía arruina todo lo que se lea después.
3. Un solo tipo. Si el archivo trae varios documentos pegados, clasifica por el primero.`;
}

interface ClassificationClaim {
  docType: string | null;
  quote: string;
}

function parseClassification(raw: string): ClassificationClaim {
  const parsed = parseJson(raw);
  if (!parsed) return { docType: null, quote: '' };
  const docType = typeof parsed.docType === 'string' ? parsed.docType.trim() : null;
  const quote = typeof parsed.quote === 'string' ? parsed.quote.trim() : '';
  return { docType: docType && docType !== 'null' ? docType : null, quote };
}

export async function classifyDocument(chunks: DocumentChunk[]): Promise<ClassificationOutcome> {
  if (chunks.length === 0) {
    return { docType: null, reason: 'el documento todavía no tiene texto indexado' };
  }
  const result = await generateText({
    model: utilityModel(),
    system: classificationPrompt(),
    prompt: documentText(chunks),
    maxTokens: 400,
  });
  return verifyClassification(parseClassification(result.text), chunks);
}

// ---------------------------------------------------------------------------
// 2. What does it say?
// ---------------------------------------------------------------------------

function extractionPrompt(spec: DocumentTypeSpec): string {
  const fields = spec.fields
    .map((f) => `- "${f.key}" (${kindWord(f.kind)}): ${f.label}. ${f.hint}`)
    .join('\n');

  return `Estás leyendo ${unArticle(spec.label)} de una empresa colombiana de logística postal y aduanera. Saca ÚNICAMENTE los campos de esta lista:

${fields}

Para cada campo que encuentres devuelve un objeto:
{"field": "<clave>", "text": <texto o null>, "number": <número o null>, "date": "<YYYY-MM-DD o null>", "quote": "<la frase exacta del documento donde está ese valor>"}

- Campos de texto y NIT: usa "text".
- Campos de dinero: usa "number", con punto decimal y sin separadores de miles (1500000 o 1500000.50). NO pongas el símbolo ni la moneda dentro del número.
- Campos de fecha: usa "date" en formato YYYY-MM-DD.

REGLAS QUE NO PUEDES ROMPER:
1. La "quote" tiene que estar en el texto que te di, LITERAL, carácter por carácter. Si tienes que cambiar una palabra, no devuelvas el campo.
2. EL VALOR TIENE QUE ESTAR ESCRITO DENTRO DE ESA MISMA CITA. Los dígitos del importe, el día y el mes y el año de la fecha, los dígitos del NIT. Si lo tuviste que calcular — sumar el subtotal y el IVA para llegar al total, contar doce meses desde una fecha, deducir el dígito de verificación — NO lo devuelvas. Calcular no es leer.
3. Si un campo no está en el documento, no lo incluyas. Una lista corta es una respuesta correcta; un campo inventado no lo es.
4. La cita debe ser corta: la línea o la frase donde está el dato, no el párrafo entero.

Devuelve SÓLO JSON: {"fields":[...]}`;
}

function kindWord(kind: string): string {
  if (kind === 'amount') return 'dinero';
  if (kind === 'date') return 'fecha';
  if (kind === 'nit') return 'NIT';
  return 'texto';
}

function unArticle(label: string): string {
  return /^(factura|guía|declaración|póliza)/i.test(label) ? `una ${label}` : `un ${label}`;
}

function parseCandidates(raw: string): FieldCandidate[] {
  const parsed = parseJson(raw);
  const list = parsed?.fields;
  if (!Array.isArray(list)) return [];

  return list.flatMap((entry): FieldCandidate[] => {
    if (!entry || typeof entry !== 'object') return [];
    const e = entry as Record<string, unknown>;
    const fieldKey = typeof e.field === 'string' ? e.field.trim() : '';
    const quote = typeof e.quote === 'string' ? e.quote.trim() : '';
    if (!fieldKey || !quote) return [];
    return [
      {
        fieldKey,
        text: typeof e.text === 'string' ? e.text.trim().slice(0, 400) : null,
        number: typeof e.number === 'number' ? e.number : null,
        date: typeof e.date === 'string' ? e.date.trim() : null,
        quote: quote.slice(0, 600),
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// The whole reading
// ---------------------------------------------------------------------------

export interface ExtractionReading {
  docType: string | null;
  /** Set when the type was recognised: the sentence that named it. */
  classificationQuote: string | null;
  classificationChunkId: string | null;
  /** Set when it was not. Spanish, for the person who has to decide. */
  unclassifiedReason: string | null;
  fields: VerifiedField[];
  rejected: RejectedField[];
  modelId: string;
  extractorVersion: string;
}

/**
 * Read one document end to end: classify it, then pull the fields its type
 * declares, then throw away everything that cannot be checked against the page.
 *
 * `forcedType` is how a person overrules the classifier from the review screen
 * — "this IS a factura, read it as one". It skips the classification call
 * entirely rather than arguing with it, and the resulting rows carry no
 * classification quote, because there is none: a human said so, and that is a
 * better source than a sentence.
 */
export async function readDocument(
  chunks: DocumentChunk[],
  today: string,
  forcedType?: string | null,
): Promise<ExtractionReading> {
  const base = {
    modelId: UTILITY_MODEL,
    extractorVersion: EXTRACTOR_VERSION,
    fields: [] as VerifiedField[],
    rejected: [] as RejectedField[],
  };

  let typeId: string;
  let classificationQuote: string | null = null;
  let classificationChunkId: string | null = null;

  if (forcedType) {
    const spec = documentType(forcedType);
    if (!spec) {
      return {
        ...base,
        docType: null,
        classificationQuote: null,
        classificationChunkId: null,
        unclassifiedReason: `"${forcedType}" no es un tipo que Cortex sepa leer`,
      };
    }
    typeId = spec.id;
  } else {
    const classified = await classifyDocument(chunks);
    if (classified.docType === null) {
      return {
        ...base,
        docType: null,
        classificationQuote: null,
        classificationChunkId: null,
        unclassifiedReason: classified.reason,
      };
    }
    typeId = classified.docType;
    classificationQuote = classified.quote;
    classificationChunkId = classified.chunkId;
  }

  const spec = documentType(typeId) as DocumentTypeSpec;
  const result = await generateText({
    model: utilityModel(),
    system: extractionPrompt(spec),
    prompt: documentText(chunks),
    maxTokens: 2000,
  });

  const { accepted, rejected } = verifyFields(parseCandidates(result.text), chunks, typeId, today);

  return {
    ...base,
    docType: typeId,
    classificationQuote,
    classificationChunkId,
    unclassifiedReason: null,
    fields: accepted,
    rejected,
  };
}

// ---------------------------------------------------------------------------

/** The first JSON object in a model's reply, or null. */
function parseJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
