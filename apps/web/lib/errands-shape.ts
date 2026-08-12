/**
 * The errand vocabulary, restated for the browser.
 *
 * WHY THIS FILE EXISTS. `@cortex/agent-tools` has no subpath exports, so any
 * import from it pulls the whole barrel — and the barrel reaches the custom-tool
 * HTTP client, which imports `node:dns/promises`. In a server component that is
 * invisible; in a `'use client'` component it fails the production build with a
 * module-not-found for a Node builtin, while `typecheck` and `test` stay green
 * because neither one bundles for the browser. That is exactly how it shipped
 * once: green locally, red in Vercel.
 *
 * `commitments-shape.ts`, `actions-shape.ts`, `reports-shape.ts`,
 * `clients-shape.ts` and `browser-shape.ts` all hit the same wall and solved it
 * the same way. Types are fine to import (they erase); values are not.
 *
 * These are copies, and copies drift. `errands-shape.test.ts` runs in Node,
 * imports the real modules, and fails if the two ever disagree — so the
 * duplication is checked rather than trusted.
 *
 * KEEP THIS FILE SMALL. It holds only what a client component genuinely needs
 * to render. Anything a screen can be handed as a prop from its server page
 * belongs there instead, and anything only the engine uses stays in the package.
 */

export const ERRAND_KINDS = ['research_compare', 'gather_sources', 'monitor_change'] as const;
export type ErrandKind = (typeof ERRAND_KINDS)[number];

export const ERRAND_STATES = [
  'queued',
  'working',
  'blocked',
  'watching',
  'delivered',
  'failed',
  'cancelled',
  'exhausted',
] as const;
export type ErrandState = (typeof ERRAND_STATES)[number];

export const TERMINAL_ERRAND_STATES: readonly ErrandState[] = [
  'delivered',
  'failed',
  'cancelled',
  'exhausted',
];

export function isErrandTerminal(state: ErrandState): boolean {
  return TERMINAL_ERRAND_STATES.includes(state);
}

/** Screen name per kind. Mirrors ERRAND_KIND_SPECS[kind].label. */
export const ERRAND_KIND_LABEL: Record<ErrandKind, string> = {
  research_compare: 'Investigar y comparar',
  gather_sources: 'Reunir información',
  monitor_change: 'Vigilar y avisar',
};

/**
 * The limit, stated where somebody about to hand over an hour of autonomous
 * work can read it. Mirrors ERRAND_BOUNDARY_NOTICE in the package — and the
 * drift test is not decoration here: this sentence is the promise the whole
 * feature is sold on, and a screen that says something softer than the code
 * enforces is worse than a screen that says nothing.
 */
export const ERRAND_BOUNDARY_NOTICE =
  'Un encargo busca, compara y te propone. Nunca compra, ni reserva, ni firma, ni le manda nada ' +
  'a un tercero por su cuenta: eso pasa siempre por Aprobaciones o por Acciones, donde tú lo ves ' +
  'antes de que ocurra.';

/** Fraction of the token ceiling consumed, clamped to 0..1. Mirrors budget.ts. */
export function spentFraction(spend: { tokensSpent: number; tokenCeiling: number }): number {
  if (spend.tokenCeiling <= 0) return 1;
  return Math.min(1, Math.max(0, spend.tokensSpent / spend.tokenCeiling));
}

/** Cadences a monitor may be set to. Mirrors MONITOR_CADENCES in kinds.ts. */
export const MONITOR_CADENCES: Array<{ minutes: number; label: string }> = [
  { minutes: 60, label: 'Cada hora' },
  { minutes: 6 * 60, label: 'Cada 6 horas' },
  { minutes: 24 * 60, label: 'Una vez al día' },
  { minutes: 7 * 24 * 60, label: 'Una vez por semana' },
];

export const DEFAULT_MONITOR_CADENCE_MINUTES = 24 * 60;

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------
//
// What `GET /api/errands/[id]` sends and what the detail screen renders. These
// are TYPES, so they cost nothing at runtime and can be imported from either
// side — the server repository declares its return type against them, which is
// what keeps the two ends of the wire from drifting without a test.
//
// `errands-shape.test.ts` additionally asserts that the package's own view
// types remain assignable to these, so widening a row in the package and
// forgetting the screen is a compile error rather than a blank field.

/** One thing the deliverable rests on. Always stamped on screen. */
export interface ErrandSource {
  title: string;
  url: string | null;
  /** ISO instant the fact was read. The whole point of a source ledger. */
  readAt: string;
}

export interface ErrandQuestionView {
  id: string;
  leg: number;
  question: string;
  why: string;
  options: string[];
  state: 'open' | 'answered' | 'withdrawn';
  answer: string | null;
  askedAt: string;
  answeredAt: string | null;
}

export type LegStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';

export interface ErrandLegView {
  id: string;
  seq: number;
  runId: string | null;
  objective: string;
  status: LegStatus;
  summary: string | null;
  tokens: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface ErrandView {
  id: string;
  kind: ErrandKind;
  request: string;
  brief: string | null;
  state: ErrandState;
  tokenCeiling: number;
  tokensSpent: number;
  legCeiling: number;
  legsUsed: number;
  checkIntervalMinutes: number | null;
  checksDone: number;
  nextCheckAt: string | null;
  conversationId: string | null;
  currentRunId: string | null;
  findings: string | null;
  deliverable: string | null;
  sources: ErrandSource[];
  closingNote: string | null;
  lastHeartbeatAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface ErrandDetail {
  errand: ErrandView;
  legs: ErrandLegView[];
  questions: ErrandQuestionView[];
  /** Progress of the leg currently working, read off orchestration_tasks. */
  currentLeg: { runId: string; done: number; total: number; working: string[] } | null;
  /**
   * One sentence saying what this errand is doing, computed SERVER-SIDE from
   * the same rows the engine reads (lib/errands/engine.ts `describeState`).
   *
   * It is sent rather than derived here on purpose. A screen that works out
   * "what is this thing doing" from the columns is a second state machine, and
   * a second state machine eventually disagrees with the first — which on a
   * forty-minute job means the page confidently narrating something that is not
   * happening.
   */
  situation: string;
}

/** What the launch form needs to know about a kind. Everything else is engine. */
export interface ErrandKindOption {
  kind: ErrandKind;
  label: string;
  blurb: string;
  example: string;
}
