/**
 * «POR QUÉ LO PROPONGO», SIN LAS NOTAS DEL MODELO.
 *
 * El texto sale de lo que Cortex dijo en el mensaje. Un mensaje con
 * herramientas trae VARIOS trozos de texto (uno por paso) que el SDK une sin
 * separador: «…diseño completo.Corrijo los nombres…El id…». Aquí se unen con un
 * espacio, se separan las frases pegadas, se descartan las notas técnicas del
 * modelo para sí mismo (ids, límites de caracteres, llaves) y se toman, como
 * mucho, dos frases cortas dirigidas a la persona. Pura.
 */

/** Frases que son borrador del modelo, no una explicación para quien aprueba. */
const SCRATCH =
  /l[ií]mite de \d+|supera el l[ií]mite|caracteres|\bids?\b|uuid|slug|snake_case|camelcase|toolcall|\bkey\b|llaves?\b|esquema|schema|\bzod\b|[a-z]+_[a-z_]+|`|corrijo los nombres|\bjson\b|payload/i;

const MAX_SENTENCES = 2;
const MAX_CHARS = 240;

export function proposalReason(
  source: string | readonly string[] | null | undefined,
): string | undefined {
  const chunks = (Array.isArray(source) ? source : [source ?? '']) as string[];
  const raw = chunks
    .map((c) => c.trim())
    .filter(Boolean)
    .join('\n');
  if (!raw) return undefined;
  const text = raw
    // Frases pegadas por el SDK: «…completo.Corrijo» → «…completo. Corrijo».
    .replace(/([a-záéíóúñ0-9)»"'])([.!?:])(?=[A-ZÁÉÍÓÚÑ¿¡])/g, '$1$2 ')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/([.!?:])\.\s/g, '$1 ');
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) =>
      s
        .replace(/[*_#>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((s) => s.length > 0);
  const good = sentences.filter((s) => !SCRATCH.test(s));
  const picked: string[] = [];
  let total = 0;
  for (const s of good) {
    if (picked.length >= MAX_SENTENCES) break;
    if (picked.length > 0 && total + s.length > MAX_CHARS) break;
    picked.push(s);
    total += s.length + 1;
  }
  if (picked.length === 0) return undefined;
  const joined = picked.join(' ');
  return joined.length > MAX_CHARS ? `${joined.slice(0, MAX_CHARS - 1).trimEnd()}…` : joined;
}
