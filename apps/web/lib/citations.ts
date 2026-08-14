import type { BrainSource } from './brain-sources-shape';

/**
 * LA CITA EN LÍNEA — Y LA NUMERACIÓN QUE SE ESTABA MANDANDO AL VACÍO.
 *
 * ===========================================================================
 * EL HALLAZGO
 * ===========================================================================
 * `/api/chat` lleva desde siempre numerando los fragmentos que pega encima de
 * la pregunta: `[^1] Contrato … : «texto»`, `[^2] …`. Nada en el prompt le
 * pedía al modelo que los usara, y nada en la interfaz los dibujaba. Los
 * números se enviaban, se pagaban en tokens y no servían para nada — y cuando
 * el modelo los copiaba por su cuenta, salían en pantalla como `[^1]` en crudo,
 * que es lo que hace `remark-gfm` con una referencia a pie de página cuya
 * definición no existe.
 *
 * Aquí se cierran las dos mitades: la ruta pide que se usen (ver `CITATION_RULE`
 * abajo, que viaja DENTRO del bloque `<context>`, junto a los números que
 * describe, para que no se pueda quedar huérfana de ellos) y esto los convierte
 * en una pastilla que nombra el documento.
 *
 * ===========================================================================
 * LA CITA EN LÍNEA Y LA LISTA DE ABAJO NO SON LO MISMO
 * ===========================================================================
 * `BrainSources` dice qué se leyó EN TOTAL para contestar; la marca dice de
 * dónde sale ESA frase. Una respuesta que cruza tres documentos tiene tres
 * fuentes abajo y quince marcas repartidas, y la pregunta que contesta cada una
 * es distinta: «¿esto se lo inventó?» la de abajo, «¿de cuál de los tres salió
 * esta cifra?» la de en medio. Conviven y no se estorban.
 *
 * ===========================================================================
 * UNA MARCA QUE NO RESUELVE NO SE INVENTA UN DOCUMENTO
 * ===========================================================================
 * Tres casos, y los tres pasan de verdad: el modelo escribe un número que no
 * estaba arriba; el fragmento existía pero no llegó a ser fuente (sin título, o
 * pasado el tope de ocho); o la respuesta se está escribiendo AHORA MISMO y la
 * procedencia todavía no ha llegado a esta pestaña — se lee 600 ms después de
 * terminar el turno, ver el efecto de `/api/chat/turn-metrics` en MessageList.
 *
 * En los tres se dibuja el número apagado, sin panel y sin promesa. Nunca se
 * empareja por posición: ver el comentario de `citations` en
 * `brain-sources-shape.ts`, que es donde está el argumento de por qué la
 * posición miente en cuanto dos fragmentos comparten documento.
 */

/**
 * LO QUE SE LE PIDE AL MODELO, Y DÓNDE VIVE.
 *
 * Va dentro del bloque `<context>` y no en el prompt del agente, por tres
 * razones que apuntan al mismo sitio:
 *
 *   ESTÁ PEGADA A LO QUE DESCRIBE. La regla habla de unos números que se
 *   escriben doce líneas más arriba, en el mismo string. Separarlas es cómo se
 *   llegó a la situación de partida: una numeración sin nadie que la pidiera.
 *
 *   SÓLO APARECE CUANDO HAY ALGO QUE CITAR. En un turno sin fragmentos no se
 *   manda, así que no invita a inventar una marca donde no había ninguna.
 *
 *   NO TOCA EL PROMPT DEL AGENTE. Ése vive en la base de datos (`loadAgent` lo
 *   lee de ahí; el archivo de `packages/agents` sólo alimenta la lista y el
 *   saludo), así que cambiarlo de verdad pide una migración — y reescribir una
 *   descripción ya huerfanó una medición en este repositorio una vez.
 */
export const CITATION_RULE = [
  'Cada fragmento de arriba va numerado. Cuando una frase tuya salga de uno, ciérrala con su',
  'marca pegada al punto: «…vence el 30 de septiembre[^2].» Sólo la marca — no escribas además el',
  'título del documento ni «según el contrato», porque la marca ya lo dice: en pantalla se dibuja',
  'como una pastilla que al pasarle por encima nombra el documento y su antigüedad.',
  'Una frase que no salga de ningún fragmento no lleva marca, y NUNCA uses un número que no esté',
  'arriba. Si una frase junta dos fragmentos, ponle las dos marcas.',
].join('\n');

