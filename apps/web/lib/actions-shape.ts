/**
 * The proposed-action vocabulary, restated for the browser.
 *
 * WHY THIS FILE EXISTS. `@cortex/agent-tools` has no subpath exports, so any
 * import from it pulls the whole barrel — and the barrel reaches the custom-tool
 * HTTP client, which imports `node:dns/promises`. In a server component that is
 * invisible; in a `'use client'` component it fails the production build with a
 * module-not-found for a Node builtin, while `typecheck` and `test` stay green
 * because neither one bundles for the browser. That is exactly how it shipped
 * once: green locally, red in Vercel.
 *
 * `commitments-shape.ts` and `ToolsCatalog.tsx` hit the same wall and solved it
 * the same way. Types are fine to import (they erase); values are not.
 *
 * These are copies, and copies drift. `actions-shape.test.ts` runs in Node,
 * imports the real module, and fails if the two ever disagree — so the
 * duplication is checked rather than trusted.
 */

export const ACTION_KINDS = ['collect_payment', 'remind_owner', 'reply_to_client'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const ACTION_KIND_LABEL: Record<ActionKind, string> = {
  collect_payment: 'Cobro de cartera',
  remind_owner: 'Recordatorio de vencimiento',
  reply_to_client: 'Respuesta a un cliente',
};

/** Who ends up reading it — what decides the register, and the warning. */
export const KIND_AUDIENCE: Record<ActionKind, 'client' | 'internal'> = {
  collect_payment: 'client',
  remind_owner: 'internal',
  reply_to_client: 'client',
};

export const ACTION_OUTCOMES = ['none', 'awaiting', 'replied', 'resolved', 'no_reply'] as const;
export type ActionOutcome = (typeof ACTION_OUTCOMES)[number];

export const OUTCOME_LABEL: Record<ActionOutcome, string> = {
  none: 'Sin enviar',
  awaiting: 'Esperando respuesta',
  replied: 'Respondieron',
  resolved: 'Resuelto',
  no_reply: 'Sin respuesta',
};

export const OUTCOME_TONE: Record<ActionOutcome, 'emerald' | 'amber' | 'rose' | 'ink'> = {
  none: 'ink',
  awaiting: 'amber',
  replied: 'emerald',
  resolved: 'emerald',
  no_reply: 'amber',
};

/**
 * The shape the cards render. Structurally the `Action` the tools return; kept
 * here so a client component never has to import the package for a type it can
 * describe itself.
 */
export interface ActionView {
  id: string;
  kind: ActionKind;
  kindLabel: string;
  audience: 'client' | 'internal';
  state: 'proposed' | 'approved' | 'dismissed';
  stateLabel: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  contentHash: string;
  rationale: string;
  originKind: 'commitment' | 'email_thread' | 'manual';
  originId: string | null;
  expiresAt: string;
  editedCount: number;
  outcome: ActionOutcome;
  outcomeLabel: string;
  outcomeNote: string | null;
  executedAt: string | null;
  createdAt: string;
}

/**
 * The short form of a fingerprint, for the provenance chip.
 *
 * Twelve hex characters. Nobody compares these by eye, and that is not what it
 * is for: it is there so the number the person is agreeing to is VISIBLE and
 * changes when the text changes, which is what makes "el texto cambió" a claim
 * they can check rather than one they have to take on faith.
 */
export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

/** "vence en 3 días" / "vence hoy" / "vencida". */
export function expiryPhrase(expiresAt: string, now: number = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'vencida';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `vence en ${days} ${days === 1 ? 'día' : 'días'}`;
  const hours = Math.ceil(ms / 3_600_000);
  return `vence en ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
}
