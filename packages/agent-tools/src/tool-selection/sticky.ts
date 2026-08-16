/**
 * La lista de herramientas de una conversación es ESTABLE Y CRECIENTE.
 *
 * EL PROBLEMA MEDIDO. El caché de Anthropic es un prefijo: un byte distinto en
 * `tools` → `system` → `messages` invalida todo lo que sigue al primer cambio.
 * Las herramientas se serializan ANTES del system prompt, así que la selección
 * semántica por turno (`selectToolsForTurn`) — que re-elige familias contra un
 * texto que cambia en cada turno — movía el prefijo desde el byte cero casi
 * siempre. En producción (turn_latencies, 7 días): 384k tokens ESCRITOS al
 * caché al 125 % contra 212k leídos al 10 %. Se estaba pagando el prefijo de
 * nuevo casi cada turno.
 *
 * LA REGLA. Dentro de una conversación, lo ya ofrecido se conserva y lo nuevo
 * se AGREGA AL FINAL. Concretamente, la lista de cada turno es:
 *
 *   [ ids persistidos, en el orden en que se ofrecieron por primera vez ]
 *   [ lo nuevo de este turno que se persiste, ordenado por id            ]
 *   [ la cola transitoria de este turno, ordenada por id                 ]
 *
 * Como lo persistido de un turno N es prefijo exacto de lo persistido del
 * turno N+1, el prefijo del request se preserva y sólo crece por el final —
 * que es la única forma de crecer que el caché perdona. El orden es además
 * determinista por construcción: nada aquí depende del orden en que llegaron
 * los candidatos, que para tools externos viene de una consulta sin ORDER BY.
 *
 * QUÉ NO CAMBIA. Esto no decide QUÉ es relevante — eso sigue siendo de
 * `rankTools` — ni puede ofrecer nada que los permisos no dieron: todo lo que
 * sale de aquí entró como candidato ya filtrado por grants, deny-list y mute.
 * Un id persistido cuya herramienta ya no es candidata (permiso revocado,
 * servidor MCP desconectado, familia silenciada) simplemente no se materializa
 * este turno — pero se conserva en la lista persistida, para que al volver
 * recupere su posición y el prefijo con ella.
 *
 * EL TOPE, Y LA POLÍTICA COMPLETA. Pasadas ~40 declaraciones la elección de
 * herramienta del modelo se degrada de forma medible (ver SELECTION_THRESHOLD),
 * así que el acumulado no puede crecer sin techo. La política:
 *
 *   · El acumulado manda hasta `STICKY_TOOL_BUDGET` ids persistidos; a partir
 *     de ahí SE CONGELA y no se persiste nada más.
 *   · Lo que la selección del turno pida por encima del tope se ofrece igual —
 *     una capacidad concedida no puede desaparecer, que es el incidente que
 *     parió todo el módulo de selección — pero viaja en la cola transitoria:
 *     el turno la paga como reescritura de cola, nunca del prefijo entero, y
 *     dos turnos seguidos sobre el mismo tema producen la misma cola y por
 *     tanto sí aciertan el caché completo.
 *
 * LA COLA TRANSITORIA lleva, además del excedente, dos cosas que por diseño no
 * deben quedar pegadas a la conversación: las familias sin indexar (`unranked`
 * dura un turno — el backfill las hace rankeables al siguiente) y todo lo
 * ofrecido por un turno en el que la selección no corrió de verdad (`freeze`:
 * Voyage caído o sin consulta mandan el catálogo entero, y persistir un
 * catálogo entero congelaría el presupuesto en un turno que no midió nada).
 */

import { type SelectableTool, toolFamily } from './rank';

/**
 * El techo de ids persistidos por conversación. Por qué 60: la selección sólo
 * actúa por encima de 40 candidatos (SELECTION_THRESHOLD) y un turno semántico
 * ofrece las familias base más un máximo de 6 situacionales — 60 da espacio
 * para varios cambios de tema antes de congelar, sin alejarse tanto de 40 que
 * el acumulado reconstruya el catálogo que la selección existe para no mandar.
 */
