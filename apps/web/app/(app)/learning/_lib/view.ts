/**
 * Turning the module's report into what the screen draws.
 *
 * Server-side, so it may import `@cortex/agent-tools` freely — and it is where
 * every phrase is chosen, so the browser receives sentences rather than codes.
 * That is not only a bundling convenience: the wording of what an adjustment
 * does is the safety claim of the whole feature, and it lives once, next to the
 * module that makes the claim true, instead of being reassembled in a component.
 */

import {
  ADJUSTMENT_EXPLANATIONS,
  ADJUSTMENT_LABELS,
  type AdjustmentView,
  type LearningReport,
  PROPOSAL_LABELS,
  PROPOSAL_STATUS_LABELS,
  type ProposalView,
  SIGNAL_LABELS,
  type SignalView,
} from '@cortex/agent-tools';
import type { AdjustmentCard, LearningView, ProposalCard, SignalCard } from '../_components/types';

function adjustmentCard(a: AdjustmentView): AdjustmentCard {
  return {
    id: a.id,
    kind: a.kind,
    label: ADJUSTMENT_LABELS[a.kind],
    explanation: ADJUSTMENT_EXPLANATIONS[a.kind],
    chunkIndex: a.chunkIndex,
    status: a.status,
    document: a.document,
    evidence: {
      net: a.evidence.net,
      positive: a.evidence.positive,
      negative: a.evidence.negative,
      actors: a.evidence.actors,
      days: a.evidence.days,
      byKind: a.evidence.byKind as Record<string, number>,
      firstSeen: a.evidence.firstSeen,
      lastSeen: a.evidence.lastSeen,
    },
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    daysLeft: a.daysLeft,
    revokedAt: a.revokedAt,
    revokedReason: a.revokedReason,
    before: a.before,
    since: a.since,
  };
}

function proposalCard(p: ProposalView): ProposalCard {
  return {
    id: p.id,
    kind: p.kind,
    label: PROPOSAL_LABELS[p.kind],
    headline: p.headline,
    detail: p.detail,
    status: p.status,
    statusLabel: PROPOSAL_STATUS_LABELS[p.status],
    document: p.document,
    chunkIndex: p.chunkIndex,
    createdAt: p.createdAt,
    decidedAt: p.decidedAt,
    decidedNote: p.decidedNote,
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function signalCard(s: SignalView): SignalCard {
  return {
    id: s.id,
    label: SIGNAL_LABELS[s.kind],
    note: text(s.detail?.note) ?? SIGNAL_LABELS[s.kind],
    polarity: s.polarity,
    weight: s.weight,
    document: s.document,
    chunkIndex: s.chunkIndex,
    observedAt: s.observedAt,
    asked: text(s.detail?.asked),
  };
}

export function toView(report: LearningReport): LearningView {
  return {
    active: report.active.map(adjustmentCard),
    past: report.past.map(adjustmentCard),
    proposals: report.proposals.map(proposalCard),
    decided: report.decided.filter((p) => p.status !== 'open').map(proposalCard),
    signals: report.recentSignals.map(signalCard),
    quiet: report.quiet,
  };
}
