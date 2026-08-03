import { betterAuth } from 'better-auth';
import { admin, organization, twoFactor } from 'better-auth/plugins';
import { Pool } from 'pg';
import { encryptToken } from '@cortex/core';
import { sendEmail } from './email';

/**
 * Server-side better-auth instance — Cortex SaaS edition.
 *
 * Auth surface:
 * - Email + password with verification and password reset (open signup —
 *   optionally restricted via ALLOWED_EMAIL_DOMAIN for private deployments).
 * - Google SSO (also provisions the Google toolbelt scopes in one shot).
 * - Organizations: multi-tenant workspaces with roles + email invitations.
 * - Admin: platform-level user management (ban, impersonate, list sessions).
 * - Two-factor: TOTP + backup codes.
 *
 * Notes on configuration (against better-auth v1.6.x):
 *
 * - `database` accepts a raw `pg.Pool` (or other PostgresPool); better-auth
 *   wraps it in a Kysely `PostgresDialect` internally. There is no top-level
 *   `tablePrefix` — tables are renamed individually via `<model>.modelName`
 *   (and per-plugin `schema` maps for plugin tables).
 *
 * - `databaseHooks` is at the top level. The user-create `after` hook syncs
 *   the better-auth user into `public.users` (linking by email). The `before`
 *   hook enforces ALLOWED_EMAIL_DOMAIN only when that env var is set.
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
//
// ssl.rejectUnauthorized=false: Supabase's pooler presents a cert signed by
// Supabase's own CA, which Node doesn't trust out of the box ("self-signed
// certificate in certificate chain"). Disabling verification HERE is scoped
// to this one DB connection — never set NODE_TLS_REJECT_UNAUTHORIZED=0,
// which kills TLS verification for every outbound request in the process.
// pg-connection-string treats sslmode=require as verify-full and its parsed
// ssl config wins over the explicit `ssl` option — so strip sslmode from the
// URL and pass the ssl object ourselves. Deterministic, no precedence games.
const isRemoteDb = /sslmode=/.test(connectionString);
const cleanConnectionString = connectionString.replace(/[?&]sslmode=[^&]*/g, (m) =>
  m.startsWith('?') ? '?' : '',
).replace(/\?&/, '?').replace(/\?$/, '');

const pool = new Pool({
  connectionString: cleanConnectionString,
  ...(isRemoteDb ? { ssl: { rejectUnauthorized: false } } : {}),
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

const baseURL =
  process.env.BETTER_AUTH_URL ?? process.env.APP_BASE_URL ?? 'http://localhost:3000';

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
  // Google Meet REST API v2 — conference records, participants, transcripts and
  // transcript entries (meetings.*). Read-only covers all four; the narrower
  // meetings.space.created only reaches spaces our own app created, which would
  // exclude every meeting booked from Google Calendar, so it is not requested.
  'https://www.googleapis.com/auth/meetings.space.readonly',
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
  appName: 'Cortex',
  database: pool,
  baseURL,
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
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    // Reset links land in the inbox (Resend) or in the server log when no
    // email provider is configured (local dev) — see lib/email.ts.
    sendResetPassword: async ({ user, url }) => {
      const result = await sendEmail({
        to: user.email,
        subject: 'Reset your Cortex password',
        text: `Hi ${user.name || 'there'},\n\nReset your Cortex password using this link (valid for 1 hour):\n\n${url}\n\nIf you didn't request this, you can safely ignore this email.`,
      });
      if (!result.sent) console.info(`[auth:dev] password reset link for ${user.email}: ${url}`);
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      const result = await sendEmail({
        to: user.email,
        subject: 'Verify your Cortex account',
        text: `Hi ${user.name || 'there'},\n\nConfirm your email address to activate your Cortex account:\n\n${url}\n\nIf you didn't sign up, you can safely ignore this email.`,
      });
      if (!result.sent) console.info(`[auth:dev] verification link for ${user.email}: ${url}`);
    },
  },
  session: {
    modelName: 'ba_session',
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // roll the expiry at most once a day
    // Short-lived signed cookie cache: cuts a DB round-trip from every
    // authenticated request without meaningfully extending revocation lag.
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  rateLimit: {
    // On by default in production; explicit so the limits are documented.
    window: 60,
    max: 100,
  },
  // Map default model names onto our prefixed tables.
  user: { modelName: 'ba_user' },
  account: { modelName: 'ba_account' },
  verification: { modelName: 'ba_verification' },
  plugins: [
    // Multi-tenant workspaces: each customer gets an organization; members
    // carry owner/admin/member roles; invitations go out by email.
    organization({
      schema: {
        organization: { modelName: 'ba_organization' },
        member: { modelName: 'ba_member' },
        invitation: { modelName: 'ba_invitation' },
      },
      organizationLimit: 5,
      membershipLimit: 100,
      invitationExpiresIn: 60 * 60 * 48, // 48 hours
      sendInvitationEmail: async (data) => {
        const inviteUrl = `${baseURL}/accept-invitation/${data.id}`;
        const result = await sendEmail({
          to: data.email,
          subject: `You've been invited to ${data.organization.name} on Cortex`,
          text: `${data.inviter.user.name || data.inviter.user.email} invited you to join "${data.organization.name}" on Cortex.\n\nAccept the invitation:\n\n${inviteUrl}\n\nThis invitation expires in 48 hours.`,
        });
        if (!result.sent) console.info(`[auth:dev] invitation link for ${data.email}: ${inviteUrl}`);
      },
    }),
    // Platform-level administration: list/ban users, revoke sessions,
    // impersonate for support. The first user to sign up is promoted to
    // platform admin by the user-create hook below.
    admin({ defaultRole: 'user' }),
    // TOTP two-factor with backup codes. Enrollment and challenge flows are
    // driven from the client via authClient.twoFactor.*.
    twoFactor({
      issuer: 'Cortex',
      schema: { twoFactor: { modelName: 'ba_two_factor' } },
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // SaaS default: open signup. Setting ALLOWED_EMAIL_DOMAIN turns a
          // deployment back into a single-company instance.
          const allowed = (process.env.ALLOWED_EMAIL_DOMAIN ?? '').trim().toLowerCase();
          if (allowed) {
            const domain = user.email.split('@')[1]?.toLowerCase();
            if (!domain || domain !== allowed) {
              throw new Error(`Only @${allowed} accounts are allowed`);
            }
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
          // First account on a fresh deployment becomes the platform admin
          // (better-auth admin plugin role, distinct from public.users.role).
          await pool.query(
            `update public.ba_user set role = 'admin'
             where id = $1
               and not exists (
                 select 1 from public.ba_user where role = 'admin' and id <> $1
               )`,
            [user.id],
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
