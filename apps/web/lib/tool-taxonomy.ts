/**
 * Human-readable taxonomy for the tool registry: family names, what each family
 * is for, and the id → label humanisation shared by the catalogue UI.
 *
 * PURE DATA ONLY — no `@cortex/agent-tools` import. This module is imported by
 * a CLIENT component, and pulling the registry in would drag `node:crypto`,
 * `node:dns` and pdf-parse's `fs` access into the browser bundle and break the
 * production build (same trap documented in
 * apps/web/app/api/settings/preferences/schema.ts). Anything that needs the
 * live registry must be resolved in a server component and passed down as
 * plain serialisable props.
 */

export type FamilyTone = 'primary' | 'emerald' | 'amber' | 'sky' | 'rose';

export interface FamilyMeta {
  /** Human name shown as the section title. */
  name: string;
  /** One line explaining what this family is for, in plain language. */
  blurb: string;
  tone: FamilyTone;
  /** Lucide icon name; the client maps it to a component. */
  icon: string;
}

/**
 * Keyed by the tool-id prefix (the part before the first dot). Families missing
 * here still render — `familyMeta` falls back to a title-cased key — but they
 * lose the blurb, so add new families as they are registered.
 */
export const FAMILY_META: Record<string, FamilyMeta> = {
  recruit: {
    name: 'Recruiting',
    blurb: 'The ATS — requisitions, candidates, matching, scoring and client presentations.',
    tone: 'primary',
    icon: 'UserSearch',
  },
  workable: {
    name: 'Workable',
    blurb: 'The external ATS the company sources from — jobs, applicants, stage moves and notes.',
    tone: 'primary',
    icon: 'ClipboardList',
  },
  presentations: {
    name: 'Presentations',
    blurb: 'Candidate PDFs prepared for clients, and the history of what was already sent.',
    tone: 'primary',
    icon: 'FileText',
  },
  people: {
    name: 'People Directory',
    blurb:
      'Name to email address, from the Google Workspace directory and personal contacts. Who works where is BambooHR.',
    tone: 'primary',
    icon: 'Users',
  },
  hubspot: {
    name: 'HubSpot',
    blurb: 'The CRM — companies, contacts, deals, pipeline health and activity logging.',
    tone: 'amber',
    icon: 'Building2',
  },
  growth: {
    name: 'Growth Signals',
    blurb: 'Buying signals from the market and the decision-makers behind them.',
    tone: 'amber',
    icon: 'TrendingUp',
  },
  apollo: {
    name: 'Apollo',
    blurb:
      'The prospecting database — find people by role and company, get verified work emails and firmographics, and see who is hiring or in the news.',
    tone: 'amber',
    icon: 'Rocket',
  },
  sales: {
    name: 'Sales',
    blurb: 'Client-facing proposal drafting, grounded in CRM and Brain Knowledge context.',
    tone: 'amber',
    icon: 'Handshake',
  },
  bamboo: {
    name: 'BambooHR',
    blurb:
      'The HR system of record — the roster, employment and job history, time off, hours logged, documents on file, and both the pay rate the company pays and the bill rate it charges.',
    tone: 'rose',
    icon: 'Contact',
  },
  payroll: {
    name: 'Payroll',
    blurb:
      'The separate payroll service: what people were actually paid, expenses, cost per client and cost projections.',
    tone: 'rose',
    icon: 'Wallet',
  },
  rate: {
    name: 'Rates',
    blurb:
      'What to quote for a role that does not exist yet. Rates actually being charged live in BambooHR.',
    tone: 'rose',
    icon: 'Calculator',
  },
  kb: {
    name: 'Brain Knowledge',
    blurb: "The company's memory — search internal documents and write new ones back.",
    tone: 'sky',
    icon: 'BookOpen',
  },
  meetings: {
    name: 'Meetings',
    blurb: 'Recorded transcripts and the briefings Cortex prepares before a call.',
    tone: 'sky',
    icon: 'Mic',
  },
  inbox: {
    name: 'Inbox',
    blurb: 'The daily priority list and digests Cortex assembles from everything it can see.',
    tone: 'sky',
    icon: 'Inbox',
  },
  gmail: {
    name: 'Gmail',
    blurb: 'Read the mailbox, search threads, prepare drafts and send approved ones.',
    tone: 'rose',
    icon: 'Mail',
  },
  gcal: {
    name: 'Google Calendar',
    blurb: 'Upcoming meetings, availability and event creation with invitations.',
    tone: 'sky',
    icon: 'CalendarDays',
  },
  gdrive: {
    name: 'Google Drive',
    blurb: 'Find and read documents stored in the shared Drive.',
    tone: 'emerald',
    icon: 'FolderOpen',
  },
  gsheets: {
    name: 'Google Sheets',
    blurb: 'Read ranges from shared spreadsheets and append rows to them.',
    tone: 'emerald',
    icon: 'Table2',
  },
  github: {
    name: 'GitHub',
    blurb: 'Repositories, issues, pull requests and delivery metrics for engineering.',
    tone: 'sky',
    icon: 'GitBranch',
  },
  linear: {
    name: 'Linear',
    blurb: 'Issues, projects, cycles and team workload for the engineering roadmap.',
    tone: 'sky',
    icon: 'SquareKanban',
  },
  slack: {
    name: 'Slack',
    blurb: 'Post messages into channels — including channels shared with clients.',
    tone: 'amber',
    icon: 'MessageSquare',
  },
  chat: {
    name: 'Google Chat',
    blurb: 'Direct messages and space posts Cortex sends to colleagues.',
    tone: 'emerald',
    icon: 'MessagesSquare',
  },
  pipeline: {
    name: 'Pipelines',
    blurb: 'Reusable playbooks anyone on the team can run from any surface.',
    tone: 'primary',
    icon: 'Workflow',
  },
  schedule: {
    name: 'Routines',
    blurb: 'Unattended jobs that keep running on a schedule until someone pauses them.',
    tone: 'primary',
    icon: 'AlarmClock',
  },
  vehicles: {
    name: 'Vehicles',
    blurb:
      'Plates worth keeping an eye on — SOAT and RTM validity from RUNT, traffic fines from SIMIT, and what has changed since the last look.',
    tone: 'emerald',
    icon: 'Car',
  },
  web: {
    name: 'Web',
    blurb: 'Public search and page scraping — the only family that touches nothing internal.',
    tone: 'emerald',
    icon: 'Globe',
  },
  security: {
    name: 'Security',
    blurb: "Read-only introspection over the guardrail's own decisions and recent events.",
    tone: 'rose',
    icon: 'ShieldCheck',
  },
  cortex: {
    name: 'Cortex',
    blurb: 'Meta tools the agent uses to orient itself inside the workspace.',
    tone: 'primary',
    icon: 'Sparkles',
  },
  format: {
    name: 'Formatting',
    blurb: 'Presentation helpers that shape data into something readable.',
    tone: 'emerald',
    icon: 'Type',
  },
};

