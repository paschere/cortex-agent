/**
 * LO QUE EL MODELO LEE DE UN RESULTADO DE HERRAMIENTA, CON TOPE.
 *
 * Un resultado enorme —`trackers.list` con todas las tablas, cientos de filas de
 * Siigo, una hoja entera— volvía al modelo completo en el mismo turno. Con
 * varias herramientas encadenadas el contexto se llenaba de datos que no
 * necesitaba, cada paso tardaba más (y costaba más), y el modelo terminaba el
 * turno con un anuncio en vez de seguir actuando.
 *
 * Esto recorta SÓLO lo que lee el modelo (`experimental_toToolResultContent`):
 * la tarjeta de la pantalla y lo que se guarda reciben el resultado entero.
 * El recorte respeta la forma del JSON: listas a sus primeros elementos con un
 * «+N más», textos largos a su principio. Así el modelo sabe que hay más y
 * puede pedirlo con filtros, en vez de leer un JSON cortado a la mitad.
 */

export const MODEL_RESULT_CAP = 24_000;

const SHRINK_STEPS: ReadonlyArray<{ items: number; chars: number }> = [
  { items: 60, chars: 4_000 },
  { items: 25, chars: 2_000 },
  { items: 10, chars: 1_000 },
  { items: 5, chars: 500 },
  { items: 2, chars: 200 },
];

function shrink(value: unknown, items: number, chars: number, depth = 0): unknown {
  if (typeof value === 'string')
    return value.length > chars
      ? `${value.slice(0, chars)}… (+${value.length - chars} caracteres)`
      : value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, items).map((v) => shrink(v, items, chars, depth + 1));
    return value.length > items
      ? [...kept, `… (+${value.length - items} más; pide con filtros o por páginas)`]
      : kept;
  }
  if (value && typeof value === 'object') {
    if (depth > 8) return '[…]';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = shrink(v, items, chars, depth + 1);
    return out;
  }
  return value;
}

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '"[resultado no serializable]"';
  }
}

/** El texto que el modelo lee de un resultado: entero si cabe, recortado con forma si no. */
export function capResultForModel(result: unknown, cap = MODEL_RESULT_CAP): string {
  const full = serialize(result);
  if (full.length <= cap) return full;
  for (const step of SHRINK_STEPS) {
    const text = serialize(shrink(result, step.items, step.chars));
    if (text.length <= cap) {
      return `${text}\n[Resultado recortado para ti: medía ${full.length} caracteres. La persona ve el resultado completo.]`;
    }
  }
  return `${full.slice(0, cap)}…\n[Resultado recortado para ti: medía ${full.length} caracteres. La persona ve el resultado completo.]`;
}

/** Para `tool({ experimental_toToolResultContent })`. */
export function modelToolContent(result: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: capResultForModel(result) }];
}
