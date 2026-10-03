/**
 * LO QUE LAS PANTALLAS DE CLIENTES RECIBEN: conclusiones, no filas.
 *
 * El servidor ya leyó, sumó, formateó en español de Colombia y decidió el tono
 * de cada cosa (lib/clients/view360.ts, lib/clients/grid.ts). Los componentes
 * del navegador sólo pintan; así un chip y la cifra a su lado no pueden
 * calcular dos cosas distintas. Sólo tipos: este archivo lo importa el
 * navegador.
 */

export type Piece<T> = { ok: true; data: T } | { ok: false; error: string };

export type Tone = 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';

export interface ActionResult {
  ok: boolean;
  error?: string;
  note?: string;
  clientId?: string;
}

export interface TeamMember {
  id: string;
  name: string;
}

export interface MoneyView {
  invoiced12m: string;
  invoiced12mNote: string;
  outstanding: string;
  outstandingNote: string;
  overdue: string;
  overdueNote: string;
  overdueTone: Tone;
  /** «38 días» o null (sin dato). */
  paymentDays: string | null;
  paymentDaysNote: string;
  nextDue: string | null;
  nextDueNote: string | null;
  otherCurrencies: string[];
}

export interface TimelineEntry {
  id: string;
  kind: string;
  kindLabel: string;
  /** ISO, para ordenar y agrupar por mes. */
  at: string;
  dateLabel: string;
  /** «Septiembre 2026», para el separador. */
  monthLabel: string;
  title: string;
  detail: string | null;
  by: string | null;
  href: string | null;
  tone: Tone;
  /** Fecha futura (un vencimiento por venir). */
  upcoming: boolean;
}

export interface OpenInvoiceView {
  id: string;
  label: string;
  amount: string;
  dueLabel: string;
  late: string | null;
  tone: Tone;
  href: string | null;
}

export interface OpenItemView {
  id: string;
  title: string;
  meta: string;
  tone: Tone;
  href: string | null;
}

export interface Client360View {
  id: string;
  name: string;
  legalName: string | null;
  nit: string | null;
  statusLabel: string;
  statusTone: Tone;
  owner: string | null;
  ownerId: string | null;
  tags: string[];
  sourceLabel: string;
  sourceDetail: string | null;
  place: string | null;
  phone: string | null;
  website: string | null;
  paymentTerms: string | null;
  health: { tone: Tone; label: string; reason: string };
  lastContact: string | null;
  contacts: Array<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    role: string | null;
    isPrimary: boolean;
  }>;
  domains: string[];
  aliases: Array<{ id: string; alias: string; sourceLabel: string; verified: boolean }>;
  money: Piece<MoneyView>;
  recovered: Piece<{ total: string; note: string } | null>;
  expected: Piece<Array<{ date: string; amount: string; reason: string }>>;
  timeline: Piece<TimelineEntry[]>;
  timelineKinds: Array<{ kind: string; label: string; count: number }>;
  open: {
    invoices: Piece<OpenInvoiceView[]>;
    commitments: Piece<OpenItemView[]>;
    cases: Piece<OpenItemView[]>;
    work: Piece<OpenItemView[]>;
  };
  documents: Piece<
    Array<{ id: string; title: string; dateLabel: string; kindLabel: string; href: string | null }>
  >;
  proposals: number;
  /** Preguntas listas para el chat, con el contexto del cliente. */
  ask: Array<{ label: string; href: string }>;
  /** El cobro por el chat: redactar el recordatorio. */
  collectHref: string;
}

/** Una propuesta agrupada, lista para decidir. */
export interface ProposalGroupView {
  key: string;
  ids: string[];
  clientId: string;
  clientName: string;
  kindLabel: string;
  methodLabel: string;
  why: string;
  evidence: string;
  count: number;
  samples: Array<{ label: string; date: string | null }>;
  rivals: string[];
  /** Ofrecer «recordar este nombre» (sólo cuando la evidencia es un nombre). */
  canLearnAlias: boolean;
}

export interface DuplicateView {
  keep: { id: string; name: string; nit: string | null };
  merge: { id: string; name: string; nit: string | null };
  why: string;
}

export interface BacklogView {
  counterparty: string;
  count: number;
  candidates: Array<{ id: string; name: string; why: string }>;
}

export interface AccountingConflictView {
  name: string;
  nit: string;
  system: string;
}