export const STICKY_TOOL_BUDGET = 60;

export interface StickyCombineInput<T extends SelectableTool> {
  /** Ids ya ofrecidos en esta conversación, en orden de primera aparición. */
  previousIds: readonly string[];
  /** La selección de ESTE turno, ya filtrada por familias silenciadas. */
  offered: readonly T[];
  /**
   * Todo lo que este turno tiene permitido ofrecer (mismo filtro de mute que
   * `offered`). Hace falta aparte porque los ids persistidos se materializan
   * contra esto: una herramienta pegada en el turno 2 debe seguir en el turno
   * 9 aunque la selección de hoy no la haya elegido.
   */
  candidates: readonly T[];
  /**
   * Familias que este turno ofrece pero que no deben quedar pegadas — hoy, las
   * familias sin indexar (`unrankedFamilies`), cuyo estado dura un turno.
   */
  transientFamilies?: ReadonlySet<string>;
  /**
   * True cuando la selección de este turno no midió nada (Voyage caído, sin
   * consulta): se ofrece todo lo pedido pero no se persiste nada nuevo.
   */
  freeze?: boolean;
  /** Sobre todo para tests. En producción, STICKY_TOOL_BUDGET. */
  budget?: number;
}

export interface StickyCombineResult<T> {
  /** La lista final del turno, en el orden que debe viajar al modelo. */
  tools: T[];
  /**
   * Lo que hay que guardar para el próximo turno. Igual (===-compatible en
   * contenido) a `previousIds` cuando `changed` es false, así el llamador se
   * ahorra la escritura.
   */
  persistIds: string[];
  /** True sólo cuando `persistIds` trae ids que `previousIds` no tenía. */
  changed: boolean;
  /** True cuando el tope dejó fuera de la persistencia algo de este turno. */
  frozen: boolean;
}

const byIdAsc = (a: SelectableTool, b: SelectableTool) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function combineStickySelection<T extends SelectableTool>(
  input: StickyCombineInput<T>,
): StickyCombineResult<T> {
  const { previousIds, offered, candidates } = input;
  const budget = input.budget ?? STICKY_TOOL_BUDGET;
  const transientFamilies = input.transientFamilies ?? new Set<string>();

  const candidateById = new Map<string, T>();
  for (const c of candidates) if (!candidateById.has(c.id)) candidateById.set(c.id, c);

  // La cabeza: lo ya ofrecido, en su orden original. Un id sin candidato hoy
  // no viaja hoy — pero no se borra de `previousIds`, para que si vuelve
  // (permiso restaurado, familia des-silenciada) recupere su posición exacta.
  const prevSet = new Set(previousIds);
  const head: T[] = [];
  for (const id of previousIds) {
    const c = candidateById.get(id);
    if (c) head.push(c);
  }

  // Lo nuevo del turno, sin duplicados y partido en lo que puede quedarse
  // pegado y lo que por diseño es de un solo turno.
  const seen = new Set<string>(prevSet);
  const persistable: T[] = [];
  const transient: T[] = [];
  for (const t of offered) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (input.freeze || transientFamilies.has(toolFamily(t))) transient.push(t);
    else persistable.push(t);
  }
  persistable.sort(byIdAsc);

  // El tope se cuenta contra la lista persistida — ids hoy inertes incluidos,
  // porque son posiciones reservadas que pueden volver a materializarse.
  const room = Math.max(0, budget - previousIds.length);
  const persisted = persistable.slice(0, room);
  const overflow = persistable.slice(room);

  const tail = [...overflow, ...transient].sort(byIdAsc);

  return {
    tools: [...head, ...persisted, ...tail],
    persistIds:
      persisted.length > 0 ? [...previousIds, ...persisted.map((t) => t.id)] : [...previousIds],
    changed: persisted.length > 0,
    frozen: overflow.length > 0,
  };
}
