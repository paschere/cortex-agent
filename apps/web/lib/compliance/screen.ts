import 'server-only';
import type { AreaView, ComplianceScreen, PqrsView } from '@/components/compliance/types';
import {
  COMPLIANCE_AREA_LABEL,
  COMPLIANCE_ENTITY_TYPES,
  COMPLIANCE_ENTITY_TYPE_LABEL,
  COMPLIANCE_FREQUENCY_LABEL,
  COMPLIANCE_ITEM_STATUS_LABEL,
  COMPLIANCE_SECTORS,
  COMPLIANCE_SECTOR_LABEL,
  COMPLIANCE_SUPERVISORS,
  COMPLIANCE_SUPERVISOR_LABEL,
  LEGAL_CASE_ROLES,
  LEGAL_CASE_ROLE_LABEL,
  LEGAL_CASE_STATUSES,
  LEGAL_CASE_STATUS_LABEL,
  PQRS_CHANNELS,
  PQRS_CHANNEL_LABEL,
  PQRS_KINDS,
  PQRS_KIND_LABEL,
  PQRS_MATTERS,
  PQRS_MATTER_LABEL,
  PQRS_OPEN,
  PQRS_RESPONSE_TEMPLATES,
  PQRS_STATUS_LABEL,
  RAMA_JUDICIAL_URL,
  complianceProgressByArea,
  isComplianceItemOverdue,
  loadCompliance,
  parseJudicialRadicado,
  pqrsDeadline,
  pqrsDeadlinePhrase,
  pqrsMaxExtensionDate,
  pteeApplicability,
  ramaJudicialPrompt,
  rnbdApplicability,
  sagrilaftApplicability,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Lo que /cumplimiento pinta (0195), armado aquí. */

const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

export async function complianceScreen(
  db: SupabaseClient,
  input: {
    today: string;
    companyName: string;
    origin: string;
    canManage: boolean;
    team: Array<{ id: string; name: string }>;
  },
): Promise<ComplianceScreen> {
  const { today } = input;
  const snap = await loadCompliance(db, today);
  const names = new Map(input.team.map((t) => [t.id, t.name]));
  const progress = complianceProgressByArea(snap.items, today);
  const areas: AreaView[] = progress.map((p) => ({
    area: p.area,
    label: COMPLIANCE_AREA_LABEL[p.area],
    percent: p.percent,
    done: p.done,
    total: p.total,
    overdue: p.overdue,
    review: p.review,
    items: snap.items
      .filter((i) => i.area === p.area)
      .sort(
        (a, b) =>
          (a.status === 'no_aplica' ? 1 : 0) - (b.status === 'no_aplica' ? 1 : 0) ||
          (a.due_on ?? '9').localeCompare(b.due_on ?? '9'),
      )
      .map((i) => ({
        id: i.id,
        key: i.item_key,
        area: i.area,
        title: i.title,
        description: i.description,
        frequencyLabel: COMPLIANCE_FREQUENCY_LABEL[i.frequency],
        dueOn: i.due_on,
        dueNeedsConfirmation: i.due_needs_confirmation,
        overdue: isComplianceItemOverdue(i, today),
        legalBasis: i.legal_basis,
        applies: i.applies,
        applicabilityNote: i.applicability_note,
        status: i.status,
        statusLabel: COMPLIANCE_ITEM_STATUS_LABEL[i.status],
        evidenceUrl: i.evidence_url,
        evidenceNote: i.evidence_note,
        evidenceDocumentId: i.evidence_document_id,
        linkedHref: i.linked_href,
      })),
  }));
  const total = progress.reduce((s, p) => s + p.total, 0);
  const done = progress.reduce((s, p) => s + p.done, 0);

  const pqrs: PqrsView[] = snap.pqrs.map((p) => {
    const d = pqrsDeadline(p, today);
    const open = PQRS_OPEN.includes(p.status);
    const phrase = pqrsDeadlinePhrase(d.left);
    return {
      id: p.id,
      radicado: p.radicado,
      kind: p.kind,
      kindLabel: PQRS_KIND_LABEL[p.kind],
      matterLabel: PQRS_MATTER_LABEL[p.matter],
      channelLabel: PQRS_CHANNEL_LABEL[p.channel],
      subject: p.subject,
      body: p.body,
      requester: p.requester_name,
      requesterEmail: p.requester_email,
      requesterPhone: p.requester_phone,
      receivedOn: p.received_on,
      due: d.due,
      deadlineBasis: p.deadline_basis,
      left: d.left,
      deadlineText: open ? phrase.text : PQRS_STATUS_LABEL[p.status],
      deadlineTone: open ? phrase.tone : 'neutral',
      status: p.status,
      statusLabel: PQRS_STATUS_LABEL[p.status],
      open,
      assignedId: p.assigned_user_id,
      assigned: p.assigned_user_id ? (names.get(p.assigned_user_id) ?? null) : null,
      responseText: p.response_text,
      maxExtension: pqrsMaxExtensionDate(p.received_on, p.deadline_days),
      extended: !!p.extended_due_on,
    };
  });

  const profile = snap.profile;
  return {
    configured: !!profile,
    year: Number(today.slice(0, 4)),
    areas,
    overall: {
      percent: total ? Math.round((done / total) * 100) : 0,
      overdue: progress.reduce((s, p) => s + p.overdue, 0),
      review: progress.reduce((s, p) => s + p.review, 0),
    },
    pqrs,
    cases: snap.cases.map((c) => ({
      id: c.id,
      title: c.title,
      radicado: c.radicado,
      radicadoPretty: c.radicado ? (parseJudicialRadicado(c.radicado)?.pretty ?? c.radicado) : null,
      court: c.court,
      city: c.city,
      processType: c.process_type,
      roleLabel: LEGAL_CASE_ROLE_LABEL[c.role],
      role: c.role,
      counterparty: c.counterparty,
      status: c.status,
      statusLabel: LEGAL_CASE_STATUS_LABEL[c.status],
      lastActionOn: c.last_action_on,
      lastAction: c.last_action,
      nextHearingOn: c.next_hearing_on,
      nextHearing: c.next_hearing,
      lawyer: c.lawyer,
      lastCheckedVia: c.last_checked_via,
      checkPrompt: ramaJudicialPrompt(c.radicado, c.title),
    })),
    profile: {
      entityType: profile?.entityType ?? 'sas',
      size: profile?.size ?? '',
      revenueCop: str(profile?.revenueCop),
      assetsCop: str(profile?.assetsCop),
      figuresYear: str(profile?.figuresYear ?? Number(today.slice(0, 4)) - 1),
      internationalCop: str(profile?.internationalCop),
      stateContractsCop: str(profile?.stateContractsCop),
      supervisor: profile?.supervisor ?? 'ninguna',
      sectors: profile?.sectors ?? [],
      handlesPersonalData: profile?.handlesPersonalData ?? true,
      consumerFacing: profile?.consumerFacing ?? false,
      employees: str(profile?.employees),
      complianceOfficer: profile?.complianceOfficer ?? '',
      ownerUserId: profile?.ownerUserId ?? '',
      privacyPolicyUrl: profile?.privacyPolicyUrl ?? '',
      pqrsOwnerUserId: profile?.pqrsOwnerUserId ?? '',
    },
    applicability: profile
      ? [
          { label: 'Registro Nacional de Bases de Datos (SIC)', ...rnbdApplicability(profile) },
          { label: 'SAGRILAFT', ...sagrilaftApplicability(profile) },
          {
            label: 'Programa de Transparencia y Ética Empresarial (PTEE)',
            ...pteeApplicability(profile),
          },
        ].map((a) => ({ label: a.label, applies: a.applies, regime: a.regime, reasons: a.reasons }))
      : [],
    publicForm: {
      enabled: !!profile?.pqrsEnabled,
      url:
        profile?.pqrsEnabled && profile.pqrsToken
          ? `${input.origin}/pqrs/${profile.pqrsToken}`
          : null,
    },
    options: {
      entityTypes: COMPLIANCE_ENTITY_TYPES.map((v) => ({
        value: v,
        label: COMPLIANCE_ENTITY_TYPE_LABEL[v],
      })),
      supervisors: COMPLIANCE_SUPERVISORS.map((v) => ({
        value: v,
        label: COMPLIANCE_SUPERVISOR_LABEL[v],
      })),
      sectors: COMPLIANCE_SECTORS.map((v) => ({ value: v, label: COMPLIANCE_SECTOR_LABEL[v] })),
      team: input.team.map((t) => ({ value: t.id, label: t.name })),
      pqrsKinds: PQRS_KINDS.map((v) => ({ value: v, label: PQRS_KIND_LABEL[v] })),
      pqrsMatters: PQRS_MATTERS.map((v) => ({ value: v, label: PQRS_MATTER_LABEL[v] })),
      pqrsChannels: PQRS_CHANNELS.filter((c) => c !== 'formulario').map((v) => ({
        value: v,
        label: PQRS_CHANNEL_LABEL[v],
      })),
      caseRoles: LEGAL_CASE_ROLES.map((v) => ({ value: v, label: LEGAL_CASE_ROLE_LABEL[v] })),
      caseStatuses: LEGAL_CASE_STATUSES.map((v) => ({
        value: v,
        label: LEGAL_CASE_STATUS_LABEL[v],
      })),
    },
    responseTemplates: PQRS_RESPONSE_TEMPLATES.map((t) => ({
      key: t.key,
      label: t.label,
      text: t.text,
    })),
    companyName: input.companyName,
    ramaJudicialUrl: RAMA_JUDICIAL_URL,
    canManage: input.canManage,
  };
}
