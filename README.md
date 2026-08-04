# Cortex

**Cortex** is a multi-tenant AI agent SaaS platform (formerly Zippy, an internal company agent). Teams sign up, create a workspace (organization), invite members, and get an AI super-agent with access to HubSpot CRM, Google Workspace, and a shared knowledge base — from a web chat interface, Claude Desktop (MCP), and a native desktop app.

Accounts are powered by [better-auth](https://better-auth.com): email + password (with verification and reset), Google SSO, multi-tenant organizations with role-based membership and email invitations, a platform admin layer (ban / impersonate / session management), and TOTP two-factor with backup codes.

---

## Architecture at a glance

```
cortex-agent/
├── apps/
│   ├── web        Next.js 15 (App Router) — chat UI, admin, Inngest background functions
│   ├── mcp        Cloudflare Worker — MCP connector for Claude Desktop
│   └── desktop    Tauri 2 wrapper — native desktop app (shell around apps/web)
├── packages/
│   ├── core           Shared types, env loader, crypto, logger
│   ├── agent-tools    Tool registry, HubSpot / Gmail / Calendar / Sheets / KB / Rate tools, runTool pipeline
│   └── agents         Agent definitions (Sales agent)
└── infra/
    └── supabase       Postgres migrations, RLS policies, pgvector indexes, seed data
```

**Data flow:** `apps/web` and `apps/mcp` both call into `packages/agent-tools` → `packages/agents` → external APIs (HubSpot, Google Workspace, rate-estimator service). All tool results are grounded through `packages/core` types. Auth tokens for per-user integrations are encrypted at rest in Supabase via `TOKEN_ENCRYPTION_KEY`.

---

## Tech stack

| Area | Technology |
|---|---|
| Language | TypeScript 5.7 |
| Runtime | Node 20.17.0 |
| Package manager | pnpm 9.12.0 (via Corepack) |
| Monorepo | Turborepo 2 |
| Web framework | Next.js 15 (App Router) |
| UI | React 19, Tailwind CSS, shadcn/ui (Radix UI), Framer Motion |
| AI / LLM | Vercel AI SDK 4, Claude Opus 5 (generation) + Gemini embeddings |
| Auth | better-auth — email/password + Google SSO, organizations (multi-tenant), admin, 2FA |
| Database | Supabase — Postgres 15 + pgvector + Auth + Storage |
| Background jobs | Inngest |
| MCP connector | Cloudflare Workers + Hono |
| Desktop | Tauri 2 |
| Observability | Sentry, OpenTelemetry |
| Testing | Vitest (unit), Playwright (e2e) |
| Linting / formatting | Biome |

---

## Quick start

For a detailed first-time setup guide see [`docs/operations/local-setup.md`](docs/operations/local-setup.md).

```bash
# 1. Install dependencies
nvm use && corepack enable && pnpm install

# 2. Configure environment
cp .env.example .env.local   # then fill in all values — see docs/operations/secrets.md

# 3. Start local Supabase (requires Docker Desktop running)
pnpm db:start

# 4. Apply all migrations
pnpm db:reset

# 5. Start the web app
pnpm --filter @cortex/web dev
# Visit http://localhost:3000 → create an account (or Google SSO) → /chat
```

`pnpm dev` (without filter) runs the full Turborepo pipeline — all apps in parallel. Use the filtered form above if you do not have the Rust toolchain (Tauri) or a Cloudflare login (wrangler) set up.

---

## Common scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Start all apps in dev mode (Turborepo) |
| `pnpm build` | Build all packages and apps in dependency order |
| `pnpm lint` | Run Biome lint across all packages |
| `pnpm typecheck` | TypeScript type-check all packages |
| `pnpm test` | Run Vitest unit tests across all packages |
| `pnpm test:e2e` | Run Playwright e2e tests |
| `pnpm format` | Auto-format with Biome |
| `pnpm db:start` | Boot local Supabase via Docker |
| `pnpm db:stop` | Stop local Supabase containers |
| `pnpm db:reset` | Wipe and reapply all migrations + seed data |
| `pnpm db:push` | Push pending migrations to a linked remote Supabase project |

---

## Project structure

```
cortex-agent/
├── apps/
│   ├── web/            Next.js 15 web app (chat UI, admin, API routes, Inngest functions)
│   ├── mcp/            Cloudflare Worker MCP connector (Claude Desktop integration)
│   └── desktop/        Tauri 2 native desktop wrapper
├── packages/
│   ├── core/           Shared types, env loader, crypto utilities, structured logger
│   ├── agent-tools/    Tool registry, integration connectors, runTool pipeline
│   └── agents/         Agent definitions (Sales agent system prompt + runtime)
├── infra/
│   └── supabase/       DB migrations (14 files), RLS policies, pgvector, seed data
├── docs/
│   ├── operations/     Setup runbooks, deploy guides, OAuth setup, secrets reference
│   └── superpowers/    Design specs and implementation plans
├── .env.example        Template for .env.local
├── package.json        Root scripts and devDependencies
├── pnpm-workspace.yaml Workspace definition
├── turbo.json          Turborepo task pipeline
└── biome.json          Linting and formatting config
```

---

## Links

| Resource | Path |
|---|---|
| Design spec | `docs/superpowers/specs/` |
| Implementation plans | `docs/superpowers/plans/` |
| Local setup runbook | `docs/operations/local-setup.md` |
| Secrets reference | `docs/operations/secrets.md` |
| Deploy runbook | `docs/operations/deploy.md` |
| MCP connector deploy | `docs/operations/mcp-deploy.md` |
| Claude Desktop install | `docs/operations/claude-desktop-install.md` |
| Google OAuth setup | `docs/operations/google-oauth-setup.md` |
| HubSpot OAuth setup | `docs/operations/hubspot-oauth-setup.md` |
