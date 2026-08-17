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
  /**
   * QUÉ MARCAS DE LA RESPUESTA APUNTAN A ESTE DOCUMENTO.
   *
   * =========================================================================
   * POR QUÉ NO BASTA CON LA POSICIÓN, QUE ERA LA SUPOSICIÓN OBVIA
   * =========================================================================
   * `/api/chat` numera los fragmentos que pega encima de la pregunta — `[^1]`,
   * `[^2]`, … — en el orden de `ragOut.hits`, y esta lista sale de los MISMOS
   * hits. Parece que `[^2]` sea la segunda fuente de la lista. **No lo es, y el
   * caso en que falla es el normal.**
   *
   * `collectBrainSources` AGRUPA POR DOCUMENTO, porque cinco fragmentos suelen
   * ser cinco trozos del mismo contrato y decir «leí 5 documentos» cuando era
   * uno es la cifra inflada que este producto existe para dejar de producir. En
   * cuanto dos fragmentos comparten documento, los números y las posiciones
   * dejan de coincidir: con hits [A, A, B], `[^3]` es B y la segunda fuente de
   * la lista también es B — pero `[^2]` es A y la lista no tiene segunda A.
   *
   * Así que el número se guarda, no se deduce. Un documento puede llevar
   * varios: con hits [A, A, B], A trae [1, 2] y B trae [3].
   *
   * Un fragmento que no llegó a ser fuente —sin id, sin título, o pasado el
   * tope de ocho— no aporta su número a nadie, y su marca en la respuesta se
   * dibuja como un número apagado sin nada detrás. Eso es correcto: no había
   * documento que nombrar.
   *
   * Ausente en las filas escritas antes de que esto existiera. Se dibujan como
   * se dibujaban: la marca queda en texto plano y la lista de abajo, entera.
   */
  citations?: number[];
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

  // El número de la marca es la POSICIÓN EN `hits`, y tiene que ser la misma
  // aritmética que la de `/api/chat` (`[^${i + 1}]`). Por eso se cuenta sobre el
  // índice del bucle y no sobre las fuentes aceptadas: un fragmento descartado
  // aquí abajo sigue llevándose su número en el bloque que vio el modelo, y
  // renumerar haría que todas las marcas siguientes apuntaran una fuente
  // desplazada — que es exactamente el fallo que esto existe para no tener.
  for (const [index, hit] of hits.entries()) {
    const cite = index + 1;
    const documentId = typeof hit.documentId === 'string' ? hit.documentId : null;
    const title = typeof hit.documentTitle === 'string' ? hit.documentTitle.trim() : '';
    // Sin id no se puede agrupar y sin título no se puede nombrar. Una fuente
    // que no se puede nombrar no es una fuente: es una fila que dice «algo».
    if (!documentId || !title) continue;

    const strong = hit.relevance !== 'weak';
    const existing = byDocument.get(documentId);
    if (existing) {
      if (strong) existing.relevance = 'strong';
      existing.citations?.push(cite);
      continue;
    }
    if (byDocument.size >= MAX_BRAIN_SOURCES) continue;

    byDocument.set(documentId, {
      documentId,
      title,
      relevance: strong ? 'strong' : 'weak',
      citations: [cite],
      ...(typeof hit.age === 'string' && hit.age ? { age: hit.age } : {}),
      ...(typeof hit.spokenAt === 'string' && hit.spokenAt ? { spokenAt: hit.spokenAt } : {}),
    });
  }

  return [...byDocument.values()];
}

/** Números de marca creíbles: enteros positivos, sin repetir y como mucho ocho. */
function readCitations(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const clean = [
    ...new Set(
      value.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0),
    ),
  ].slice(0, 16);
  return clean.length > 0 ? clean : null;
}

/**
 * Lo mismo, leído de la base de datos.
 *
 * =========================================================================
 * NO PUEDE DELEGAR EN `collectBrainSources`, Y ASÍ ESTABA
 * =========================================================================
 * Lo hacía, y por eso NO DEVOLVÍA NUNCA NADA. Las dos funciones leen formas
 * distintas: un `hit` de `kb.search` trae `documentTitle` y una fila guardada
 * trae `title`. Al pasarle filas guardadas, `collectBrainSources` no encontraba
 * título en ninguna, las descartaba todas por su propia regla («una fuente que
 * no se puede nombrar no es una fuente») y devolvía `[]`. El efecto en pantalla
 * era exactamente el de no tener procedencia: cada conversación reabierta salía
 * sin una sola fuente, y como la ausencia de fuentes NO DIBUJA NADA a propósito,
 * no había nada roto que mirar. Sólo se veía en el turno vivo, que llega por
 * `/api/chat/turn-metrics` y no pasa por aquí.
 *
 * Ahora lee su propia forma. Sigue siendo defensiva por el mismo motivo de
 * siempre: `brain_sources` es `jsonb` y lo escribió una versión anterior de este
 * código, así que una fila rara se descarta y las demás se dibujan.
 *
 * =========================================================================
 * Y LOS NÚMEROS NO SE VUELVEN A DEDUCIR
 * =========================================================================
 * Lo que hay en la base ya viene agrupado por documento, así que su posición ya
 * no es la del fragmento que lo produjo. Recalcular daría 1, 2, 3 sobre unas
 * marcas que de verdad eran 1, 4, 5 — una cita apuntando al documento
 * equivocado, que es peor que ninguna cita. Una fila sin `citations` (escrita
 * antes de que existieran) se queda sin ellos y sus marcas salen apagadas.
 */
export function parseBrainSources(value: unknown): BrainSource[] {
  if (!Array.isArray(value)) return [];

  const byDocument = new Map<string, BrainSource>();
  for (const row of value) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const documentId = typeof r.documentId === 'string' ? r.documentId : null;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!documentId || !title) continue;

    const strong = r.relevance !== 'weak';
    const cites = readCitations(r.citations);
    const existing = byDocument.get(documentId);
    if (existing) {
      // Misma regla que al escribir: si cualquier fila de ese documento fue una
      // coincidencia fuerte, el documento lo fue.
      if (strong) existing.relevance = 'strong';
      if (cites)
        existing.citations = [...new Set([...(existing.citations ?? []), ...cites])].sort(
          (a, b) => a - b,
        );
      continue;
    }
    if (byDocument.size >= MAX_BRAIN_SOURCES) continue;

    byDocument.set(documentId, {
      documentId,
      title,
      relevance: strong ? 'strong' : 'weak',
      ...(cites ? { citations: cites } : {}),
      ...(typeof r.age === 'string' && r.age ? { age: r.age } : {}),
      ...(typeof r.spokenAt === 'string' && r.spokenAt ? { spokenAt: r.spokenAt } : {}),
    });
  }

  return [...byDocument.values()];
}

/**
 * Cómo se anuncia la fila colapsada de fuentes bajo la respuesta.
 *
 * SIEMPRE UN CONTEO, nunca un título. Decía el título cuando la fuente era
 * una, y el dueño leyó «Del cerebro · Contrato Coltrans…» sin entender qué
 * era esa fila: un título truncado no dice QUÉ es la fila, solo cuál. «N
 * fuentes» dice las dos cosas que la fila colapsada tiene que decir —qué es
 * esto y cuántas hay— y los títulos completos están a un clic, en la lista.
 */
export function brainSourceLabel(sources: readonly BrainSource[]): string | null {
  if (sources.length === 0) return null;
  return sources.length === 1 ? '1 fuente' : `${sources.length} fuentes`;
}
