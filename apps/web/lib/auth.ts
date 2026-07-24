import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { encryptToken } from '@zipdev/core';

/**
 * Server-side better-auth instance.
 *
 * Notes on configuration (against better-auth v1.6.11):
 *
 * - `database` accepts a raw `pg.Pool` (or other PostgresPool); better-auth
 *   wraps it in a Kysely `PostgresDialect` internally. There is no top-level
 *   `tablePrefix` — tables are renamed individually via `<model>.modelName`.
 *
 * - `databaseHooks` is at the top level (confirmed against the v1.6.11
 *   `BetterAuthOptions` type).
 *
 * - The user-create `after` hook syncs the better-auth user into
 *   `public.users` (linking by email). The `before` hook enforces the
 *   `ALLOWED_EMAIL_DOMAIN` invariant before the user row is written.
 *
 * The Pool is constructed eagerly at module load, but `new Pool()` does NOT
 * open any connections — they're lazily established on first `.query()`.
 * The placeholder connection string is therefore safe at build time: imports
 * don't crash even when `SUPABASE_DB_URL` is unset. At runtime, env vars
 * must be set or any auth call will fail with a connection error.
 */

const connectionString =
  process.env.SUPABASE_DB_URL ??
  'postgresql://placeholder:placeholder@localhost:5432/placeholder';

// Serverless discipline: every lambda instance gets its own Pool, so the pool
// must stay tiny or Supabase's pooler client limit is exhausted as instances
// scale out (EMAXCONNSESSION). Pair with the TRANSACTION pooler (port 6543),
// which multiplexes many clients over few backend connections.
const pool = new Pool({
  connectionString,
  max: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// Runtime guard: refuse to serve requests in production with the placeholder
// secret. Skipped during `next build` (phase-production-build) so that page
// data collection doesn't fail when secrets aren't injected into the build
// environment — they only need to be present at runtime.
const PLACEHOLDER_SECRET = 'build-time-placeholder-do-not-use-at-runtime';
const resolvedSecret = process.env.BETTER_AUTH_SECRET ?? PLACEHOLDER_SECRET;
if (
  process.env.NODE_ENV === 'production' &&
  process.env.NEXT_PHASE !== 'phase-production-build' &&
  resolvedSecret === PLACEHOLDER_SECRET
) {
  throw new Error('BETTER_AUTH_SECRET must be set in production');
}

/**
 * Every Google scope the agent tools use. Requested at SSO login so one
 * sign-in provisions the whole toolbelt — no separate "Connect Google" step.
 * Mirror of the requiredScopes declared across packages/agent-tools.
 */
const GOOGLE_TOOL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/directory.readonly',
];

/**
 * Copy the Google OAuth tokens better-auth just stored (ba_account) into
 * public.integrations (encrypted), which is where the agent tools read from.
 * Best-effort: a sync failure must never break login.
 */
async function syncGoogleIntegration(account: {
  providerId: string;
  userId: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  scope?: string | null;
}): Promise<void> {
  if (account.providerId !== 'google' || !account.accessToken) return;
  try {
    const { rows } = await pool.query(
      `select u.id from public.users u
       join public.ba_user b on lower(b.email) = lower(u.email)
       where b.id = $1`,
      [account.userId],
    );
    const userId = rows[0]?.id as string | undefined;
    if (!userId) return;

    const scopes = (account.scope ?? '').split(/[\s,]+/).filter(Boolean);
    const expiresAt = account.accessTokenExpiresAt
      ? new Date(account.accessTokenExpiresAt).toISOString()
      : null;

    // Google only re-issues the refresh token on full consent; keep the
    // stored one when the new login didn't include it.
    await pool.query(
      `insert into public.integrations
         (user_id, provider, access_token_enc, refresh_token_enc, scopes, expires_at, updated_at)
       values ($1, 'google', $2, $3, $4, $5, now())
       on conflict (user_id, provider) do update set
         access_token_enc  = excluded.access_token_enc,
         refresh_token_enc = coalesce(excluded.refresh_token_enc, public.integrations.refresh_token_enc),
         scopes            = excluded.scopes,
         expires_at        = excluded.expires_at,
         updated_at        = now()`,
      [
        userId,
        encryptToken(account.accessToken),
        account.refreshToken ? encryptToken(account.refreshToken) : null,
        scopes,
        expiresAt,
      ],
    );
  } catch (err) {
    console.error('[auth] google integration sync failed', err);
  }
}

export const auth = betterAuth({
  appName: 'Zippy',
  database: pool,
  baseURL:
    process.env.BETTER_AUTH_URL ?? process.env.APP_BASE_URL ?? 'http://localhost:3000',
  // Fallback only used at build/import time when env is unset; real signing
  // requires BETTER_AUTH_SECRET to be set at runtime (enforced above).
  secret: resolvedSecret,
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      accessType: 'offline',
      prompt: 'select_account consent',
      scope: GOOGLE_TOOL_SCOPES,
    },
  },
  emailAndPassword: { enabled: false },
  // Map default model names onto our prefixed tables.
  user: { modelName: 'ba_user' },
  session: { modelName: 'ba_session' },
  account: { modelName: 'ba_account' },
  verification: { modelName: 'ba_verification' },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const domain = user.email.split('@')[1]?.toLowerCase();
          const allowed = (process.env.ALLOWED_EMAIL_DOMAIN ?? 'zipdev.com').toLowerCase();
          if (!domain || domain !== allowed) {
            throw new Error(`Only @${allowed} accounts are allowed`);
          }
          return { data: user };
        },
        after: async (user) => {
          // Sync to public.users. id is generated server-side via
          // gen_random_uuid() (see migration 0011); we link by email.
          await pool.query(
            `insert into public.users(email, name, role, google_sub)
             values (
               $1,
               $2,
               case
                 when not exists (select 1 from public.users) then 'org_admin'::user_role
                 else 'member'::user_role
               end,
               null
             )
             on conflict (email) do update
               set name = coalesce(excluded.name, public.users.name)`,
            [user.email, user.name],
          );
        },
      },
    },
    // Token sync: fires on first Google login (create) and every re-login
    // (update), keeping public.integrations fresh for the agent tools.
    account: {
      create: {
        after: async (account) => {
          await syncGoogleIntegration(account as Parameters<typeof syncGoogleIntegration>[0]);
        },
      },
      update: {
        after: async (account) => {
          await syncGoogleIntegration(account as Parameters<typeof syncGoogleIntegration>[0]);
        },
      },
    },
  },
});