/** Words that must not be title-cased naively. */
const ACRONYMS = new Set(['pr', 'prs', 'pdf', 'kb', 'crm', 'ats', 'id', 'ids', 'url', 'dm', 'ai']);

export function familyOf(toolId: string): string {
  const dot = toolId.indexOf('.');
  return dot === -1 ? toolId : toolId.slice(0, dot);
}

export function familyMeta(family: string): FamilyMeta {
  return (
    FAMILY_META[family] ?? {
      name: family.charAt(0).toUpperCase() + family.slice(1),
      blurb: 'Tools registered under this family.',
      tone: 'primary',
      icon: 'Wrench',
    }
  );
}

export function familyLabel(family: string): string {
  return familyMeta(family).name;
}

function titleWord(word: string): string {
  if (!word) return word;
  if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The action half of a tool id, humanised: 'hubspot.search_contacts' →
 * 'Search Contacts'. Used inside a family section, where the family is already
 * the heading.
 */
export function toolActionLabel(toolId: string): string {
  const dot = toolId.indexOf('.');
  const action = dot === -1 ? toolId : toolId.slice(dot + 1);
  return action.split(/[._]/).filter(Boolean).map(titleWord).join(' ');
}

/**
 * Fully-qualified human label: 'gcal.create_event' →
 * 'Google Calendar · Create Event'.
 *
 * Deliberately separate from `humanizeToolId` in lib/tool-labels.ts: that one
 * serves surfaces holding nothing but a raw id (approval emails, Chat DMs,
 * archived transcripts) and title-cases the family key as it stands
 * ('Gcal · Create Event'). The catalogue's whole job is to replace those keys
 * with the curated names in FAMILY_META, so it resolves the family here.
 */
export function qualifiedToolLabel(toolId: string): string {
  const family = familyOf(toolId);
  const action = toolActionLabel(toolId);
  const label = familyLabel(family);
  return action ? `${label} · ${action}` : label;
}

/** Same rules as matchPattern in @cortex/agent-tools: 'family.*' or exact id. */
export function matchesPattern(toolId: string, pattern: string): boolean {
  return pattern.endsWith('.*') ? toolId.startsWith(pattern.slice(0, -1)) : pattern === toolId;
}

export function matchesAnyPattern(toolId: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(toolId, p));
}

// ---------------------------------------------------------------------------
// Risk vocabulary (mirrors packages/agent-tools/src/security/policy.ts)
// ---------------------------------------------------------------------------

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type Sensitivity = 'public' | 'internal' | 'client' | 'pii' | 'financial';
export type BlastRadius = 'read' | 'internal_write' | 'external_send' | 'bulk';

export const RISK_ORDER: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

export const RISK_LABEL: Record<RiskLevel, string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
  critical: 'Critical',
};

export const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  public: 'Public data',
  internal: 'Internal data',
  client: 'Client data',
  pii: 'Personal data',
  financial: 'Compensation data',
};

export const BLAST_LABEL: Record<BlastRadius, string> = {
  read: 'Read-only',
  internal_write: 'Writes internally',
  external_send: 'Leaves the company',
  bulk: 'Bulk operation',
};

/** Human name for an integration provider a tool depends on. */
export const PROVIDER_LABEL: Record<string, string> = {
  google: 'Google',
  hubspot: 'HubSpot',
  github: 'GitHub',
  linear: 'Linear',
  slack: 'Slack',
  workable: 'Workable',
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}
