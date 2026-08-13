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
 * ONLY the order INSIDE the grouped sections. Never the daily block, never
 * which section something belongs to, and nothing is ever hidden.
 *
 * The daily block is exempt because it is the one part of this rail people
 * learn with their hands: Inicio, Chat, Aprobaciones, in that order, every
 * morning. Reordering it would move a target somebody was already reaching for
 * — the exact way an adaptive menu becomes a menu you have to read again.
 *
 * And nothing is hidden, because a destination that disappears because you have
 * not used it is a destination you can never discover. The rail gets easier to
 * scan; it never gets shorter behind your back.
 */

const KEY = 'nav_usage_v1';

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
