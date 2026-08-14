/**
 * WHICH DESTINATIONS THIS PERSON ACTUALLY OPENS.
 *
 * ===========================================================================
 * WHY IT LIVES IN THE BROWSER AND NOT IN THE DATABASE
 * ===========================================================================
 * There is no page-view event anywhere in this product — `audit_events` records
 * TOOL CALLS, not screens — so measuring this at all means creating the signal.
 * It is created in `localStorage`, and that is a decision rather than the lazy
 * option:
 *
 *   It is a preference, not a fact about the company. "Mateo opens Cartera every
 *   morning" belongs to Mateo's browser the same way the collapsed rail already
 *   does. Putting it in Postgres would make the order of somebody's menu into a
 *   row another person could read, for no gain.
 *
 *   It costs nothing. A write per click into a small object, no request, no
 *   round trip, nothing to fail. A rail that reordered itself after a network
 *   call would flicker on every navigation.
 *
 *   It is disposable by construction. Clearing site data resets the rail to its
 *   designed order, which is a sane worst case.
 *
 * ===========================================================================
 * WHAT IT IS ALLOWED TO CHANGE, AND WHAT IT MUST NOT
 * ===========================================================================
 * Two things: the order INSIDE the grouped sections, and WHICH FIVE
 * destinations sit in the short block at the top of the rail. Never the three
 * pinned rows, never which section something belongs to, and nothing is ever
 * hidden.
 *
 * Inicio, Chat and Te espera are exempt because they are the part of this rail
 * people learn with their hands: those three, in that order, every morning.
 * Reordering them would move a target somebody was already reaching for — the
 * exact way an adaptive menu becomes a menu you have to read again.
 *
 * And nothing is hidden, because a destination that disappears because you have
 * not used it is a destination you can never discover. What does not make the
 * top block is inside «Todo», one click away, and `nav-shape.test.ts` fails if
 * the union of the two ever loses a destination. The rail gets easier to scan;
 * it never gets shorter behind your back.
 */

const KEY = 'nav_usage_v1';

/**
 * La pertenencia al bloque de arriba, en SU PROPIA clave.
 *
 * No cabe en `nav_usage_v1` y no es un capricho: `read()` de ahí sólo admite
 * números y `recordVisit` DECAE el objeto entero en cada escritura. Una lista de
 * destinos metida en ese saco sería descartada al leerla o multiplicada por 0.98
 * al escribirla. Son dos hechos distintos —cuánto usas algo, y qué hay hoy
 * arriba— y viven en dos sitios.
 */
const QUICK_KEY = 'nav_quick_v1';

/**
 * How much a click is worth against the ones before it.
 *
 * Every recorded click decays what came before by this factor, so the ranking
 * follows what somebody is doing THIS month rather than what they did in their
 * first week. Without it, the order calcifies: the screens explored on day one
 * would outrank the ones used daily, for ever, and the feature would make the
 * rail worse over time — which is how these things usually fail.
 */
const DECAY = 0.98;

/**
 * How far a destination may climb over one that has never been opened.
 *
 * A single accidental click should not reorder anything, so a destination needs
 * real repetition before it moves. The floor also keeps a brand-new workspace
 * on the designed order, which is the order somebody argued for.
 */
const MIN_SCORE = 2.5;

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
    // A corrupt value resets the ranking to the designed order. Never throws:
    // this is a nicety on the navigation, and the navigation has to render.
    return {};
  }
}

/** One visit. Called from the rail's own click handler. */
export function recordVisit(href: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const scores = read();
    const next: Scores = {};
    for (const [k, v] of Object.entries(scores)) {
      const decayed = v * DECAY;
      // Drop what has faded to nothing rather than carrying it for ever.
      if (decayed > 0.05) next[k] = decayed;
    }
    next[href] = (next[href] ?? 0) + 1;
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked (private mode). The rail keeps its order.
  }
}

export function readUsage(): Scores {
  return read();
}

/**
 * The designed order, with what somebody actually uses lifted to the top.
 *
 * PURE, and separate from the storage above so it can be tested without a
 * browser. Stability matters as much as the ranking: destinations that have not
 * earned a move keep their relative order exactly, so the bottom of a section
 * never shuffles on its own.
 */
