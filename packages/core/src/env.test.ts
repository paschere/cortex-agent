import { describe, it, expect } from 'vitest';
import { envSchema } from './env';

describe('envSchema', () => {
  it('rejects when keys are missing', () => {
    const res = envSchema.safeParse({});
    expect(res.success).toBe(false);
  });

  it('accepts a complete env', () => {
    const ok = envSchema.safeParse({
      NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'k',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
      SUPABASE_DB_URL: 'postgres://x/y',
      APP_BASE_URL: 'http://localhost:3000',
      GOOGLE_CLIENT_ID: 'g',
      GOOGLE_CLIENT_SECRET: 'g',
      GOOGLE_REDIRECT_URI: 'http://localhost:3000/cb',
      HUBSPOT_CLIENT_ID: 'h',
      HUBSPOT_CLIENT_SECRET: 'h',
      HUBSPOT_REDIRECT_URI: 'http://localhost:3000/cb',
      GOOGLE_GENERATIVE_AI_API_KEY: 'gem',
      RATE_ESTIMATOR_URL: 'https://r.x',
      RATE_ESTIMATOR_SERVICE_TOKEN: 't',
      INNGEST_EVENT_KEY: 'i',
      INNGEST_SIGNING_KEY: 'i',
      TOKEN_ENCRYPTION_KEY: 'a'.repeat(44),
    });
    expect(ok.success).toBe(true);
  });
});
