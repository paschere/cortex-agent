/**
 * QUÉ LEYÓ CORTEX DEL CEREBRO PARA CONTESTAR ESTO.
 *
 * ===========================================================================
 * EL AGUJERO QUE TAPA
 * ===========================================================================
 * Cortex usa Brain Knowledge por DOS caminos, y sólo uno se veía:
 *
 *   EXPLÍCITO   el modelo llama a `kb.search` o `kb.context` a mitad del turno.
 *               Eso sale como un paso en la lista, con su nombre y su tiempo.
 *
 *   AUTOMÁTICO  antes de que el modelo vea la pregunta, la ruta del chat busca
 *               en el cerebro y pega los fragmentos encima. NO ES UNA LLAMADA A
 *               UNA HERRAMIENTA, así que no dejaba ni un píxel en pantalla.
 *
 * El segundo es el camino normal — el que se usa en casi todas las respuestas —
 * y era invisible. La respuesta citaba un contrato y nada decía que lo hubiera
 * leído: se leía igual que si se lo hubiera inventado. En un producto cuya
 * firma es la procedencia («un valor sin procedencia no lleva chip», dice
 * `docs/design-system.md`), ese era el hueco más grande que quedaba.
 *
 * Y había una pista de que alguien ya lo había intentado: existía un
 * `CitationFootnote.tsx` con CERO importaciones. La interfaz estaba escrita y
 * nunca se pudo conectar, porque el dato no se guardaba en ninguna parte.
 *
 * ===========================================================================
 * LO QUE SE GUARDA, Y SOBRE TODO LO QUE NO
 * ===========================================================================
 * El título, la edad y si la coincidencia fue floja. **NUNCA EL CONTENIDO DEL
 * FRAGMENTO.** El texto ya está en `kb_chunks`, y copiarlo aquí crearía una
 * segunda copia del documento —dentro de `messages`, que se lee entero en cada
 * apertura de conversación y que nadie va a acordarse de borrar cuando alguien
 * elimine el documento original. Un documento borrado del cerebro tiene que
 * desaparecer del cerebro.
 *
 * Este archivo es una función pura, sin `server-only` y sin importar nada de
 * `@cortex/agent-tools`, por el mismo motivo que `lib/waiting-shape.ts` y
 * `lib/reports-shape.ts`: así se puede probar en Node y lo puede leer tanto el
 * servidor que lo escribe como el cliente que lo dibuja.
 */

/** Cuántas fuentes distintas se guardan como mucho. Ver `MAX_SOURCES`. */
export const MAX_BRAIN_SOURCES = 8;

export interface BrainSource {
  documentId: string;
  title: string;
  /** «de ayer», «del 3 de marzo de 2026». Vacío cuando el documento no tiene fecha. */
  age?: string;
  /**
   * `weak` significa que el fragmento salió por poco.
   *
   * Se guarda y se enseña porque cambia lo que vale la cita: un dato traído por
   * una coincidencia floja es un dato que hay que mirar antes de repetirlo, y
   * esconder esa distinción convierte las dos cosas en la misma.
   */
  relevance: 'strong' | 'weak';
  /** «12:34» cuando el fragmento viene de una grabación, y no un número de trozo. */
  spokenAt?: string;
}

/** Lo que devuelve `kb.search`, en lo poco que a esto le hace falta. */
interface Hit {
  documentId?: unknown;
  documentTitle?: unknown;
  age?: unknown;
  relevance?: unknown;
  spokenAt?: unknown;
}

/**
 * Los documentos detrás de unos fragmentos, SIN REPETIR.
 *
 * Cinco fragmentos pueden ser cinco trozos del mismo contrato, y decir «leí 5
 * documentos» cuando era uno es exactamente la clase de cifra inflada que este
 * producto existe para dejar de producir. Se agrupa por documento y se queda el
 * primero, que es el mejor puntuado porque `kb.search` devuelve ordenado.
 *
 * `relevance` es la EXCEPCIÓN a «se queda el primero»: si cualquier fragmento
 * de ese documento fue una coincidencia fuerte, el documento lo fue. Marcar de
 * flojo un documento que sí tenía un párrafo bueno subestimaría la respuesta.
 */
export function collectBrainSources(hits: readonly Hit[]): BrainSource[] {
  const byDocument = new Map<string, BrainSource>();

  for (const hit of hits) {
    const documentId = typeof hit.documentId === 'string' ? hit.documentId : null;
    const title = typeof hit.documentTitle === 'string' ? hit.documentTitle.trim() : '';
    // Sin id no se puede agrupar y sin título no se puede nombrar. Una fuente
    // que no se puede nombrar no es una fuente: es una fila que dice «algo».
    if (!documentId || !title) continue;

    const strong = hit.relevance !== 'weak';
    const existing = byDocument.get(documentId);
    if (existing) {
      if (strong) existing.relevance = 'strong';
      continue;
    }
    if (byDocument.size >= MAX_BRAIN_SOURCES) continue;

    byDocument.set(documentId, {
      documentId,
      title,
      relevance: strong ? 'strong' : 'weak',
      ...(typeof hit.age === 'string' && hit.age ? { age: hit.age } : {}),
      ...(typeof hit.spokenAt === 'string' && hit.spokenAt ? { spokenAt: hit.spokenAt } : {}),
    });
  }

  return [...byDocument.values()];
}

/**
 * Lo mismo, leído de la base de datos.
 *
 * Defensivo a propósito: `brain_sources` es `jsonb` y lo que hay ahí lo escribió
 * una versión anterior de este código. Una fila rara no puede tumbar la lectura
 * de una conversación entera — se descarta la fuente y se dibujan las demás.
 */
export function parseBrainSources(value: unknown): BrainSource[] {
  if (!Array.isArray(value)) return [];
  return collectBrainSources(
    value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null),
  );
}

/**
 * Cómo se anuncia en una línea, junto a los botones de la respuesta.
 *
 * Con una fuente se dice su nombre, porque el nombre es más útil que el conteo
 * y cabe. Con varias se cuenta, porque tres títulos en una fila de botones es
 * una fila de botones ilegible — y los nombres siguen a un clic.
 */
export function brainSourceLabel(sources: readonly BrainSource[]): string | null {
  if (sources.length === 0) return null;
  const first = sources[0];
  if (sources.length === 1 && first) {
    return first.title.length <= 42 ? first.title : `${first.title.slice(0, 40).trimEnd()}…`;
  }
  return `${sources.length} documentos`;
}
