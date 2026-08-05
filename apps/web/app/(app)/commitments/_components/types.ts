import type { CommitmentKind, CommitmentState, Recurrence } from '@cortex/agent-tools';

/**
 * What the screen needs, and nothing else.
 *
 * Deliberately not the database row: the page is a server component that
 * already resolved names, derived the state against today in Bogotá and
 * decided what may be shown. The client components receive conclusions, so a
 * card cannot accidentally recompute "vencido" differently from the list it
 * sits in.
 */

export interface CommitmentSourceView {
  kind: 'manual' | 'system' | 'document';
  /** What to print on the chip: "RUNT", "Ana Gómez", the document title. */
  label: string;
  /** Already formatted for a Colombian reader — the component never guesses a locale. */
  readAt: string | null;
  quote: string | null;
  documentId: string | null;
  confirmed: boolean;
}

export interface CommitmentView {
  id: string;
  title: string;
  detail: string | null;
  kind: CommitmentKind;
  kindLabel: string;
  counterparty: string | null;
  amountCop: number | null;
  dueOn: string;
  dueLabel: string;
  daysLeft: number;
  state: CommitmentState;
  stateLabel: string;
  noticeDays: number;
  owner: string | null;
  vehiclePlate: string | null;
  recurrence: Recurrence;
  source: CommitmentSourceView;
  /** Set when the calendar event could not be written — shown quietly. */
  calendarError: string | null;
  hasCalendarEvent: boolean;
  /** Notices already sent for the current occurrence. */
  noticesSent: number;
  lastNoticeOn: string | null;
  acknowledged: boolean;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}