/**
 * `[^12]` como mucho: dos dígitos.
 *
 * No es tacañería, es el límite que impide comerse cosas que no son citas. Un
 * texto legítimo puede contener `[^0-9]` (una expresión regular dentro de un
 * párrafo, sin bloque de código), y con más dígitos empezarían a emparejar
 * cadenas cada vez más largas por un número que jamás va a existir: los
 * fragmentos que se pegan son tres por defecto y ocho en el peor caso.
 */
const CITATION_RE = /\[\^(\d{1,2})\]/g;

export type CitationPiece = string | { cite: number };

/**
 * El texto partido en trozos y marcas, en orden.
 *
 * Función pura y exportada para poder probarla con cadenas: el resto de este
 * archivo camina un árbol, y un árbol es mucho peor sitio donde descubrir que
 * el patrón se comía el punto de al lado.
 */
export function splitCitations(value: string): CitationPiece[] {
  const pieces: CitationPiece[] = [];
  let at = 0;
  // `matchAll` sobre una expresión global no arrastra `lastIndex` entre
  // llamadas, que es la manera clásica de que la segunda invocación empiece a
  // mitad del texto.
  for (const match of value.matchAll(CITATION_RE)) {
    const start = match.index ?? 0;
    if (start > at) pieces.push(value.slice(at, start));
    pieces.push({ cite: Number(match[1]) });
    at = start + match[0].length;
  }
  if (at < value.length) pieces.push(value.slice(at));
  return pieces;
}

/** Lo poco de hast que hace falta aquí. No se importa `unist-util-visit`: el
 *  recorrido son diez líneas y una dependencia fantasma no se paga por eso. */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
  properties?: Record<string, unknown>;
}

/** Dentro de esto, un `[^1]` es texto y no una cita. */
const VERBATIM = new Set(['code', 'pre', 'kbd', 'samp']);

/**
 * Convierte cada `[^N]` del texto en un `<sup data-cite="N">`.
 *
 * `sup` Y NO UNA ETIQUETA INVENTADA. `react-markdown` mapea componentes por
 * nombre de etiqueta HTML y su tipo `Components` sólo admite las que existen, así
 * que un `<cita-marca>` no compilaría. Markdown no produce `sup` por ningún
 * camino —ni GFM lo tiene— así que la etiqueta está libre, y el componente
 * comprueba el atributo igualmente antes de dibujar nada.
 */
export function rehypeCitations() {
  return (tree: HastNode): void => {
    walk(tree, false);
  };
}

function walk(node: HastNode, verbatim: boolean): void {
  const children = node.children;
  if (!children || children.length === 0) return;

  const next: HastNode[] = [];
  let changed = false;

  for (const child of children) {
    if (child.type === 'element') {
      walk(child, verbatim || VERBATIM.has(child.tagName ?? ''));
      next.push(child);
      continue;
    }
    if (child.type !== 'text' || verbatim || typeof child.value !== 'string') {
      next.push(child);
      continue;
    }
    const pieces = splitCitations(child.value);
    if (pieces.length === 1 && typeof pieces[0] === 'string') {
      next.push(child);
      continue;
    }
    changed = true;
    for (const piece of pieces) {
      if (typeof piece === 'string') {
        next.push({ type: 'text', value: piece });
        continue;
      }
      next.push({
        type: 'element',
        tagName: 'sup',
        properties: { dataCite: String(piece.cite) },
        children: [{ type: 'text', value: String(piece.cite) }],
      });
    }
  }

  if (changed) node.children = next;
}

/**
 * El documento al que apunta una marca, o null.
 *
 * POR NÚMERO GUARDADO, NUNCA POR POSICIÓN. Es la línea que decide si esta
 * función sirve o miente; el porqué está entero en `citations`, en
 * `brain-sources-shape.ts`.
 */
export function citationSource(
  sources: readonly BrainSource[] | undefined,
  cite: number,
): BrainSource | null {
  if (!sources) return null;
  return sources.find((s) => s.citations?.includes(cite)) ?? null;
}

/** Lo que dice el panel al pasar por encima, y lo que oye un lector de pantalla. */
export function citationLabel(source: BrainSource): string {
  const parts = [source.title];
  if (source.age) parts.push(source.age);
  if (source.spokenAt) parts.push(`min ${source.spokenAt}`);
  if (source.relevance === 'weak') parts.push('coincidencia floja');
  return parts.join(' · ');
}
