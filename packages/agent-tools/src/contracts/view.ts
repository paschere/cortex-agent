import { z } from 'zod';
import {
  CONTRACT_STATUS_LABEL,
  CONTRACT_TYPE_LABEL,
  type ContractRow,
  OBLIGATION_PARTY_LABEL,
  OBLIGATION_RECURRENCE_LABEL,
  OBLIGATION_STATUS_LABEL,
  type ObligationRow,
  RENEWAL_LABEL,
  contractTerm,
  deriveContractStatus,
} from './shape';

/**
 * Un contrato y sus obligaciones como los cuentan el chat y la pantalla: con
 * nombres en vez de ids, el estado de hoy y el aviso previo calculado. Puro.
 */

export const contractViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  typeLabel: z.string(),
  status: z.string(),
  statusLabel: z.string(),
  counterparty: z.string().nullable(),
  counterpartyKind: z.string(),
  value: z.number().nullable(),
  currency: z.string(),
  valueNote: z.string().nullable(),
  startOn: z.string().nullable(),
  endOn: z.string().nullable(),
  currentEnd: z.string().nullable(),
  renewal: z.string(),
  renewalLabel: z.string(),
  renewals: z.number(),
  noticeDays: z.number().nullable(),
  noticeDeadline: z.string().nullable(),
  daysToNotice: z.number().nullable(),
  daysToEnd: z.number().nullable(),
  owner: z.string().nullable(),
  placeholders: z.number(),
  hasSignedCopy: z.boolean(),
  link: z.string(),
});
export type ContractView = z.infer<typeof contractViewSchema>;

export function adaptContract(
  row: ContractRow,
  today: string,
  names: {
    people: Map<string, string>;
    clients: Map<string, string>;
    suppliers: Map<string, string>;
  },
): ContractView {
  const status = deriveContractStatus(row, today);
  const term = contractTerm(row, today);
  const counterparty =
    (row.client_id ? names.clients.get(row.client_id) : null) ??
    (row.supplier_id ? names.suppliers.get(row.supplier_id) : null) ??
    (row.employee_user_id ? names.people.get(row.employee_user_id) : null) ??
    row.counterparty_name;
  const signed = status === 'firmado' || status === 'vigente' || status === 'vencido';
  return {
    id: row.id,
    title: row.title,
    type: row.contract_type,
    typeLabel: CONTRACT_TYPE_LABEL[row.contract_type],
    status,
    statusLabel: CONTRACT_STATUS_LABEL[status],
    counterparty: counterparty ?? null,
    counterpartyKind: row.counterparty_kind,
    value: row.value_amount === null ? null : Number(row.value_amount),
    currency: row.currency,
    valueNote: row.value_note,
    startOn: row.start_on,
    endOn: row.end_on,
    currentEnd: term.currentEnd,
    renewal: row.renewal,
    renewalLabel: RENEWAL_LABEL[row.renewal],
    renewals: term.renewals,
    noticeDays: row.notice_days,
    noticeDeadline: signed && row.renewal !== 'ninguna' ? term.noticeDeadline : null,
    daysToNotice: signed && row.renewal !== 'ninguna' ? term.daysToNotice : null,
    daysToEnd: signed ? term.daysToEnd : null,
    owner: row.owner_user_id ? (names.people.get(row.owner_user_id) ?? null) : null,
    placeholders: row.placeholders.length,
    hasSignedCopy: !!row.document_id,
    link: `/contratos/${row.id}`,
  };
}

export const obligationViewSchema = z.object({
  id: z.string(),
  contractId: z.string(),
  party: z.string(),
  partyLabel: z.string(),
  responsible: z.string().nullable(),
  category: z.string(),
  description: z.string(),
  dueOn: z.string().nullable(),
  recurrence: z.string(),
  recurrenceLabel: z.string(),
  dueNote: z.string().nullable(),
  penalty: z.string().nullable(),
  quote: z.string().nullable(),
  status: z.string(),
  statusLabel: z.string(),
  confidence: z.string().nullable(),
  reviewNote: z.string().nullable(),
  owner: z.string().nullable(),
  watched: z.boolean(),
});
export type ObligationView = z.infer<typeof obligationViewSchema>;

export function adaptObligation(row: ObligationRow, people: Map<string, string>): ObligationView {
  return {
    id: row.id,
    contractId: row.contract_id,
    party: row.party,
    partyLabel: OBLIGATION_PARTY_LABEL[row.party],
    responsible: row.responsible_label,
    category: row.category,
    description: row.description,
    dueOn: row.due_on,
    recurrence: row.recurrence,
    recurrenceLabel: OBLIGATION_RECURRENCE_LABEL[row.recurrence],
    dueNote: row.due_note,
    penalty: row.penalty,
    quote: row.evidence_quote,
    status: row.status,
    statusLabel: OBLIGATION_STATUS_LABEL[row.status],
    confidence: row.confidence,
    reviewNote: row.review_note,
    owner: row.owner_user_id ? (people.get(row.owner_user_id) ?? null) : null,
    watched: !!row.commitment_id,
  };
}
