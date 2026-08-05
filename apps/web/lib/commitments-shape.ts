/**
 * The commitment vocabulary, restated for the browser.
 *
 * WHY THIS FILE EXISTS. `@cortex/agent-tools` has no subpath exports, so any
 * import from it pulls the whole barrel — and the barrel reaches the custom-tool
 * HTTP client, which imports `node:dns/promises`. In a server component that is
 * invisible; in a `'use client'` component it fails the production build with a
 * module-not-found for a Node builtin, while `typecheck` and `test` stay green
 * because neither one bundles for the browser. That is exactly how it shipped:
 * green locally, red in Vercel.
 *
 * `ToolsCatalog.tsx` hit the same wall and solved it the same way. Types are
 * fine to import (they erase); values are not.
 *
 * These are copies, and copies drift. `commitments-shape.test.ts` runs in Node,
 * imports the real module, and fails if the two ever disagree — so the
 * duplication is checked rather than trusted.
 */

export const COMMITMENT_KINDS = [
  'soat',
  'rtm',
  'contract',
  'policy',
  'warranty',
  'customs',
  'payment',
  'other',
] as const;

export type CommitmentKind = (typeof COMMITMENT_KINDS)[number];

/** How many days before the due date the first notice goes out, per kind. */
export const DEFAULT_NOTICE_DAYS: Record<CommitmentKind, number> = {
  soat: 30,
  rtm: 30,
  contract: 45,
  policy: 30,
  warranty: 15,
  customs: 7,
  payment: 3,
  other: 15,
};

export const KIND_LABEL: Record<CommitmentKind, string> = {
  soat: 'SOAT',
  rtm: 'Tecnomecánica',
  contract: 'Contrato',
  policy: 'Póliza',
  warranty: 'Garantía',
  customs: 'Plazo de aduana',
  payment: 'Pago',
  other: 'Otro',
};
