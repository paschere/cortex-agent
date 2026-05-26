import { describe, it, expect, beforeAll } from 'vitest';
import { encryptToken, decryptToken } from './crypto';

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'k';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  process.env.SUPABASE_DB_URL = 'postgres://x/y';
  process.env.APP_BASE_URL = 'http://localhost:3000';
  process.env.GOOGLE_CLIENT_ID = 'g';
  process.env.GOOGLE_CLIENT_SECRET = 'g';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/cb';
  process.env.HUBSPOT_CLIENT_ID = 'h';
  process.env.HUBSPOT_CLIENT_SECRET = 'h';
  process.env.HUBSPOT_REDIRECT_URI = 'http://localhost:3000/cb';
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'gem';
  process.env.RATE_ESTIMATOR_URL = 'https://r.x';
  process.env.RATE_ESTIMATOR_SERVICE_TOKEN = 't';
  process.env.INNGEST_EVENT_KEY = 'i';
  process.env.INNGEST_SIGNING_KEY = 'i';
});

describe('crypto', () => {
  it('round-trips', () => {
    const plain = 'ya29.test-access-token-xyz';
    const ct = encryptToken(plain);
    expect(ct).not.toEqual(plain);
    expect(decryptToken(ct)).toEqual(plain);
  });
  it('produces different ciphertexts for same plaintext (IV randomness)', () => {
    expect(encryptToken('x')).not.toEqual(encryptToken('x'));
  });
});
