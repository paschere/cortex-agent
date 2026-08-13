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

// ---------------------------------------------------------------------------
// La misma lista, leída por persona
// ---------------------------------------------------------------------------

/**
 * PROMESAS Y PAPELES NO SE SUMAN. NUNCA.
 *
 * Un SOAT es un papel que se vence y lo paga la empresa; «Ana quedó de mandar
 * el informe el viernes» es una promesa que le hizo una persona a otra. Meterlos
 * en la misma cifra produce un número que no significa nada: «Ana: 4 cosas» no
 * distingue entre alguien con cuatro promesas sin cumplir y alguien a cuyo
 * nombre están las pólizas de la flota. Por eso hay dos conteos separados en el
 * modelo, dos en la pantalla, y ninguna suma de los dos en ninguna parte.
 */
export interface PersonTally {
  /** Abiertos hoy: vigentes, por vencer y vencidos. */
  open: number;
  overdue: number;
}

/**
 * Lo que la persona ya cerró, dentro de la ventana que mira la pantalla.
 *
 * `rate` es `null` a propósito cuando hay poco historial. Decir «0 de 1 a
 * tiempo» de alguien que cerró una sola cosa es una acusación disfrazada de
 * dato, y una pantalla que hace eso deja de abrirse.
 */
export interface PersonRecord {
  closed: number;
  onTime: number;
  /** Entre 0 y 1, o `null` si todavía no hay con qué. */
  rate: number | null;
}

/** Un compromiso abierto, tal como se lee dentro de la fila de una persona. */
export interface PersonItem {
  id: string;
  title: string;
  kindLabel: string;
  /** Promesa entre personas (`internal`) o papel con vencimiento. */
  internal: boolean;
  dueOn: string;
  dueLabel: string;
  daysLeft: number;
  state: CommitmentState;
  stateLabel: string;
}

export interface PersonLoad {
  /** El `owner_user_id`, o `UNASSIGNED_KEY` cuando no hay nadie anotado. */
  key: string;
  name: string;
  unassigned: boolean;
  promises: PersonTally;
  papers: PersonTally;
  /** Todo lo abierto, de lo más urgente a lo menos. `items[0]` es lo que aprieta. */
  items: PersonItem[];
  promiseRecord: PersonRecord;
  paperRecord: PersonRecord;
}

export interface PeopleLoad {
  /** Con algo abierto encima, de quien más carga a quien menos. */
  pending: PersonLoad[];
  /** Sin nada abierto, y con historial que valga la pena enseñar. */
  clear: PersonLoad[];
  /** Sobre cuántos días se calculó el cumplimiento. */
  windowDays: number;
  /** Cuántos compromisos cerrados entraron en ese cálculo, en total. */
  closedInWindow: number;
}
