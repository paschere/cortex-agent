/**
 * LO QUE ESA PERSONA PIDE MÁS, ENCIMA DEL COMPOSITOR.
 *
 * ===========================================================================
 * ESTO NO ES LA TERCERA COPIA DE LOS SEIS COMANDOS DE SIEMPRE
 * ===========================================================================
 * `InputBar.tsx` rechazó, con razón, una fila de botones de atajo: «serían una
 * tercera copia de los mismos seis comandos, compitiendo con los cuatro
 * controles de abajo por la mirada». Ese argumento sigue en pie y esta fila lo
 * cumple, porque no es una lista escrita a mano:
 *
 *   - la fila la ESCRIBE EL USO de quien está mirándola, no un diseñador. Al
 *     mes de trabajar, lo que hay ahí son las cinco preguntas que esa persona
 *     hace de verdad, que es información que ninguna de las otras dos copias
 *     tiene;
 *   - sólo entran frases que se pueden MANDAR ENTERAS (ver `isSendable`), así
 *     que un clic es un turno, no un compositor a medio llenar;
 *   - y sale de la misma respuesta de `/api/chat/commands` que ya alimenta el
 *     `/`, o sea del catálogo filtrado por `usableToolIds`: nada que este
 *     espacio de trabajo no pueda ejecutar llega a dibujarse.
 *
 * Sin uso todavía, se dibujan UNOS POCOS por defecto (`DEFAULT_SHORTCUTS`) y no
 * la lista entera. Un candidato que nadie ha pedido nunca no ocupa un hueco: se
 * lo tiene que ganar.
 *
 * ===========================================================================
 * POR QUÉ NO USA `nav-usage.ts`, QUE ES DE DONDE SALE ESTA FORMA
 * ===========================================================================
 * El criterio es el mismo y está argumentado allí: vive en `localStorage`
 * porque es una preferencia y no un hecho de la empresa; decae porque sin
 * olvido lo que alguien exploró la primera semana manda para siempre; y hay un
 * piso mínimo porque un clic accidental no puede reordenar nada.
 *
 * Lo que NO se puede compartir es el almacén, y no es un detalle de estilo:
 *
 *   1. `recordVisit` DECAE TODAS las entradas del objeto en cada escritura. Con
 *      un solo almacén, mandar cincuenta mensajes al día erosionaría el orden
 *      del rail, y navegar erosionaría los chips. Dos vocabularios repartiéndose
 *      un único presupuesto de olvido se diluyen el uno al otro, y el efecto
 *      sería peor cuanto más se usara el producto.
 *   2. Las llaves son de espacios distintos —el rail guarda `href`, esto guarda
 *      ids de herramienta, comandos y rutinas—, así que un objeto común crecería
 *      con las claves del otro y cada lectura pagaría por ellas.
 *
 * Así que la forma está copiada, con las mismas dos constantes y la misma
 * promesa de estabilidad, y la copia es lo que se prueba en el archivo de al
 * lado. `orderByUsage` tampoco se reutiliza tal cual porque su firma exige
 * `href`, y llamar `href` al id de una herramienta sería mentir en el tipo para
 * ahorrarse ocho líneas.
 */

import type { PaletteGroup, PaletteItem } from './chat-palette-shape';
import { fold } from './chat-palette-shape';

/** Cuántos chips caben antes de que la fila deje de leerse de un vistazo. */
export const SHORTCUT_SLOTS = 5;

const KEY = 'chat_usage_v1';

/**
 * Lo que vale una petición contra las anteriores. Igual que en el rail, y por
 * la misma razón: sin olvido, el orden se calcifica en lo que alguien probó el
 * primer día y la fila empeora con el tiempo.
 */
const DECAY = 0.98;

/**
 * Cuántas veces hay que pedir algo para que desplace a un chip por defecto.
 *
 * Los por defecto son el orden que alguien argumentó; moverlos por una sola
 * petición convertiría un clic curioso en la fila de mañana. Tres peticiones
 * recientes cruzan este piso, que es más o menos «lo pides, no lo probaste».
 */
export const MIN_SCORE = 2.5;

/**
 * Hasta dónde puede crecer la etiqueta de un chip.
 *
 * Un chip que hay que truncar para que quepa deja de leerse de un vistazo, que
 * es lo único que un chip hace mejor que el menú. Las frases largas siguen
 * enteras en el `/`, que tiene sitio para ellas.
 */
const MAX_LABEL = 46;

export interface Shortcut {
  /** Id de herramienta, de comando fijo o de rutina. La llave del almacén. */
  id: string;
  /** Lo que se lee en el chip. Corto por construcción — ver `MAX_LABEL`. */
  label: string;
  /** Lo que se MANDA al pulsarlo. Una frase entera, nunca un fragmento. */
  phrase: string;
}

/**
 * Los pocos por defecto, en orden de preferencia.
 *
 * No son «los mejores comandos»: son las preguntas que casi cualquier espacio
 * de trabajo puede contestar el primer día y que además dicen, sin explicarlo,
 * de qué va esto. Un id que este espacio no pueda ejecutar simplemente no llega
 * a la lista de candidatos y el siguiente ocupa su hueco.
 */
