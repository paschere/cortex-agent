# Local Setup Runbook

First-time setup guide for the `cortex-agent` monorepo.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | `20.17.0` | Use `.nvmrc` — run `nvm use` from the repo root |
| pnpm | `9.12.0` | Managed via Corepack — no separate install needed |
| Docker Desktop | Latest stable | Must be running before any `pnpm db:*` commands |
| Supabase CLI | `1.219.2` | Bundled as a root devDependency — no manual install required |

---

## 1. Clone and install

```bash
git clone <repo-url> cortex-agent
cd cortex-agent
nvm use          # pins Node 20.17.0 from .nvmrc
corepack enable  # activates pnpm@9.12.0 from package.json#packageManager
pnpm install     # installs all workspace dependencies
```

---

## 2. Environment file

Copy the example file and fill in every value:

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in each variable. See [`docs/operations/secrets.md`](./secrets.md) for the full list with descriptions. Key variables explained below:

| Variable | How to get it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Output of `pnpm db:start` — line `API URL` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Output of `pnpm db:start` — line `anon key` |
| `SUPABASE_SERVICE_ROLE_KEY` | Output of `pnpm db:start` — line `service_role key` |
| `SUPABASE_DB_URL` | Already pre-filled in `.env.example`: `postgresql://postgres:postgres@localhost:54322/postgres` |
| `BETTER_AUTH_SECRET` | Generate locally — see step 5 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud Console — see step 6 |
| `VOYAGE_API_KEY` | Voyage AI — [dashboard.voyageai.com](https://dashboard.voyageai.com). Optional locally: without it the Knowledge Base falls back to keyword search |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | Inngest dashboard — required for background jobs |
| `TOKEN_ENCRYPTION_KEY` | Generate locally — see secrets.md |
| `SENTRY_DSN` / `SENTRY_AUTH_TOKEN` | Sentry project settings — optional for local dev |

Vars prefixed `NEXT_PUBLIC_` are safe to expose in the browser. All others are server-only.

---

## 3. Start Supabase

Ensure Docker Desktop is running, then:

```bash
pnpm db:start
```

The first run pulls Docker images and takes approximately 60 seconds. Subsequent starts are faster.

Confirm all services are healthy:

```bash
pnpm exec supabase --workdir infra status
```

Expected output shows `API URL`, `DB URL`, `Studio URL`, `Inbucket URL`, and all services as `ACTIVE`.

Copy the `API URL`, `anon key`, and `service_role key` values into `.env.local`.

---

## 4. Apply migrations

Run all database migrations (creates all tables, RLS policies, pgvector indexes, and seed data):

```bash
pnpm db:reset
```

This applies all 14 migrations including the better-auth tables (`0011_better_auth.sql`) and MCP token tables (`0014_mcp_tokens.sql`).

---

## 5. Generate BETTER_AUTH_SECRET

```bash
openssl rand -base64 32
```

Copy the output into `.env.local` as `BETTER_AUTH_SECRET`. Also generate `TOKEN_ENCRYPTION_KEY` the same way — these must be separate values.

---

## 6. Google OAuth (user sign-in via SSO)

better-auth handles Google SSO. You need a Google OAuth 2.0 client for user sign-in.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials.
2. Create an **OAuth 2.0 Client ID** (Application type: Web application).
3. Under **Authorized redirect URIs**, add:
   ```
   http://localhost:3000/api/auth/callback/google
   ```
4. Copy the **Client ID** and **Client Secret** into `.env.local`:
   ```
   GOOGLE_CLIENT_ID=<your-client-id>
   GOOGLE_CLIENT_SECRET=<your-client-secret>
   ```

> **Note:** This is the integrations OAuth client (used for Gmail/Calendar/Sheets/Drive per-user connections). For production SSO configuration, see [`google-oauth-setup.md`](./google-oauth-setup.md).

Sign-up is open by default. To restrict a private deployment to a single email domain, set `ALLOWED_EMAIL_DOMAIN=example.com` in `.env.local`; leaving it empty lets anyone sign up.

---

## 7. Run the web app

```bash
pnpm --filter @cortex/web dev
```

Visit [http://localhost:3000](http://localhost:3000). You should be redirected to `/login`. Sign in with a Google account. On success you will land at `/chat`.

Alternatively, `pnpm dev` runs the full Turborepo dev pipeline (all apps in parallel), which also starts `apps/mcp` (Cloudflare Worker via wrangler) and `apps/desktop` (Tauri, requires Rust toolchain). Use the filtered form above to start only the web app.

---

## 8. Per-user integrations (Google Workspace, HubSpot)

After signing in, go to `/integrations` and click **Connect** next to each integration.

- **Google Workspace** — authorizes Gmail, Calendar, Drive, and Sheets access. Uses the `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` configured above.
- **HubSpot** — authorizes CRM read access. Requires `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` — see [`hubspot-oauth-setup.md`](./hubspot-oauth-setup.md).

---

## 9. Run tests

```bash
pnpm test
```

Runs Vitest across all packages and apps. Requires Supabase to be running for integration tests.

For end-to-end tests:

```bash
pnpm test:e2e
```

Requires `apps/web` to be built first (`pnpm --filter @cortex/web build`).

---

## 10. Build everything

```bash
pnpm build
```

Builds all packages and apps in dependency order via Turborepo. Output goes to `.next/` (web) and `dist/` (mcp, packages).

---

## 11. Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm db:start` fails or hangs | Docker Desktop is not running | Start Docker Desktop, then retry |
| Sign-in redirects back to `/login` with an error | `ALLOWED_EMAIL_DOMAIN` is set and the account is on another domain | Use an account on the configured domain, or clear the variable |
| `pnpm db:reset` fails | Missing Docker or corrupted local DB | Run `pnpm db:stop`, `pnpm db:start`, then retry `pnpm db:reset` |
| `0011_better_auth` migration error | Migration already partially applied | Run `pnpm exec supabase --workdir infra db reset` to wipe and reapply all |
| Build fails on `apps/web` with missing modules | Installed deps in wrong workspace | Run `pnpm install` from the **repo root**, not from inside `apps/web` |
| `BETTER_AUTH_SECRET` error on startup | Variable not set or empty | Generate with `openssl rand -base64 32` and add to `.env.local` |
| Wrangler errors when running `pnpm dev` | MCP app requires Cloudflare login | Use `pnpm --filter @cortex/web dev` to run only the web app |

---

## Stopping Supabase

When you are done:

```bash
pnpm db:stop
```

This stops all Supabase Docker containers without deleting data. To also delete local data, add the `--no-backup` flag:

```bash
pnpm exec supabase --workdir infra stop --no-backup
```
