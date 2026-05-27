import { betterAuth } from 'better-auth';
import { Pool } from 'pg';

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

const pool = new Pool({ connectionString });

export const auth = betterAuth({
  appName: 'Zipdev Agent',
  database: pool,
  baseURL:
    process.env.BETTER_AUTH_URL ?? process.env.APP_BASE_URL ?? 'http://localhost:3000',
  // Fallback only used at build/import time when env is unset; real signing
  // requires BETTER_AUTH_SECRET to be set at runtime.
  secret:
    process.env.BETTER_AUTH_SECRET ?? 'build-time-placeholder-do-not-use-at-runtime',
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
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
  },
});
