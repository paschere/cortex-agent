import { z } from 'zod';

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_DB_URL: z.string().url(),
  APP_BASE_URL: z.string().url(),
  SESSION_COOKIE_NAME: z.string().default('zipdev_session'),
  ALLOWED_EMAIL_DOMAIN: z.string().default('zipdev.com'),
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
