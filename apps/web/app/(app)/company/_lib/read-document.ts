import 'server-only';
import { COMPANY_SECTIONS, listClients, utilityModel } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateText } from 'ai';
import { pickIdentity } from './extract';
import { buildDocumentCandidates, parseFieldAnswers, verifyFieldAnswers } from './from-file';
import type { GatherResult } from './gather';

/**
 * LEER UN DOCUMENTO SUBIDO A MANO Y VOLVER CON CANDIDATOS.
 *
 * Es la quinta fuente del prerrelleno, con la misma forma que las cuatro de
 * `gather.ts` —candidatos más notas— porque desemboca en el mismo sitio: el
 * `selectProposal` de la acción y de ahí el panel donde se aprueba campo por
 * campo. No hay un segundo flujo: hay una fuente más.
 *
 * El reparto del trabajo está argumentado en `from-file.ts` y se resume en una
 * línea: la identidad la saca `pickIdentity` sin modelo (dígito de
 * verificación, ancla en el nombre tecleado, lista de exclusión de clientes), y
 * el resto del catálogo lo SEÑALA el modelo y lo VERIFICA la aritmética — sólo
 * sobrevive lo que está citado palabra por palabra.
 */

/**
 * Cuánto documento ve el modelo. El mismo techo que la extracción de
 * compromisos: los datos de una cámara de comercio o un RUT van al principio.
 * `pickIdentity` sí recorre el texto entero, que no le cuesta nada.
 */
const MAX_PROMPT_CHARS = 30_000;

/**
 * El catálogo, escrito en el prompt tal como existe. La identidad no se le
 * pide: la saca la vía determinista, y pedirla dos veces sería invitar a que
 * una respuesta redactada compita con una leída.
 */
const EXCLUDED_LABELS = ['Razón social', 'NIT'];

function buildPrompt(): string {
  const catalog = COMPANY_SECTIONS.map(
    (s) =>
      `- section "${s.key}" (${s.name}): ${s.suggested
        .filter((label) => !EXCLUDED_LABELS.includes(label))
        .map((label) => `"${label}"`)
        .join(', ')}`,
  ).join('\n');

  return `Estás leyendo un documento que una empresa colombiana subió para rellenar su propia ficha (un certificado de cámara de comercio, un RUT, un contrato, una presentación interna).

Busca ÚNICAMENTE los campos de este catálogo. "section" y "label" tienen que ser EXACTAMENTE uno de estos pares:
${catalog}

Para cada campo que el documento responda, devuelve:
- "section": la clave de la sección, tal como está arriba.
- "label": la etiqueta, tal como está arriba.
- "value": el dato, COPIADO carácter por carácter del documento. No lo resumas, no lo redactes, no lo completes.
- "quote": la frase exacta del documento que contiene ese valor, copiada literal.

REGLAS QUE NO PUEDES ROMPER:
1. El valor tiene que estar DENTRO de la cita, literal. Si para responder tienes que redactar o resumir, NO devuelvas ese campo. Redactar no es citar.
2. La cita tiene que estar en el texto que te di, literal. Si tienes que cambiar una palabra, no la incluyas.
3. No devuelvas la razón social ni el NIT: ya los leyó otra vía.
4. Si el documento no responde ningún campo, devuelve una lista vacía. Una lista vacía es una respuesta correcta y frecuente.

Devuelve SÓLO JSON: {"fields":[...]}`;
}

export interface ReadDocumentInput {
  db: SupabaseClient;
  /** El nombre que tecleó la persona. El desempate de la identidad, como siempre. */
  typedName: string;
  /** El nombre del archivo, para el chip. */
  fileName: string;
  /** El texto ya extraído por `parseDocument`. */
  text: string;
  /** Cuántas páginas tenía, si el lector lo supo decir. Para la nota. */
  pages?: number;
}

/** «hoy» para el chip, en el mismo formato corto que usa `gather.ts`. */
function today(): string {
  return new Date().toLocaleDateString('es-CO', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export async function readCompanyDocument(input: ReadDocumentInput): Promise<GatherResult> {
  const notes: string[] = [];

  // La lista de exclusión: los NIT de sus clientes registrados no pueden
  // proponerse como propios. Misma guarda y mismo motivo que `gather.ts`.
  let excludeNitDigits: string[] = [];
  try {
    const clients = await listClients(input.db, { limit: 200 });
    excludeNitDigits = clients
      .map((c) => c.tax_id)
      .filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    notes.push('No se pudieron leer tus clientes, así que no pude descartar sus NIT.');
  }

  const identity = pickIdentity(input.text, { typedName: input.typedName, excludeNitDigits });

  // El modelo, en su propio try: si no contesta, la identidad determinista
  // sigue en pie y la nota dice qué mitad faltó. Misma disciplina de caída que
  // las fuentes de `gather.ts`.
  let accepted: ReturnType<typeof verifyFieldAnswers>['accepted'] = [];
  let rejectedCount = 0;
  try {
    const result = await generateText({
      model: utilityModel(),
      system: buildPrompt(),
      prompt: input.text.slice(0, MAX_PROMPT_CHARS),
      maxTokens: 1500,
    });
    const verified = verifyFieldAnswers(parseFieldAnswers(result.text), input.text, {
      suggested: Object.fromEntries(COMPANY_SECTIONS.map((s) => [s.key, [...s.suggested]])),
      excludeLabels: EXCLUDED_LABELS,
    });
    accepted = verified.accepted;
    rejectedCount = verified.rejectedCount;
  } catch {
    notes.push(
      'No pude pasarle el documento al modelo, así que sólo saqué lo que se lee sin él: la razón social y el NIT.',
    );
  }

  const read = `Leí ${input.fileName}${input.pages ? ` (${input.pages} ${input.pages === 1 ? 'página' : 'páginas'})` : ''}`;
  notes.unshift(
    input.text.length > MAX_PROMPT_CHARS
      ? `${read}, y era largo: los campos generales los busqué sólo al principio; el NIT y la razón social, en todo.`
      : `${read} entero.`,
  );

  // Que se tiró algo se dice, porque es la mitad interesante del resultado:
  // cuatro respuestas descartadas por no estar citadas enseñan cuánto creerle
  // a las que quedaron. Mismo argumento que `verifyCandidates` en commitments.
  if (rejectedCount > 0) {
    notes.push(
      `Descarté ${rejectedCount} ${rejectedCount === 1 ? 'dato que el modelo no pudo citar' : 'datos que el modelo no pudo citar'} palabra por palabra del documento.`,
    );
  }

  return {
    candidates: buildDocumentCandidates({
      fileName: input.fileName,
      readAt: today(),
      identity,
      fields: accepted,
    }),
    notes,
  };
}
