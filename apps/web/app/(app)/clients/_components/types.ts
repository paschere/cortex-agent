import type { ClientStatus, LinkEntityKind, LinkMethod } from '@/lib/clients-shape';

/**
 * What the screens need, and nothing else.
 *
 * Deliberately not the database row: the pages are server components that
 * already resolved names, formatted every date for a Colombian reader and
 * decided what may be shown. The client components receive conclusions, so a
 * badge cannot recompute "aplicado" differently from the list it sits in.
 */

export interface ClientRowView {
  id: string;
  name: string;
  legalName: string | null;
  nit: string | null;
  status: ClientStatus;
  statusLabel: string;
  city: string | null;
  services: string[];
  owner: string | null;
  /** Applied links plus open commitments — how much is actually hanging here. */
  attached: number;
  openCommitments: number;
  overdueCommitments: number;
  domains: string[];
  updatedLabel: string;
}

export interface LinkView {
  id: string;
  kind: LinkEntityKind;
  kindLabel: string;
  label: string;
  /** Already formatted: "14 sep 2026". Null when the thing carries no date. */
  whenLabel: string | null;
  /** For the ordering the page decided, kept so the client can group by month. */
  occurredAt: string | null;
  method: LinkMethod;
  methodLabel: string;
  /** One sentence: why Cortex says this is theirs. */
  why: string;
  evidence: string | null;
  /**
   * True when the link was applied without anybody reviewing it — a registered
   * domain or a registered contact. Drives the wording on the chip, which has
   * to be honest about the difference.
   */
  automatic: boolean;
}

export interface ContactView {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  isPrimary: boolean;
  statusLabel: string;
  sourceLabel: string;
  lastSeenLabel: string | null;
}

export interface CommitmentView {
  id: string;
  title: string;
  kindLabel: string;
  dueLabel: string;
  daysLeft: number;
  state: 'in_force' | 'due_soon' | 'overdue' | 'met' | 'dropped';
  stateLabel: string;
  amountCop: number | null;
}

export interface DomainView {
  id: string;
  domain: string;
  verifiedBy: string | null;
  verifiedLabel: string | null;
}

/** A counterparty on a commitment that no client answers for yet. */
export interface BacklogView {
  counterparty: string;
  count: number;
  /** Existing clients the text could be about. Never applied — offered. */
  candidates: Array<{ id: string; name: string; why: string }>;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Set by actions that want to say what happened, not only that it worked. */
  note?: string;
  clientId?: string;
}
