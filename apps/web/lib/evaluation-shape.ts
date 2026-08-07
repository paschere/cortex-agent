/**
 * The evaluation vocabulary, restated for the browser.
 *
 * WHY THIS FILE EXISTS. `@cortex/agent-tools` has no subpath exports, so any
 * import from it pulls the whole barrel — and the barrel reaches the custom-tool
 * HTTP client, which imports `node:dns/promises`. In a server component that is
 * invisible; in a `'use client'` component it fails the production build with a
 * module-not-found for a Node builtin, while `typecheck` and `test` stay green
 * because neither one bundles for the browser. That is exactly how it shipped
 * once already; `commitments-shape.ts` and `ToolsCatalog.tsx` hit the same wall
 * and solved it the same way. Types are fine to import — they erase. Values are
 * not.
 *
 * These are copies, and copies drift. `evaluation-shape.test.ts` runs in Node,
 * imports the real module, and fails if the two ever disagree.
 */

export const EVAL_TIERS = ['offline', 'live', 'answers'] as const;
export type EvalTierName = (typeof EVAL_TIERS)[number];

export const TIER_LABEL: Record<EvalTierName, string> = {
  offline: 'Sobre la medición guardada',
  live: 'Contra la API en vivo',
  answers: 'Con respuestas juzgadas',
};

/**
 * What each headline number means, in one sentence, on the screen.
 *
 * They are here rather than inline in the component because the two of them
 * being told apart is the whole reason the product does not report a single
 * accuracy figure, and a reader who does not know which is which will average
 * them in their head.
 */
export const METRIC_HELP = {
  grounding:
    'De las preguntas que el material sí responde, cuántas se respondieron desde el documento correcto.',
  restraint:
    'De las preguntas que el material NO responde, cuántas se reconocieron como tales en vez de contestarse igual.',
  top1: 'De las preguntas que el material sí responde, cuántas trajeron el documento correcto en primer lugar.',
  reach: 'De las peticiones que necesitan una herramienta concreta, cuántas la recibieron.',
  missedByFloor:
    'Fragmentos correctos que la búsqueda encontró y el piso de relevancia botó. Debe ser cero: es la falla que llegó a producción.',
  overclaimed:
    'Preguntas sin respuesta en el material que se marcaron como respondidas. Debe ser cero: es la falla contraria.',
} as const;

/** A percentage the way this product writes them: entero, sin decimales. */
export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * A delta with its sign, or a dash when there is nothing to compare against.
 *
 * Zero prints as a dash rather than "0%" on purpose: "no cambió" and "no hay con
 * qué comparar" look the same in a table of numbers, and only one of them is
 * information.
 */
export function delta(before: number | undefined, after: number, asPercent = true): string | null {
  if (before === undefined) return null;
  const diff = after - before;
  if (Math.abs(diff) < 0.0005) return null;
  const sign = diff > 0 ? '+' : '−';
  const size = Math.abs(diff);
  return asPercent ? `${sign}${Math.round(size * 100)} pts` : `${sign}${size}`;
}

/** Which way a metric is supposed to move. */
export type Direction = 'up' | 'down';

export function toneFor(direction: Direction, before: number | undefined, after: number): 'good' | 'bad' | 'flat' {
  if (before === undefined) return 'flat';
  const diff = after - before;
  if (Math.abs(diff) < 0.0005) return 'flat';
  const better = direction === 'up' ? diff > 0 : diff < 0;
  return better ? 'good' : 'bad';
}
