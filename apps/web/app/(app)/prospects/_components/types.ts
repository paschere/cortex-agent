/**
 * Plain shapes shared by the server page and the client components.
 *
 * Deliberately free of any `@cortex/agent-tools` import: client components pull
 * these in, and that package drags `node:crypto`/`node:dns` into the browser
 * bundle (see app/api/settings/preferences/schema.ts for the build break it
 * caused). Tools are resolved in actions.ts, which is server-only.
 */

/**
 * The whole workflow, and the same four values `growth.update_signal` accepts.
 * There is no fifth state: a signal is waiting, kept, dropped, or done.
 */
export type SignalStatus = "new" | "qualified" | "rejected" | "contacted";

/** How much the identified contact can be trusted. `inferred` is a guess. */
export type ContactConfidence = "found" | "inferred" | "unknown";

export interface Prospect {
  id: string;
  company: string;
  roleTitle: string;
  /** The job posting itself — the evidence anyone can check for themselves. */
  url: string;
  source: string;
  /** Why it matches what your team sells. */
  summary: string | null;
  region: string | null;
  status: SignalStatus;
  contactName: string | null;
  contactTitle: string | null;
  contactPath: string | null;
  contactConfidence: ContactConfidence | null;
  createdAt: string;
  /** When the current status was set, and by whom — null while still new. */
  reviewedAt: string | null;
  reviewerName: string | null;
}

/** What an Apollo company lookup gives back, trimmed to what the card shows. */
export interface CompanyProfile {
  apolloId: string | null;
  name: string | null;
  domain: string | null;
  website: string | null;
  linkedinUrl: string | null;
  industry: string | null;
  employees: number | null;
  location: string | null;
  foundedYear: number | null;
  annualRevenue: string | null;
  totalFunding: string | null;
  latestFundingStage: string | null;
  technologies: string[];
}

export interface NewsItem {
  headline: string | null;
  url: string | null;
  publisher: string | null;
  publishedAt: string | null;
  categories: string[];
}

/**
 * Every action returns this instead of throwing. A thrown server action reaches
 * the browser as an opaque "an error occurred" in production, and a card that
 * has just rolled back a status needs to say what actually went wrong.
 */
export type ActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };
