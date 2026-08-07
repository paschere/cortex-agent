/**
 * The shapes this page passes from the server to the browser.
 *
 * MUST NOT IMPORT `@cortex/agent-tools`. The package has no subpath exports, so
 * any import pulls the whole barrel, and the barrel reaches the custom-tool HTTP
 * client and its `node:dns/promises`. In a server component that is invisible;
 * in a `'use client'` component it fails the production build while `typecheck`
 * and `test` both stay green, because neither one bundles for the browser. See
 * `apps/web/lib/commitments-shape.ts` for the full story.
 *
 * These are structural copies of what `learning/report.ts` returns. They are
 * plain data on purpose: the page renders sentences the server already wrote,
 * so the browser never has to know the module's vocabulary.
 */

export type AdjustmentKind = 'prefer_fragment' | 'demote_fragment' | 'stale_document';
export type AdjustmentStatus = 'active' | 'revoked' | 'expired';
export type ProposalKind = 'contradicted_value' | 'badly_cut_fragment' | 'unanswered_question';
export type ProposalStatus = 'open' | 'accepted' | 'dismissed';

/** A document as this reader is allowed to see it. */
export interface DocumentLabel {
  documentId: string;
  /** Null when the reader may not see the space it lives in, or it is gone. */
  title: string | null;
  spaceName: string | null;
  withheld: boolean;
}

export interface Evidence {
  net: number;
  positive: number;
  negative: number;
  actors: number;
  days: number;
  byKind: Record<string, number>;
  firstSeen: string;
  lastSeen: string;
}

export interface AdjustmentCard {
  id: string;
  kind: AdjustmentKind;
  /** Already translated by the server: "Se deja de último". */
  label: string;
  /** One sentence saying exactly what it does, and what it does not do. */
  explanation: string;
  chunkIndex: number;
  status: AdjustmentStatus;
  document: DocumentLabel;
  evidence: Evidence;
  createdAt: string;
  expiresAt: string;
  daysLeft: number;
  revokedAt: string | null;
  revokedReason: string | null;
  before: { positive: number; negative: number };
  since: { positive: number; negative: number };
}

export interface ProposalCard {
  id: string;
  kind: ProposalKind;
  label: string;
  headline: string;
  detail: string;
  status: ProposalStatus;
  statusLabel: string;
  document: DocumentLabel | null;
  chunkIndex: number | null;
  createdAt: string;
  decidedAt: string | null;
  decidedNote: string | null;
}

export interface SignalCard {
  id: string;
  label: string;
  /** The sentence the derivation wrote when it recorded this. */
  note: string;
  polarity: -1 | 1;
  weight: number;
  document: DocumentLabel;
  chunkIndex: number;
  observedAt: string;
  /** What was asked, when the signal came from a conversation. */
  asked: string | null;
}

export interface LearningView {
  active: AdjustmentCard[];
  past: AdjustmentCard[];
  proposals: ProposalCard[];
  decided: ProposalCard[];
  signals: SignalCard[];
  quiet: boolean;
}

export type ActionResult = { ok: true } | { ok: false; error: string };
