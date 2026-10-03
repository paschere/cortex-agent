/**
 * Lo que /cumplimiento recibe ya armado (lib/compliance/screen.ts). Sólo
 * datos serializables.
 */

export interface Option {
  value: string;
  label: string;
}

export type ActionResult = { ok: true; note?: string; id?: string } | { ok: false; error: string };
export type Tone = 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';

export interface ChecklistItemView {
  id: string;
  key: string;
  area: string;
  title: string;
  description: string | null;
  frequencyLabel: string;
  dueOn: string | null;
  dueNeedsConfirmation: boolean;
  overdue: boolean;
  legalBasis: string | null;
  applies: 'si' | 'no' | 'revisar';
  applicabilityNote: string | null;
  status: string;
  statusLabel: string;
  evidenceUrl: string | null;
  evidenceNote: string | null;
  evidenceDocumentId: string | null;
  linkedHref: string | null;
}

export interface AreaView {
  area: string;
  label: string;
  percent: number;
  done: number;
  total: number;
  overdue: number;
  review: number;
  items: ChecklistItemView[];
}

export interface PqrsView {
  id: string;
  radicado: string;
  kind: string;
  kindLabel: string;
  matterLabel: string;
  channelLabel: string;
  subject: string;
  body: string;
  requester: string;
  requesterEmail: string | null;
  requesterPhone: string | null;
  receivedOn: string;
  due: string;
  deadlineBasis: string;
  left: number;
  deadlineText: string;
  deadlineTone: Tone;
  status: string;
  statusLabel: string;
  open: boolean;
  assignedId: string | null;
  assigned: string | null;
  responseText: string | null;
  maxExtension: string;
  extended: boolean;
}

export interface CaseView {
  id: string;
  title: string;
  radicado: string | null;
  radicadoPretty: string | null;
  court: string | null;
  city: string | null;
  processType: string | null;
  roleLabel: string;
  role: string;
  counterparty: string | null;
  status: string;
  statusLabel: string;
  lastActionOn: string | null;
  lastAction: string | null;
  nextHearingOn: string | null;
  nextHearing: string | null;
  lawyer: string | null;
  lastCheckedVia: string | null;
  checkPrompt: string;
}

export interface Applicability {
  label: string;
  applies: 'si' | 'no' | 'revisar';
  regime: string | null;
  reasons: string[];
}

export interface ProfileView {
  entityType: string;
  size: string;
  revenueCop: string;
  assetsCop: string;
  figuresYear: string;
  internationalCop: string;
  stateContractsCop: string;
  supervisor: string;
  sectors: string[];
  handlesPersonalData: boolean;
  consumerFacing: boolean;
  employees: string;
  complianceOfficer: string;
  ownerUserId: string;
  privacyPolicyUrl: string;
  pqrsOwnerUserId: string;
}

export interface ComplianceScreen {
  configured: boolean;
  year: number;
  areas: AreaView[];
  overall: { percent: number; overdue: number; review: number };
  pqrs: PqrsView[];
  cases: CaseView[];
  profile: ProfileView;
  applicability: Applicability[];
  publicForm: { enabled: boolean; url: string | null };
  options: {
    entityTypes: Option[];
    supervisors: Option[];
    sectors: Option[];
    team: Option[];
    pqrsKinds: Option[];
    pqrsMatters: Option[];
    pqrsChannels: Option[];
    caseRoles: Option[];
    caseStatuses: Option[];
  };
  responseTemplates: Array<{ key: string; label: string; text: string }>;
  companyName: string;
  ramaJudicialUrl: string;
  canManage: boolean;
}

export interface ComplianceActions {
  saveProfile(input: Record<string, unknown>): Promise<ActionResult>;
  markItem(input: {
    id: string;
    status: string;
    evidenceUrl?: string | null;
    evidenceNote?: string | null;
  }): Promise<ActionResult>;
  createPqrs(input: Record<string, unknown>): Promise<ActionResult>;
  respondPqrs(input: { id: string; text: string; close: boolean }): Promise<ActionResult>;
  updatePqrs(input: {
    id: string;
    status?: string;
    assignedUserId?: string | null;
    extendTo?: string | null;
    extensionReason?: string | null;
  }): Promise<ActionResult>;
  saveCase(input: Record<string, unknown>): Promise<ActionResult>;
  setPublicForm(input: { enabled: boolean; rotate?: boolean }): Promise<ActionResult>;
}
