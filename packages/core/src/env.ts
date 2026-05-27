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
  HUBSPOT_CLIENT_ID: z.string().min(1),
  HUBSPOT_CLIENT_SECRET: z.string().min(1),
  HUBSPOT_REDIRECT_URI: z.string().url(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1),
  RATE_ESTIMATOR_URL: z.string().url(),
  RATE_ESTIMATOR_SERVICE_TOKEN: z.string().min(1),
  INNGEST_EVENT_KEY: z.string().min(1),
  INNGEST_SIGNING_KEY: z.string().min(1),
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
