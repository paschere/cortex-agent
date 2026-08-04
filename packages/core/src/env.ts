import { z } from 'zod';

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_DB_URL: z.string().url(),
  APP_BASE_URL: z.string().url(),
  SESSION_COOKIE_NAME: z.string().default('cortex_session'),
  // Empty = open signup (the SaaS default). Set a single domain to turn a
  // deployment back into a private, single-company instance.
  ALLOWED_EMAIL_DOMAIN: z.string().default(''),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),
  // HubSpot auth: either a workspace-wide Private App token (preferred) or the
  // per-user OAuth app trio. At least one must be configured for hubspot.* tools.
  HUBSPOT_PRIVATE_APP_TOKEN: z.string().min(1).optional(),
  HUBSPOT_CLIENT_ID: z.string().min(1).optional(),
  HUBSPOT_CLIENT_SECRET: z.string().min(1).optional(),
  HUBSPOT_REDIRECT_URI: z.string().url().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1),
  RATE_ESTIMATOR_URL: z.string().url(),
  RATE_ESTIMATOR_SERVICE_TOKEN: z.string().min(1),
  PAYROLL_API_URL: z.string().url().optional(),
  PAYROLL_API_TOKEN: z.string().min(1).optional(),
  // Optional so the app can boot before Inngest Cloud is wired; the
  // /api/inngest route 404s until INNGEST_SIGNING_KEY is provisioned.
  INNGEST_EVENT_KEY: z.string().min(1).optional(),
  INNGEST_SIGNING_KEY: z.string().min(1).optional(),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[A-Za-z0-9+/=]{44}$/, 'must be base64-encoded 32-byte key (exactly 44 chars)'),
  SENTRY_DSN: z.string().optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof schema>;
export const envSchema = schema;

/**
 * Domains that count as "inside the company", parsed from
 * `INTERNAL_EMAIL_DOMAINS` (comma-separated, e.g. `acme.com,acme.co.uk`).
 *
 * Empty by default, and empty deliberately means NOBODY is internal. Cortex is
 * multi-tenant, so there is no single company domain left to hardcode — and the
 * security classifier reads this list to decide whether a tool call is about to
 * push data out of the company. Guessing in the "internal" direction would
 * silently switch that check off, so an unconfigured deployment treats every
 * address as external: noisier, but it never lets an outbound send pass
 * unnoticed.
 *
 * Read from `process.env` on each call rather than cached at import time. It is
 * a string split, the cost is irrelevant next to the calls that consult it, and
 * it keeps the setting overridable per test without a module reset.
 */
export function internalEmailDomains(): string[] {
  return (process.env.INTERNAL_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter((d) => d.length > 0);
}

/**
 * True when an email address (or a bare domain) sits on a configured internal
 * domain. Subdomains count: `mail.acme.com` is inside `acme.com`.
 */
export function isInternalEmailDomain(emailOrDomain: string | null | undefined): boolean {
  if (!emailOrDomain) return false;
  const domains = internalEmailDomains();
  if (domains.length === 0) return false;
  const at = emailOrDomain.lastIndexOf('@');
  const domain = (at === -1 ? emailOrDomain : emailOrDomain.slice(at + 1))
    .trim()
    .toLowerCase()
    .replace(/[.,;>)\]]+$/, '');
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

let cached: Env | null = null;
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid env: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
  }
  cached = parsed.data;
  return cached;
}