export function orderByUsage<T extends { href: string }>(items: T[], scores: Scores): T[] {
  const score = (i: T) => {
    const s = scores[i.href] ?? 0;
    return s >= MIN_SCORE ? s : 0;
  };
  // Index-carrying sort so equal scores keep the authored order. A plain
  // comparator on a bare array is stable in modern engines, but writing it down
  // makes "the designed order is the tiebreak" a property rather than a
  // coincidence of the runtime.
  return items
    .map((item, index) => ({ item, index, score: score(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((e) => e.item);
}

/**
 * Lo que hay que usar algo para que suba al bloque de arriba.
 *
 * Cinco visitas dentro de la ventana que el decaimiento deja abierta. Es
 * deliberadamente el doble que `MIN_SCORE`: reordenar dentro de una sección
 * cuesta poco si se equivoca —la fila sigue a la vista, dos puestos más arriba—
 * y ascender al bloque fijo empuja a otra cosa fuera de él. Las dos decisiones
 * no pueden costar lo mismo.
 */
const QUICK_MIN = 5;

/**
 * LA HISTÉRESIS, QUE ES LO QUE IMPIDE QUE EL BLOQUE BAILE.
 *
 * Un umbral solo no basta: dos destinos con puntuaciones parecidas se
 * adelantarían el uno al otro con cada clic, y el bloque cambiaría de contenido
 * a diario sin que nadie hubiera cambiado de costumbres. Así que quien ya está
 * dentro se defiende: para echarlo hay que sacarle DOS VISITAS ENTERAS de
 * ventaja, no una décima. Y como el que entra hereda esa misma defensa, volver
 * a intercambiarlos exige otras dos en sentido contrario — que es exactamente lo
 * que hace falta para que un empate técnico no se traduzca en movimiento.
 *
 * Por eso la pertenencia se GUARDA (`nav_quick_v1`) en vez de recalcularse desde
 * cero: sin memoria de quién está dentro no hay a quién defender, y la regla se
 * degrada a un umbral, que es el caso que oscila.
 */
const PROMOTE_MARGIN = 2;

/**
 * Qué destinos ocupan hoy el bloque corto de arriba.
 *
 * PURA, como `orderByUsage`, y por lo mismo: es la regla que decide qué ve la
 * gente, así que tiene que poder probarse sin un navegador.
 *
 * Hay tantas plazas como semillas. `seeds` es la respuesta razonable para quien
 * llega el primer día y no ha usado nada; a partir de ahí una plaza se gana, y
 * `previous` —lo que había ayer— es lo que se defiende.
 *
 * COMO MUCHO UN CAMBIO POR EVALUACIÓN. Aunque tres destinos superen a la vez a
 * sus rivales, el bloque se mueve de a una fila entre un pintado y el siguiente.
 * Un menú que se rehace entero delante de ti no se lee como un menú que aprende,
 * se lee como un menú roto.
 */
export function pickQuick(
  candidates: string[],
  scores: Scores,
  previous: string[] | null,
  seeds: string[],
): string[] {
  const allowed = new Set(candidates);
  const slots = seeds.filter((href) => allowed.has(href));
  if (slots.length === 0) return [];

  // Lo de ayer manda, siempre que siga existiendo. Un destino que se renombró o
  // se retiró deja su plaza libre en vez de dejar el bloque corto.
  const block: string[] = [];
  for (const href of previous ?? []) {
    if (allowed.has(href) && !block.includes(href) && block.length < slots.length) {
      block.push(href);
    }
  }
  // Y lo que falte se rellena con las semillas primero y con el orden diseñado
  // después, para que el bloque nunca tenga un hueco.
  for (const href of [...slots, ...candidates]) {
    if (block.length >= slots.length) break;
    if (!block.includes(href)) block.push(href);
  }

  const score = (href: string) => scores[href] ?? 0;

  // El más flojo de dentro, con el orden diseñado como desempate al revés: entre
  // dos que valen lo mismo cae el que el diseño puso más abajo.
  let weakest = block[0] as string;
  for (const href of block) {
    if (score(href) < score(weakest)) weakest = href;
    else if (
      score(href) === score(weakest) &&
      candidates.indexOf(href) > candidates.indexOf(weakest)
    )
      weakest = href;
  }

  // El más fuerte de fuera. El desempate aquí sí es el orden diseñado normal.
  let challenger: string | null = null;
  for (const href of candidates) {
    if (block.includes(href)) continue;
    if (challenger === null || score(href) > score(challenger)) challenger = href;
  }

  if (
    challenger !== null &&
    score(challenger) >= Math.max(QUICK_MIN, score(weakest) + PROMOTE_MARGIN)
  ) {
    block[block.indexOf(weakest)] = challenger;
  }

  // Devuelto en el orden diseñado: la pertenencia la decide el uso, la posición
  // no. Ver `buildRail`.
  return candidates.filter((href) => block.includes(href));
}

/** Lo que había arriba la última vez. `null` si esta persona es nueva aquí. */
export function readQuick(): string[] | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(QUICK_KEY) ?? 'null');
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return null;
  }
}

/** Guarda la pertenencia. Sólo escribe si de verdad cambió. */
export function writeQuick(hrefs: string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const next = JSON.stringify(hrefs);
    if (localStorage.getItem(QUICK_KEY) !== next) localStorage.setItem(QUICK_KEY, next);
  } catch {
    // Almacenamiento lleno o bloqueado (modo privado). El bloque se recalcula
    // igual en cada carga; lo único que se pierde es la defensa del que estaba.
  }
}
