/**
 * Lo que la pantalla /contratos recibe ya armado del servidor
 * (lib/contracts/screen.ts). Sólo datos serializables: ningún componente de
 * cliente importa @cortex/agent-tools más que tipos.
 */

export interface Option {
  value: string;
  label: string;
}

export type ActionResult = { ok: true; note?: string; id?: string } | { ok: false; error: string };

export interface ContractListItem {
  id: string;
  title: string;
  typeLabel: string;
  status: string;
  statusLabel: string;
  statusTone: 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';
  counterparty: string | null;
  value: number | null;
  currency: string;
  startOn: string | null;
  currentEnd: string | null;
  renewalLabel: string;
  noticeDeadline: string | null;
  daysToNotice: number | null;
  owner: string | null;
  placeholders: number;
  hasSignedCopy: boolean;
  pendingObligations: number;
}

export interface TemplateCard {
  key: string;
  type: string;
  name: string;
  description: string;
  counterpartyKind: string;
  defaults: { renewal: string; noticeDays: number | null };
  fields: Array<{
    key: string;
    label: string;
    kind: string;
    required: boolean;
    hint: string | null;
    fromRecord: boolean;
  }>;
  legalNotes: string[];
}

export interface WizardData {
  templates: TemplateCard[];
  clients: Option[];
  suppliers: Option[];
  team: Option[];
  companyReady: { name: boolean; nit: boolean; representative: boolean };
}

export interface ObligationItem {
  id: string;
  partyLabel: string;
  responsible: string | null;
  categoryLabel: string;
  description: string;
  dueOn: string | null;
  recurrence: string;
  recurrenceLabel: string;
  dueNote: string | null;
  penalty: string | null;
  quote: string | null;
  status: string;
  statusLabel: string;
  confidence: string | null;
  reviewNote: string | null;
  owner: string | null;
  ownerId: string | null;
  watched: boolean;
}

export interface TimelineItem {
  id: string;
  kind: string;
  detail: string | null;
  actor: string | null;
  at: string;
}

export interface ContractDetailData {
  id: string;
  title: string;
  type: string;
  typeLabel: string;
  status: string;
  statusLabel: string;
  statusTone: 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';
  counterparty: string | null;
  counterpartyKindLabel: string;
  value: number | null;
  currency: string;
  valueNote: string | null;
  startOn: string | null;
  endOn: string | null;
  currentEnd: string | null;
  renewal: string;
  renewalLabel: string;
  renewalMonths: number | null;
  noticeDays: number | null;
  noticeDeadline: string | null;
  daysToNotice: number | null;
  signedAt: string | null;
  documentId: string | null;
  documentHref: string | null;
  bodyText: string | null;
  placeholders: string[];
  owner: string | null;
  ownerId: string | null;
  expirationHref: string | null;
  noticeWatched: boolean;
  legalNotes: string[];
  editable: boolean;
  obligations: ObligationItem[];
  timeline: TimelineItem[];
  pdfHref: string;
  docxHref: string;
}

export interface ContractActions {
  saveText(input: { id: string; text: string }): Promise<ActionResult>;
  sendToReview(input: { id: string }): Promise<ActionResult>;
  markSigned(input: {
    id: string;
    signedAt?: string | null;
    documentId?: string | null;
  }): Promise<ActionResult>;
  terminate(input: { id: string; terminatedOn: string; reason: string }): Promise<ActionResult>;
  saveTerm(input: {
    id: string;
    startOn: string | null;
    endOn: string | null;
    renewal: string;
    renewalMonths: number | null;
    noticeDays: number | null;
    valueAmount: number | null;
    ownerUserId: string | null;
  }): Promise<ActionResult>;
  extract(input: { id: string }): Promise<ActionResult>;
  confirmObligation(input: {
    id: string;
    dueOn?: string | null;
    ownerUserId?: string | null;
  }): Promise<ActionResult>;
  discardObligation(input: { id: string; reason?: string }): Promise<ActionResult>;
  completeObligation(input: { id: string }): Promise<ActionResult>;
  addObligation(input: {
    contractId: string;
    party: string;
    description: string;
    dueOn: string | null;
    recurrence: string;
  }): Promise<ActionResult>;
}