export const DEFAULT_SHORTCUTS = [
  'inbox.overview',
  '/vencimientos',
  'approvals.list',
  'payments.receivables',
  'gcal.upcoming_meetings',
  'commitments.due_soon',
  'errands.status',
  'schedule.list',
  'reports.list',
] as const;

/**
 * ¿Es una frase que se puede mandar tal cual?
 *
 * El vocabulario ya lo dice: en `TOOL_PHRASE` un espacio al final significa
 * «falta el complemento» —la placa, el cliente, el texto a buscar—. Un chip
 * MANDA de un clic, así que una frase incompleta sería una pregunta rota
 * enviada sin que nadie la lea. Ésas se quedan en el `/`, que escribe en el
 * compositor y deja el cursor puesto.
 */
export function isSendable(expands: string): boolean {
  return expands.length > 0 && expands === expands.trimEnd();
}

/**
 * Lo que se lee en el chip.
 *
 * Un comando fijo se dice por lo que HACE («Qué se vence y cuándo») y no por su
 * barra: la barra existe para teclearla, y en un chip no se teclea nada. Todo
 * lo demás ya viene dicho en español desde su fila del menú.
 */
export function shortcutLabel(item: PaletteItem): string {
  const raw = item.mono ? (item.hint ?? item.label) : item.label;
  return raw.trim();
}

/**
 * De las secciones del menú a los candidatos a chip, conservando el orden.
 *
 * Lo que entra ya está filtrado por lo que este espacio de trabajo puede
 * ejecutar de verdad: los grupos vienen de `/api/chat/commands`, que los arma
 * con `usableToolIds`. Aquí sólo se descarta lo que no cabe en un chip o lo que
 * no se puede mandar de un clic.
 */
export function shortcutCandidates(groups: PaletteGroup[]): Shortcut[] {
  const out: Shortcut[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const item of group.items) {
      if (!isSendable(item.expands)) continue;
      const label = shortcutLabel(item);
      if (!label || label.length > MAX_LABEL) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push({ id: item.id, label, phrase: item.expands });
    }
  }
  return out;
}

type Scores = Record<string, number>;

function read(): Scores {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Scores = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    // Un valor corrupto devuelve la fila a los por defecto. Nunca lanza: esto
    // es un adorno del compositor, y el compositor tiene que dibujarse.
    return {};
  }
}

export function readUses(): Scores {
  return read();
}

/** Una petición. La llama el compositor cuando lo mandado es una de las frases. */
export function recordUse(id: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const scores = read();
    const next: Scores = {};
    for (const [k, v] of Object.entries(scores)) {
      const decayed = v * DECAY;
      // Lo que se apagó se tira, en vez de arrastrarlo para siempre.
      if (decayed > 0.05) next[k] = decayed;
    }
    next[id] = (next[id] ?? 0) + 1;
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Almacenamiento lleno o bloqueado (modo privado). La fila no aprende.
  }
}

/**
 * Qué frase se acaba de mandar, si es una de las nuestras.
 *
 * ES EL ÚNICO SITIO DONDE SE APRENDE, y es a propósito que no sea el clic del
 * chip: si sólo contaran los chips, la fila no podría cambiar nunca —los cinco
 * por defecto se reforzarían a sí mismos y ninguna otra frase tendría cómo
 * ganarse un hueco—. Contando el envío, aprende también de lo que se eligió en
 * el `/`, de las tarjetas de la pantalla vacía, de los seguimientos y del aviso
 * de lo que te espera, que son las cuatro formas en que estas frases llegan al
 * compositor sin teclearse.
 *
 * La comparación es exacta salvo tildes y mayúsculas: una frase retocada a mano
 * ya no es la misma pregunta y no debería contar como tal.
 */
export function matchShortcut(text: string, candidates: Shortcut[]): string | null {
  const needle = fold(text.trim());
  if (!needle) return null;
  for (const candidate of candidates) {
    if (fold(candidate.phrase.trim()) === needle) return candidate.id;
  }
  return null;
}

/**
 * Los chips, en el orden en que se dibujan.
 *
 * Primero lo que esta persona pide de verdad —lo que cruzó el piso, de más a
 * menos—, y los huecos que sobren se rellenan con los por defecto en su orden
 * escrito. Nunca con un candidato cualquiera: una fila con la primera
 * herramienta del catálogo en orden alfabético no es «lo que más usas», es
 * ruido con la misma pinta.
 *
 * PURA, y separada del almacén de arriba para poder probarla sin navegador. Los
 * empates conservan el orden de entrada, así que la fila no se baraja sola.
 */
export function pickShortcuts(
  candidates: Shortcut[],
  scores: Scores,
  limit = SHORTCUT_SLOTS,
): Shortcut[] {
  const earned = candidates
    .map((item, index) => ({ item, index, score: scores[item.id] ?? 0 }))
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);

  const picked: Shortcut[] = earned.slice(0, limit);
  const taken = new Set(picked.map((item) => item.id));

  for (const id of DEFAULT_SHORTCUTS) {
    if (picked.length >= limit) break;
    if (taken.has(id)) continue;
    const candidate = candidates.find((item) => item.id === id);
    if (!candidate) continue;
    picked.push(candidate);
    taken.add(id);
  }

  return picked;
}
