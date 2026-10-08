import type { CoreMessage } from 'ai';
import { withoutNotes } from './turn-transcript';

/**
 * EL HILO QUE SE LE MANDA AL MODELO, ARMADO DE DOS SITIOS.
 *
 * ===========================================================================
 * EL FALLO QUE ESTO ARREGLA, TAL CUAL SE VEÍA
 * ===========================================================================
 * En producción, al escribir:
 *
 *     «This model does not support assistant message prefill.
 *      The conversation must end with a user message.»
 *
 * El turno no salía. Y el camino era éste:
 *
 *   1. La vigilancia de pantalla mete un mensaje de Cortex en la conversación
 *      («veo un error en la pantalla que compartes…»). Ese mensaje NO SE GUARDA
 *      EN LA BASE a propósito — lo dice `ChatRoot` y lo cumple `/api/chat/watch`.
 *   2. Escribes una pregunta. La ruta la inserta en `messages` antes de nada.
 *   3. Al armar el hilo se ponía PRIMERO todo el historial de la base y DESPUÉS
 *      lo que sólo tenía el navegador. Como tu pregunta ya estaba en la base,
 *      se quedaba dentro del primer grupo… y el aviso, que nunca estuvo, caía
 *      al final.
 *   4. El hilo terminaba en un mensaje del asistente. Y eso, la API lo rechaza.
 *
 * Lo mismo pasaba con cualquier mensaje del navegador que la base no tuviera
 * palabra por palabra: la comparación es por `rol::contenido` exacto, así que un
 * carácter de diferencia entre lo que se escribió y lo que se guardó bastaba
 * para que la respuesta del asistente se colara al final del hilo.
 *
 * ===========================================================================
 * LA CORRECCIÓN: EL ORDEN BUENO LO TIENE EL NAVEGADOR
 * ===========================================================================
 * La lista del navegador es la conversación tal como ocurrió, con el mensaje
 * nuevo de último — así funciona `useChat`. La base aporta lo que ya no cabe en
 * esa lista: el historial viejo. Así que el navegador es la columna vertebral y
 * la base va delante, en vez de al revés.
 *
 * ===========================================================================
 * Y UNA GARANTÍA AL FINAL, PORQUE «POCO PROBABLE» NO ES «IMPOSIBLE»
 * ===========================================================================
 * Después de ordenar bien se recorta cualquier mensaje del asistente que quede
 * colgando al final. No es cinturón y tirantes: es que el coste de equivocarse
 * aquí es un turno que muere con un error de la API que no le dice nada a nadie,
 * y el coste de la guardia son tres líneas. Un hilo que no termina en una
 * pregunta no es un hilo al que se le pueda pedir una respuesta.
 */

type Row = { role: string; content: string };

/**
 * La clave con la que se reconoce el mismo mensaje en los dos lados: rol y
 * texto SIN espacios sobrantes y sin la nota de interrupción (la base la lleva,
 * el navegador puede no haberla recibido). Un carácter de espacio de
 * diferencia ya no vuelve «distinto» un mensaje.
 */
function keyOf(row: Row, role: string): string {
  return `${role}::${withoutNotes(row.content ?? '')}`;
}

export function buildTurnMessages(
  /** Lo que tiene el navegador, en el orden en que pasó. El último es la pregunta nueva. */
  clientMessages: readonly Row[],
  /**
   * Las últimas filas de `messages`, tal como salen de la consulta: de la más
   * nueva a la más vieja. Se les da la vuelta aquí para que quien llama no tenga
   * que acordarse — que es exactamente la clase de detalle que se olvida.
   */
  historyNewestFirst: readonly Row[] | null,
): CoreMessage[] {
  const asCore = (m: Row): CoreMessage =>
    ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content }) as CoreMessage;

  const client = clientMessages.map(asCore);

  let merged: CoreMessage[];
  if (!historyNewestFirst || historyNewestFirst.length === 0) {
    merged = client;
  } else {
    // FUSIÓN ANCLADA. Se recorre la base de la más vieja a la más nueva; cada
    // fila que el navegador también tiene es un ANCLA y arrastra consigo lo
    // del navegador que iba hasta ahí (un aviso de pantalla, por ejemplo). Una
    // fila que el navegador no tiene —el historial viejo, o la respuesta de un
    // turno cortado que nunca llegó entera a la pantalla— entra EN SU SITIO,
    // después del último ancla, y no amontonada al principio: antes una
    // respuesta interrumpida quedaba por delante de su propia pregunta.
    const keys = client.map((m, i) => keyOf(clientMessages[i] as Row, m.role));
    merged = [];
    let next = 0;
    for (const row of [...historyNewestFirst].reverse()) {
      const key = keyOf(row, row.role);
      let found = -1;
      for (let j = next; j < keys.length; j++) {
        if (keys[j] === key) {
          found = j;
          break;
        }
      }
      if (found >= 0) {
        merged.push(...client.slice(next, found + 1));
        next = found + 1;
      } else {
        merged.push(asCore(row));
      }
    }
    merged.push(...client.slice(next));
  }

  return dropTrailingNonUser(merged);
}

/**
 * Quita lo que cuelgue después de la última pregunta.
 *
 * Devuelve la lista tal cual cuando ya termina en `user`, que es siempre. Si no
 * quedara ninguna pregunta, devuelve la lista entera sin tocar: vaciarla
 * cambiaría un error legible de la API por una petición sin contenido, y de las
 * dos maneras de fallar la que dice algo es mejor.
 */
export function dropTrailingNonUser(messages: readonly CoreMessage[]): CoreMessage[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1]?.role !== 'user') end--;
  return end === 0 ? [...messages] : messages.slice(0, end);
}
