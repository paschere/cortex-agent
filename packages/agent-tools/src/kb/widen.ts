import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * DEVOLVER LA FRASE ENTERA.
 *
 * ===========================================================================
 * EL PROBLEMA
 * ===========================================================================
 * Un documento se corta en trozos de ~400 tokens por una razón de recuperación
 * —un trozo grande difumina su propio embedding— y esos cortes caen donde caen.
 * Cuando el corte parte una cláusula, el fragmento que se le entrega al modelo
 * dice «…el plazo de pago será de» y el número está en el trozo siguiente.
 *
 * El modelo hace entonces una de dos cosas, y las dos son malas: contesta que
 * no encontró el plazo (teniéndolo el cerebro), o lo completa. La segunda es la
 * que da miedo, porque suena bien.
 *
 * ===========================================================================
 * LA SOLUCIÓN, Y SUS LÍMITES
 * ===========================================================================
 * Al fragmento que se va a entregar se le pegan los BORDES de sus vecinos: el
 * final del anterior y el principio del siguiente. No el vecino entero — eso
 * triplicaría el contexto que se gasta por cita, y el trozo entero de al lado
 * casi nunca hace falta: lo que falta es el resto de la frase.
 *
 * TRES REGLAS QUE LO MANTIENEN HONESTO:
 *
 *   1. NO CAMBIA QUÉ SE RECUPERA NI CÓMO SE PUNTÚA. Esto corre DESPUÉS del
 *      corte y después del suelo de relevancia. Un fragmento no se cuela por
 *      tener un vecino bueno, y el coseno que se muestra sigue siendo el del
 *      fragmento y no el del pegote.
 *   2. LAS GRABACIONES NO SE TOCAN. Un trozo de transcripción lleva quién habló
 *      y en qué minuto; pegarle el final del turno anterior mete en la misma
 *      cita palabras de otra persona. Una cita mal atribuida es peor que una
 *      cita corta.
 *   3. SE VE QUE ESTÁ RECORTADO. Los bordes van entre «…», que es lo que
 *      permite al modelo decir «el pasaje continúa» en vez de leerlo como si el
 *      documento empezara ahí.
 */

/** Cuánto se pega de cada lado. Una frase larga cabe; un párrafo, no. */
const EDGE_CHARS = 280;

export interface WidenTarget {
  documentId: string;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown>;
}

/** Un trozo de grabación se reconoce por llevar quién lo dijo. */
function isSpoken(metadata: Record<string, unknown>): boolean {
  return metadata?.speaker !== undefined || metadata?.startMs !== undefined;
}

/** El final de un texto, cortado en un espacio para no partir una palabra. */
function tailOf(text: string): string {
  if (text.length <= EDGE_CHARS) return text.trim();
  const cut = text.slice(text.length - EDGE_CHARS);
  const space = cut.indexOf(' ');
  return (space === -1 ? cut : cut.slice(space + 1)).trim();
}

/** Y el principio, con el mismo cuidado por el otro lado. */
function headOf(text: string): string {
  if (text.length <= EDGE_CHARS) return text.trim();
  const cut = text.slice(0, EDGE_CHARS);
  const space = cut.lastIndexOf(' ');
  return (space === -1 ? cut : cut.slice(0, space)).trim();
}

/**
 * Quitarle al borde del vecino el trozo que ya está en el fragmento.
 *
 * `side: 'end'` es el vecino ANTERIOR: su final solapa con el principio del
 * fragmento. `side: 'start'` es el SIGUIENTE: su principio solapa con el final.
 * Se busca el solapamiento más largo, no uno cualquiera, porque cortar de menos
 * deja la frase repetida a medias, que se lee peor que repetida entera.
 */
function withoutOverlap(edge: string, content: string, side: 'end' | 'start'): string {
  const limit = Math.min(edge.length, content.length);
  for (let k = limit; k > 20; k -= 1) {
    if (side === 'end') {
      if (edge.slice(edge.length - k) === content.slice(0, k)) {
        return edge.slice(0, edge.length - k).trim();
      }
    } else if (edge.slice(0, k) === content.slice(content.length - k)) {
      return edge.slice(k).trim();
    }
  }
  return edge.trim();
}

/**
 * Ensanchar los fragmentos con los bordes de sus vecinos.
 *
 * Devuelve un mapa `documentId#chunkIndex -> texto ensanchado`, y sólo para los
 * que cambiaron. Nunca lanza: si la consulta falla, el llamador se queda con los
 * fragmentos tal cual, que es exactamente lo que tenía antes de que esto
 * existiera.
 */
export async function widenExcerpts(
  db: SupabaseClient,
  targets: WidenTarget[],
): Promise<Map<string, string>> {
  const widened = new Map<string, string>();
  const prose = targets.filter((t) => !isSpoken(t.metadata));
  if (prose.length === 0) return widened;

  const documentIds = [...new Set(prose.map((t) => t.documentId))];
  const wanted = new Set<number>();
  for (const t of prose) {
    if (t.chunkIndex > 0) wanted.add(t.chunkIndex - 1);
    wanted.add(t.chunkIndex + 1);
  }

  // Un `in` por documento y otro por índice, en vez de un `or` con una cláusula
  // por fragmento. Trae de más —el índice 3 del documento A aunque sólo lo
  // pidiera el B— y a cambio es una consulta legible y acotada: cinco
  // fragmentos son como mucho cinco documentos y diez índices. El `in` sobre
  // `document_id` es además lo que satisface la guarda de tablas derivadas
  // (`kb_chunks` cuelga de `kb_documents`), que un `or` no puede satisfacer.
  let rows: Array<{ document_id: string; chunk_index: number; content: string }> = [];
  try {
    const { data, error } = await db
      .from('kb_chunks')
      .select('document_id, chunk_index, content')
      .in('document_id', documentIds)
      .in('chunk_index', [...wanted]);
    if (error) return widened;
    rows = (data ?? []) as typeof rows;
  } catch {
    return widened;
  }

  const byKey = new Map<string, string>();
  for (const r of rows) byKey.set(`${r.document_id}#${r.chunk_index}`, r.content);

  for (const t of prose) {
    const before = byKey.get(`${t.documentId}#${t.chunkIndex - 1}`);
    const after = byKey.get(`${t.documentId}#${t.chunkIndex + 1}`);
    const parts: string[] = [];

    // El troceador solapa 50 tokens entre trozos contiguos (ver chunker.ts), así
    // que el final del vecino anterior YA está al principio de este fragmento.
    // Se le quita esa parte antes de pegarlo: repetir el solapamiento gasta
    // contexto en algo que el modelo está leyendo dos veces, y un pasaje con una
    // frase duplicada se lee como si el documento la dijera dos veces.
    const tail = before ? withoutOverlap(tailOf(before), t.content, 'end') : '';
    if (tail) parts.push(`…${tail}`);

    parts.push(t.content);

    const head = after ? withoutOverlap(headOf(after), t.content, 'start') : '';
    if (head) parts.push(`${head}…`);

    if (parts.length > 1) {
      widened.set(`${t.documentId}#${t.chunkIndex}`, parts.join('\n'));
    }
  }

  return widened;
}
