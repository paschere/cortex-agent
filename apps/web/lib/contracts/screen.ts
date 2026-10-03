import 'server-only';
import type {
  ContractDetailData,
  ContractListItem,
  ObligationItem,
  TemplateCard,
  WizardData,
} from '@/components/contracts/types';
import {
  CONTRACT_COUNTERPARTY_KIND_LABEL,
  CONTRACT_OBLIGATION_CATEGORY_LABEL,
  CONTRACT_STATUS_TONE,
  CONTRACT_TEMPLATES,
  type ContractObligationRow,
  type ContractStatus,
  adaptContract,
  adaptContractObligation,
  canSeeContract,
  getContract,
  isCompanyManager,
  listCompanyFacts,
  listContractEvents,
  listContractObligations,
  listContracts,
  loadContractNames,
  resolveContractTemplate,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Lo que /contratos pinta, armado aquí (0195): la lista con su vigencia y su
 * aviso previo, el asistente con las plantillas y las contrapartes, y la
 * ficha con el texto, las obligaciones y la línea de tiempo. Los contratos
 * laborales sólo los ve quien administra, quien los creó o su responsable.
 */

export async function contractsList(
  db: SupabaseClient,
  viewer: { userId: string },
  today: string,
): Promise<{ items: ContractListItem[]; hidden: number }> {
  const manager = await isCompanyManager(db, viewer.userId);
  const rows = await listContracts(db, { limit: 500 });
  const visible = rows.filter((r) => canSeeContract(r, { userId: viewer.userId, manager }));
  const [names, proposals] = await Promise.all([
    loadContractNames(db, visible),
    listContractObligations(db, { statuses: ['propuesta'], limit: 1000 }),
  ]);
  const pending = new Map<string, number>();
  for (const o of proposals) pending.set(o.contract_id, (pending.get(o.contract_id) ?? 0) + 1);
  const items = visible.map((r): ContractListItem => {
    const v = adaptContract(r, today, names);
    return {
      id: v.id,
      title: v.title,
      typeLabel: v.typeLabel,
      status: v.status,
      statusLabel: v.statusLabel,
      statusTone: CONTRACT_STATUS_TONE[v.status as ContractStatus],
      counterparty: v.counterparty,
      value: v.value,
      currency: v.currency,
      startOn: v.startOn,
      currentEnd: v.currentEnd,
      renewalLabel: v.renewalLabel,
      noticeDeadline: v.noticeDeadline,
      daysToNotice: v.daysToNotice,
      owner: v.owner,
      placeholders: v.placeholders,
      hasSignedCopy: v.hasSignedCopy,
      pendingObligations: pending.get(r.id) ?? 0,
    };
  });
  return { items, hidden: rows.length - visible.length };
}

export async function wizardData(db: SupabaseClient): Promise<WizardData> {
  const [clients, suppliers, team, facts] = await Promise.all([
    db.from('clients').select('id, name').order('name').limit(1000),
    db.from('suppliers').select('id, name').order('name').limit(1000),
    db.from('users').select('id, name, email').limit(500),
    listCompanyFacts(db).catch(() => []),
  ]);
  if (clients.error) throw clients.error;
  if (suppliers.error) throw suppliers.error;
  if (team.error) throw team.error;
  const labels = facts.map((f) => f.label.toLowerCase());
  const templates: TemplateCard[] = CONTRACT_TEMPLATES.map((t) => ({
    key: t.key,
    type: t.type,
    name: t.name,
    description: t.description,
    counterpartyKind: t.counterpartyKind,
    defaults: { renewal: t.defaults.renewal, noticeDays: t.defaults.noticeDays },
    fields: t.fields.map((f) => ({
      key: f.key,
      label: f.label,
      kind: f.kind,
      required: !!f.required,
      hint: f.hint ?? null,
      fromRecord: !!f.source,
    })),
    legalNotes: t.legalNotes,
  }));
  return {
    templates,
    clients: ((clients.data ?? []) as Array<{ id: string; name: string }>).map((c) => ({
      value: c.id,
      label: c.name,
    })),
    suppliers: ((suppliers.data ?? []) as Array<{ id: string; name: string }>).map((s) => ({
      value: s.id,
      label: s.name,
    })),
    team: ((team.data ?? []) as Array<{ id: string; name: string | null; email: string }>)
      .map((u) => ({ value: u.id, label: u.name?.trim() || u.email }))
      .sort((a, b) => a.label.localeCompare(b.label, 'es')),
    companyReady: {
      name: labels.some((l) => l.includes('razón social') || l.includes('razon social')),
      nit: labels.some((l) => l === 'nit' || l.startsWith('nit ')),
      representative: labels.some((l) => l.includes('representante')),
    },
  };
}

function obligationItem(o: ContractObligationRow, people: Map<string, string>): ObligationItem {
  const v = adaptContractObligation(o, people);
  return {
    id: v.id,
    partyLabel: v.partyLabel,
    responsible: v.responsible,
    categoryLabel: CONTRACT_OBLIGATION_CATEGORY_LABEL[o.category],
    description: v.description,
    dueOn: v.dueOn,
    recurrence: v.recurrence,
    recurrenceLabel: v.recurrenceLabel,
    dueNote: v.dueNote,
    penalty: v.penalty,
    quote: v.quote,
    status: v.status,
    statusLabel: v.statusLabel,
    confidence: v.confidence,
    reviewNote: v.reviewNote,
    owner: v.owner,
    ownerId: o.owner_user_id,
    watched: v.watched,
  };
}

export async function contractDetail(
  db: SupabaseClient,
  id: string,
  viewer: { userId: string },
  today: string,
): Promise<ContractDetailData | null> {
  const row = await getContract(db, id);
  if (!row) return null;
  const manager = await isCompanyManager(db, viewer.userId);
  if (!canSeeContract(row, { userId: viewer.userId, manager })) return null;
  const [obligations, events] = await Promise.all([
    listContractObligations(db, { contractId: id, limit: 300 }),
    listContractEvents(db, id),
  ]);
  const names = await loadContractNames(db, [
    row,
    ...obligations.map((o) => ({
      owner_user_id: o.owner_user_id,
      client_id: null,
      supplier_id: null,
      employee_user_id: null,
    })),
    ...events.map((e) => ({
      owner_user_id: e.actor_user_id,
      client_id: null,
      supplier_id: null,
      employee_user_id: null,
    })),
  ]);
  const v = adaptContract(row, today, names);
  const template = row.template_key
    ? await resolveContractTemplate(db, row.template_key).catch(() => null)
    : null;
  return {
    id: row.id,
    title: v.title,
    type: row.contract_type,
    typeLabel: v.typeLabel,
    status: v.status,
    statusLabel: v.statusLabel,
    statusTone: CONTRACT_STATUS_TONE[v.status as ContractStatus],
    counterparty: v.counterparty,
    counterpartyKindLabel: CONTRACT_COUNTERPARTY_KIND_LABEL[row.counterparty_kind],
    value: v.value,
    currency: v.currency,
    valueNote: v.valueNote,
    startOn: row.start_on,
    endOn: row.end_on,
    currentEnd: v.currentEnd,
    renewal: row.renewal,
    renewalLabel: v.renewalLabel,
    renewalMonths: row.renewal_months,
    noticeDays: row.notice_days,
    noticeDeadline: v.noticeDeadline,
    daysToNotice: v.daysToNotice,
    signedAt: row.signed_at,
    documentId: row.document_id,
    documentHref: row.document_id ? `/kb/documents/${row.document_id}` : null,
    bodyText: row.body_text,
    placeholders: row.placeholders,
    owner: v.owner,
    ownerId: row.owner_user_id,
    expirationHref: row.expiration_id ? '/documentos-vencen' : null,
    noticeWatched: !!row.notice_commitment_id,
    legalNotes: template?.template.legalNotes ?? [],
    editable: row.status === 'borrador' || row.status === 'en_revision',
    obligations: obligations.map((o) => obligationItem(o, names.people)),
    timeline: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      detail: e.detail,
      actor: e.actor_user_id ? (names.people.get(e.actor_user_id) ?? null) : null,
      at: e.created_at,
    })),
    pdfHref: `/api/contratos/${row.id}/archivo?formato=pdf`,
    docxHref: `/api/contratos/${row.id}/archivo?formato=docx`,
  };
}
