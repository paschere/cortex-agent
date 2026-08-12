/**
 * The trámites-web vocabulary, restated for the browser.
 *
 * WHY THIS FILE EXISTS. `@cortex/agent-tools` has no subpath exports, so any
 * import from it pulls the whole barrel — and the barrel reaches the custom-tool
 * HTTP client, which imports `node:dns/promises`. In a server component that is
 * invisible; in a `'use client'` component it fails the production build with a
 * module-not-found for a Node builtin, while `typecheck` and `test` stay green
 * because neither one bundles for the browser. That is exactly how it shipped
 * once already: green locally, red in Vercel.
 *
 * `commitments-shape.ts` and `ToolsCatalog.tsx` hit the same wall and solved it
 * the same way. Types are fine to import (they erase); values are not.
 *
 * These are copies, and copies drift. `browser-shape.test.ts` runs in Node,
 * imports the real module, and fails if the two ever disagree — so the
 * duplication is checked rather than trusted.
 */

/** What a flow does to the site it runs on. Decides whether it needs approval. */
export const FLOW_EFFECTS = ['read', 'write'] as const;
export type FlowEffect = (typeof FLOW_EFFECTS)[number];

/**
 * `draft` is PROPUESTO and `ready` is PROBADO, and the screen says those two
 * words rather than "borrador" and "listo". The distinction is not about
 * polish, it is about whether anybody has ever seen the errand work — which is
 * the only question that matters the day somebody schedules one to run at 3am.
 */
export const FLOW_STATUSES = ['draft', 'ready', 'broken'] as const;
export type FlowStatus = (typeof FLOW_STATUSES)[number];

export const STEP_ACTIONS = [
  'goto',
  'click',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
  'wait_for',
  'extract',
  'download',
] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

export const TARGET_KINDS = [
  'testid',
  'role',
  'label',
  'placeholder',
  'text',
  'name',
  'css',
] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const EFFECT_LABEL: Record<FlowEffect, string> = {
  read: 'Consulta',
  write: 'Radica o envía',
};

export const STATUS_LABEL: Record<FlowStatus, string> = {
  draft: 'Propuesto',
  ready: 'Probado',
  broken: 'Roto',
};

/** Rose is reserved for the irreversible; a proposal is not a failure. */
export const STATUS_TONE: Record<FlowStatus, 'emerald' | 'amber' | 'rose'> = {
  draft: 'amber',
  ready: 'emerald',
  broken: 'rose',
};

export const ACTION_LABEL: Record<StepAction, string> = {
  goto: 'Ir a',
  click: 'Hacer clic en',
  fill: 'Escribir en',
  select: 'Elegir en',
  check: 'Marcar',
  uncheck: 'Desmarcar',
  press: 'Presionar tecla en',
  wait_for: 'Esperar',
  extract: 'Leer',
  download: 'Descargar desde',
};

export const TARGET_LABEL: Record<TargetKind, string> = {
  testid: 'identificador de prueba',
  role: 'tipo y nombre visible',
  label: 'rótulo del campo',
  placeholder: 'texto de ayuda',
  text: 'texto visible',
  name: 'nombre del campo',
  css: 'ruta en el HTML',
};

/** Why the ranking is what it is, in one line each, for the flow detail screen. */
export const TARGET_WHY: Record<TargetKind, string> = {
  testid: 'Puesto ahí a propósito para que un robot lo encuentre. No cambia.',
  role: 'Lo que el elemento es más lo que dice. Sobrevive a un rediseño.',
  label: 'El rótulo impreso al lado del campo, que es lo que lee una persona.',
  placeholder: 'El texto gris de adentro. Se reescribe más seguido que un rótulo.',
  text: 'Las palabras del enlace o del botón.',
  name: 'El nombre interno del campo. Los portales del Estado casi nunca lo tocan.',
  css: 'La posición en el HTML. Es el primero que se rompe.',
};

/** Shapes the API returns. Kept here so the client never imports the barrel. */
export interface FlowSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  site: string;
  startUrl: string;
  effect: FlowEffect;
  status: FlowStatus;
  version: number;
  verifiedAt: string | null;
  hasCredential: boolean;
  variables: { name: string; label: string; example: string; required: boolean }[];
  stepCount: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastError: string | null;
  lastRunSeconds: number | null;
  lastRunCostUsd: number | null;
}

export interface ProposedTarget {
  kind: TargetKind;
  value: string;
  name?: string;
}

export interface ProposedStep {
  action: StepAction;
  label: string;
  targets: ProposedTarget[];
  value?:
    | { kind: 'literal'; text: string }
    | { kind: 'template'; text: string }
    | { kind: 'secret'; field: string };
  url?: string;
  expect?: string;
  landmarks: string[];
  optional?: boolean;
  extractAs?: string;
}

export interface Proposal {
  name: string;
  description: string;
  startUrl: string;
  effect: FlowEffect;
  variables: { name: string; label: string; example: string; required: boolean }[];
  steps: ProposedStep[];
  notes: string[];
}
