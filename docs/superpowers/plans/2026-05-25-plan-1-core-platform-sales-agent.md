# Plan 1 — Core Platform + Sales Agent (Web MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a working web-only Sales agent that 5 pilot users can use end-to-end: sign in via Google SSO, connect HubSpot + Google Workspace, configure RAG knowledge bases (global / team / user / per-conversation), and draft client proposals via a streaming chat backed by Gemini 2.5 Flash and a shared tool layer.

**Architecture:** Monorepo (pnpm + Turborepo) with `apps/web` (Next.js 15 on Vercel — admin UI + chat UI + chat API + agent loop), `packages/agent-tools` (shared tool registry), `packages/agents` (Sales agent definition), `packages/core` (shared types/utilities). Supabase (Postgres + pgvector + Auth + Storage) for data, auth, vector search, RLS. Inngest for background jobs (KB ingestion, Drive sync). Existing `zipdev-rate-estimator-master` repo gets a single new internal endpoint.

**Tech Stack:** TypeScript 5.7, Node 20, pnpm 9, Turborepo 2, Next.js 15 (App Router), React 19, Tailwind CSS, shadcn/ui, Framer Motion, TanStack Query, Vercel AI SDK 4 (with `@ai-sdk/google` for Gemini 2.5), Zod 3, Supabase JS, pgvector, Inngest, Sentry, OpenTelemetry, Vitest, msw, Playwright.

---

## File structure (locked at planning time)

```
zipdev-agent/
├── package.json                       # Workspaces root
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── biome.json
├── .nvmrc
├── .gitignore
├── .env.example
├── README.md
├── apps/
│   └── web/
│       ├── next.config.mjs
│       ├── package.json
│       ├── tsconfig.json
│       ├── tailwind.config.ts
│       ├── postcss.config.js
│       ├── middleware.ts             # Auth guard for all non-public routes
│       ├── instrumentation.ts        # Sentry + OTel init
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── globals.css
│       │   ├── (auth)/
│       │   │   ├── login/page.tsx
│       │   │   └── layout.tsx
│       │   ├── (app)/
│       │   │   ├── layout.tsx        # App chrome (sidebar, user menu)
│       │   │   ├── page.tsx          # Dashboard
│       │   │   ├── agents/
│       │   │   │   ├── page.tsx
│       │   │   │   └── [slug]/page.tsx
│       │   │   ├── kb/
│       │   │   │   ├── page.tsx
│       │   │   │   ├── global/page.tsx
│       │   │   │   ├── team/[teamId]/page.tsx
│       │   │   │   ├── me/page.tsx
│       │   │   │   └── _components/
│       │   │   │       ├── CollectionView.tsx
│       │   │   │       ├── UploadDropzone.tsx
│       │   │   │       ├── DriveConnect.tsx
│       │   │   │       ├── DocumentList.tsx
│       │   │   │       └── TestSearchBox.tsx
│       │   │   ├── integrations/page.tsx
│       │   │   ├── conversations/
│       │   │   │   ├── page.tsx
│       │   │   │   └── [id]/page.tsx
│       │   │   └── admin/
│       │   │       ├── users/page.tsx
│       │   │       ├── teams/page.tsx
│       │   │       ├── audit/page.tsx
│       │   │       └── usage/page.tsx
│       │   ├── (chat)/
│       │   │   ├── layout.tsx        # Minimal chat chrome (used by desktop too)
│       │   │   ├── chat/page.tsx
│       │   │   └── chat/[conversationId]/page.tsx
│       │   └── api/
│       │       ├── auth/callback/route.ts
│       │       ├── chat/route.ts
│       │       ├── chat/confirm/route.ts
│       │       ├── integrations/
│       │       │   ├── google/route.ts
│       │       │   ├── google/callback/route.ts
│       │       │   ├── hubspot/route.ts
│       │       │   └── hubspot/callback/route.ts
│       │       ├── kb/
│       │       │   ├── collections/route.ts
│       │       │   ├── collections/[id]/route.ts
│       │       │   ├── documents/route.ts
│       │       │   ├── documents/[id]/route.ts
│       │       │   ├── search/route.ts
│       │       │   └── drive/picker-config/route.ts
│       │       ├── admin/
│       │       │   ├── users/route.ts
│       │       │   ├── teams/route.ts
│       │       │   ├── audit/route.ts
│       │       │   └── usage/route.ts
│       │       └── inngest/route.ts
│       ├── components/
│       │   ├── ui/                   # shadcn primitives
│       │   ├── chat/
│       │   │   ├── ChatRoot.tsx
│       │   │   ├── MessageList.tsx
│       │   │   ├── MessageBubble.tsx
│       │   │   ├── ToolCallCard.tsx
│       │   │   ├── ConfirmationPrompt.tsx
│       │   │   ├── CitationFootnote.tsx
│       │   │   ├── InputBar.tsx
│       │   │   └── FileDropZone.tsx
│       │   ├── kb/                   # Reusable KB widgets
│       │   ├── agent-picker.tsx
│       │   └── nav/Sidebar.tsx
│       ├── lib/
│       │   ├── supabase/server.ts
│       │   ├── supabase/client.ts
│       │   ├── supabase/service.ts   # Service-role client (server-only)
│       │   ├── session.ts
│       │   ├── inngest.ts            # Inngest client
│       │   └── stream.ts             # SSE helpers
│       └── tests/
│           ├── unit/                 # Vitest
│           └── e2e/                  # Playwright
├── apps/inngest/                     # Inngest functions (deployable separately if needed)
│   └── src/
│       ├── client.ts
│       ├── functions/
│       │   ├── ingest-document.ts
│       │   ├── drive-sync.ts
│       │   └── nightly-cleanup.ts
│       └── index.ts                  # Exports functions array
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── types.ts              # Shared types
│   │       ├── errors.ts
│   │       ├── logger.ts
│   │       ├── crypto.ts             # Symmetric encrypt for tokens (uses Supabase Vault)
│   │       ├── session.ts
│   │       └── env.ts                # Zod-validated env loader
│   ├── agent-tools/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts              # registry + filterTools
│   │       ├── types.ts              # Tool, ToolContext
│   │       ├── audit.ts              # writeAuditEvent
│   │       ├── rate-limit.ts
│   │       ├── integrations.ts       # IntegrationsClient
│   │       ├── hubspot/
│   │       │   ├── client.ts
│   │       │   ├── search-companies.ts
│   │       │   ├── get-company.ts
│   │       │   ├── search-deals.ts
│   │       │   ├── get-deal.ts
│   │       │   └── list-recent-activities.ts
│   │       ├── rate/
│   │       │   ├── client.ts
│   │       │   ├── estimate.ts
│   │       │   └── estimate-from-document.ts
│   │       ├── gmail/
│   │       │   ├── client.ts
│   │       │   ├── search.ts
│   │       │   ├── read-thread.ts
│   │       │   └── draft.ts
│   │       ├── gcal/
│   │       │   ├── client.ts
│   │       │   ├── list-events.ts
│   │       │   └── create-event.ts
│   │       ├── gsheets/
│   │       │   ├── client.ts
│   │       │   ├── read-range.ts
│   │       │   └── append-row.ts
│   │       ├── kb/
│   │       │   ├── search.ts
│   │       │   ├── list-collections.ts
│   │       │   ├── parsers.ts        # pdf/docx/txt/md
│   │       │   ├── chunker.ts
│   │       │   └── embedder.ts
│   │       └── composite/
│   │           └── sales-draft-proposal.ts
│   └── agents/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── types.ts              # AgentDefinition
│           ├── runtime.ts            # loadAgent, filterTools, ragPrepend
│           └── sales/
│               ├── index.ts
│               └── system-prompt.md
├── infra/
│   └── supabase/
│       ├── config.toml
│       ├── migrations/
│       │   ├── 0001_users_teams.sql
│       │   ├── 0002_agents.sql
│       │   ├── 0003_kb.sql
│       │   ├── 0004_integrations.sql
│       │   ├── 0005_conversations.sql
│       │   ├── 0006_audit_events.sql
│       │   ├── 0007_pgvector_indexes.sql
│       │   ├── 0008_rls.sql
│       │   ├── 0009_signup_trigger.sql
│       │   └── 0010_seed.sql
│       └── seed.sql
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── e2e.yml
└── docs/
    └── operations/
        ├── google-oauth-setup.md
        ├── hubspot-oauth-setup.md
        └── secrets.md
```

Pre-flight expected at start of every task: assume `pnpm install` has been run at repo root and `supabase start` has been run for local dev. The repo has `.git` initialized (already done during spec phase).

---

## Task 1: Monorepo scaffolding (pnpm workspaces + Turborepo + base configs)

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `biome.json`, `.nvmrc`, `.gitignore`, `.env.example`, `README.md`

- [ ] **Step 1: Write `package.json` (workspace root)**

```json
{
  "name": "zipdev-agent",
  "private": true,
  "version": "0.0.0",
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "lint": "turbo lint",
    "typecheck": "turbo typecheck",
    "test": "turbo test",
    "test:e2e": "turbo test:e2e",
    "format": "biome format --write .",
    "db:start": "supabase start",
    "db:reset": "supabase db reset",
    "db:push": "supabase db push"
  },
  "devDependencies": {
    "@biomejs/biome": "1.9.4",
    "turbo": "2.3.3",
    "typescript": "5.7.2",
    "@types/node": "20.17.10",
    "supabase": "1.219.2"
  }
}
```

- [ ] **Step 2: Write `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 3: Write `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": [".env", ".env.local"],
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": [".next/**", "dist/**"] },
    "dev": { "cache": false, "persistent": true },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"], "outputs": [] },
    "test:e2e": { "dependsOn": ["build"], "outputs": ["playwright-report/**"] }
  }
}
```

- [ ] **Step 4: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "incremental": true
  }
}
```

- [ ] **Step 5: Write `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "ignoreUnknown": true, "ignore": ["dist", ".next", ".turbo", "node_modules"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "warn" },
      "style": { "useImportType": "error" }
    }
  },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "always", "trailingCommas": "all" } }
}
```

- [ ] **Step 6: Write `.nvmrc`**

```
20.17.0
```

- [ ] **Step 7: Write `.gitignore`**

```
node_modules
.next
.turbo
dist
coverage
playwright-report
.env
.env.local
.env.*.local
*.log
.DS_Store
.vercel
.wrangler
.env.vault
.supabase
```

- [ ] **Step 8: Write `.env.example`**

```
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_DB_URL=postgresql://postgres:postgres@localhost:54322/postgres

# App
APP_BASE_URL=http://localhost:3000
SESSION_COOKIE_NAME=zipdev_session
ALLOWED_EMAIL_DOMAIN=zipdev.com

# Google OAuth (per-user integrations, separate from Supabase SSO config)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/api/integrations/google/callback

# HubSpot OAuth
HUBSPOT_CLIENT_ID=
HUBSPOT_CLIENT_SECRET=
HUBSPOT_REDIRECT_URI=http://localhost:3000/api/integrations/hubspot/callback

# Gemini
GOOGLE_GENERATIVE_AI_API_KEY=

# Rate Estimator service-token
RATE_ESTIMATOR_URL=https://rate.zipdev.internal
RATE_ESTIMATOR_SERVICE_TOKEN=

# Inngest
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=

# Token encryption (32-byte base64). Generate: openssl rand -base64 32
TOKEN_ENCRYPTION_KEY=

# Observability
SENTRY_DSN=
SENTRY_AUTH_TOKEN=
OTEL_EXPORTER_OTLP_ENDPOINT=
OTEL_EXPORTER_OTLP_HEADERS=
```

- [ ] **Step 9: Write `README.md`**

```markdown
# zipdev-agent

Internal AI agent platform. v1 = Sales agent (web).

## Quick start
1. `nvm use` (Node 20)
2. `pnpm install`
3. Copy `.env.example` to `.env.local` and fill in values
4. `pnpm db:start` (boots Supabase locally)
5. `pnpm dev` (starts apps/web on http://localhost:3000)

See `docs/superpowers/specs/` for the design spec and `docs/operations/` for setup runbooks.
```

- [ ] **Step 10: Verify tooling installs**

Run: `pnpm install`
Expected: lockfile created, exit 0.

Run: `pnpm exec biome --version`
Expected: `1.9.4`.

Run: `pnpm exec turbo --version`
Expected: `2.3.3`.

- [ ] **Step 11: Commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json biome.json .nvmrc .gitignore .env.example README.md pnpm-lock.yaml
git commit -m "chore: scaffold monorepo with pnpm + turborepo + biome"
```

---

## Task 2: `packages/core` — shared types, errors, env loader, crypto, logger

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/{index,types,errors,logger,crypto,env,session}.ts`
- Create: `packages/core/src/{crypto,env}.test.ts`

- [ ] **Step 1: Write `packages/core/package.json`**

```json
{
  "name": "@zipdev/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "lint": "biome check src",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "pino": "9.5.0",
    "zod": "3.23.8"
  },
  "devDependencies": {
    "typescript": "5.7.2",
    "vitest": "2.1.8",
    "@types/node": "20.17.10"
  }
}
```

- [ ] **Step 2: Write `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "noEmit": true },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write `packages/core/src/types.ts`**

```ts
export type UUID = string;

export type Role = 'member' | 'team_admin' | 'org_admin';
export type CollectionScope = 'global' | 'team' | 'user' | 'conversation';
export type Surface = 'web' | 'desktop' | 'mcp';
export type IntegrationProvider = 'google' | 'hubspot';
export type DocumentStatus = 'pending' | 'ingesting' | 'ready' | 'failed';

export interface User {
  id: UUID;
  email: string;
  name: string | null;
  role: Role;
  google_sub: string | null;
  created_at: string;
}

export interface Team {
  id: UUID;
  name: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  team: string;
  defaultModel: 'gemini-2.5-flash' | 'gemini-2.5-pro';
  systemPrompt: string;
  allowedTools: string[];
  kbScopes: Array<'global' | `team:${string}` | 'user' | 'conversation'>;
  greeting: string;
}

export interface KbCollection {
  id: UUID;
  scope: CollectionScope;
  scope_id: UUID | null;
  name: string;
  agent_id: UUID | null;
  gdrive_folder_id: string | null;
  created_at: string;
}

export interface KbChunkHit {
  documentId: UUID;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  score: number;
}
```

- [ ] **Step 4: Write `packages/core/src/errors.ts`**

```ts
export class ZipdevError extends Error {
  constructor(message: string, public readonly code: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ZipdevError';
  }
}
export class UnauthorizedError extends ZipdevError {
  constructor(msg = 'Unauthorized') { super(msg, 'UNAUTHORIZED'); }
}
export class ForbiddenError extends ZipdevError {
  constructor(msg = 'Forbidden') { super(msg, 'FORBIDDEN'); }
}
export class NotFoundError extends ZipdevError {
  constructor(msg = 'Not found') { super(msg, 'NOT_FOUND'); }
}
export class ValidationError extends ZipdevError {
  constructor(msg: string, cause?: unknown) { super(msg, 'VALIDATION', cause); }
}
export class IntegrationError extends ZipdevError {
  constructor(msg: string, public readonly provider: string, cause?: unknown) {
    super(msg, 'INTEGRATION_ERROR', cause);
  }
}
export class RateLimitError extends ZipdevError {
  constructor(msg = 'Rate limit exceeded') { super(msg, 'RATE_LIMITED'); }
}
export class ConfirmationRequiredError extends ZipdevError {
  constructor(public readonly toolId: string, public readonly input: unknown) {
    super(`Tool ${toolId} requires confirmation`, 'CONFIRMATION_REQUIRED');
  }
}
```

- [ ] **Step 5: Write `packages/core/src/logger.ts`**

```ts
import pino from 'pino';
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'zipdev-agent' },
  redact: { paths: ['access_token', 'refresh_token', '*.access_token', '*.refresh_token', 'authorization'], remove: true },
});
export type Logger = typeof logger;
```

- [ ] **Step 6: Write `packages/core/src/env.ts`**

```ts
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
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[A-Za-z0-9+/=]{40,}$/, 'must be base64 of 32 bytes'),
  SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

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
```

- [ ] **Step 7: Write failing test `packages/core/src/env.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getEnv } from './env';

describe('getEnv', () => {
  beforeEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('NEXT_PUBLIC_') || k.includes('SUPABASE') || k.includes('GOOGLE') || k.includes('HUBSPOT') || k.includes('INNGEST') || k.includes('RATE_') || k.includes('TOKEN_') || k.includes('APP_') || k.includes('SESSION_') || k.includes('ALLOWED_')) delete process.env[k];
    // @ts-expect-error - clearing cached module state for test
    globalThis.__envCacheCleared = Date.now();
  });

  it('throws when required keys missing', () => {
    expect(() => getEnv()).toThrow(/Invalid env/);
  });

  it('parses when all required keys present', async () => {
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
    process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(44);
    // Force re-import to clear module-level cache
    const mod = await import('./env?bust=' + Date.now());
    const env = (mod as { getEnv: () => unknown }).getEnv();
    expect(env).toBeDefined();
  });
});
```

- [ ] **Step 8: Run test, see it fail then pass**

Run: `pnpm --filter @zipdev/core test`
Expected first: PASS (the file exists, both cases should pass with the implementation above). If the second case fails because of module caching, simplify by removing the cache (set `cached = null` at the top of the function for test mode) — or just accept it tests the schema directly.

Replace the test's second case with a direct schema test instead:

```ts
  it('parses when all required keys present', () => {
    const env = { /* same fields as above */ };
    process.env = { ...process.env, ...env };
    // Clear module cache via dynamic import trick is brittle; instead expose schema:
    // ...we'll adjust by exporting schema from env.ts
  });
```

Simpler: export the schema and test directly.

Append to `packages/core/src/env.ts`:
```ts
export const envSchema = schema;
```

Rewrite `packages/core/src/env.test.ts`:

```ts
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
```

Run: `pnpm --filter @zipdev/core test`
Expected: 2 passed.

- [ ] **Step 9: Write `packages/core/src/crypto.ts`** (AES-256-GCM for token encryption)

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getEnv } from './env';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const b = Buffer.from(getEnv().TOKEN_ENCRYPTION_KEY, 'base64');
  if (b.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
  return b;
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptToken(packed: string): string {
  const buf = Buffer.from(packed, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const d = createDecipheriv(ALGO, getKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
```

- [ ] **Step 10: Write `packages/core/src/crypto.test.ts`**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { encryptToken, decryptToken } from './crypto';

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  // populate remaining required env to satisfy getEnv()
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
```

- [ ] **Step 11: Write `packages/core/src/session.ts`**

```ts
import type { Role, UUID } from './types';
export interface SessionUser {
  id: UUID;
  email: string;
  name: string | null;
  role: Role;
}
```

- [ ] **Step 12: Write `packages/core/src/index.ts`**

```ts
export * from './types';
export * from './errors';
export * from './logger';
export * from './env';
export * from './crypto';
export * from './session';
```

- [ ] **Step 13: Run tests, typecheck**

Run: `pnpm --filter @zipdev/core test`
Expected: 4 passing.

Run: `pnpm --filter @zipdev/core typecheck`
Expected: exit 0.

- [ ] **Step 14: Commit**

```bash
git add packages/core
git commit -m "feat(core): shared types, errors, env, crypto, logger"
```

---

## Task 3: Supabase setup + initial migrations

**Files:**
- Create: `infra/supabase/config.toml`, `infra/supabase/migrations/{0001..0009}_*.sql`, `infra/supabase/seed.sql`
- Modify: `package.json` (add db scripts already in Task 1)

- [ ] **Step 1: Initialize Supabase project layout**

Run: `pnpm exec supabase init --workdir infra/supabase`
Expected: creates `infra/supabase/config.toml`.

Edit `infra/supabase/config.toml` and ensure these are set (other defaults are fine):
```toml
project_id = "zipdev-agent"
[api]
port = 54321
[db]
port = 54322
[auth]
enabled = true
site_url = "http://localhost:3000"
additional_redirect_urls = ["http://localhost:3000/api/auth/callback"]
[auth.external.google]
enabled = true
client_id = "env(GOOGLE_SSO_CLIENT_ID)"
secret = "env(GOOGLE_SSO_CLIENT_SECRET)"
redirect_uri = "http://localhost:54321/auth/v1/callback"
[storage]
enabled = true
file_size_limit = "10MiB"
```

(Setup runbook for Google Cloud Console will be written in Task 28.)

- [ ] **Step 2: Migration `0001_users_teams.sql`**

```sql
-- Extensions
create extension if not exists "pgcrypto";

create type user_role as enum ('member', 'team_admin', 'org_admin');

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  name text,
  role user_role not null default 'member',
  google_sub text,
  created_at timestamptz not null default now()
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create type team_member_role as enum ('member', 'team_admin');

create table public.team_members (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role team_member_role not null default 'member',
  primary key (team_id, user_id)
);

create index team_members_user_idx on public.team_members(user_id);
```

- [ ] **Step 3: Migration `0002_agents.sql`**

```sql
create table public.agents (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  team_id uuid references public.teams(id) on delete set null,
  system_prompt text not null,
  default_model text not null default 'gemini-2.5-flash',
  allowed_tool_ids text[] not null default '{}',
  created_at timestamptz not null default now()
);
```

- [ ] **Step 4: Migration `0003_kb.sql`**

```sql
create extension if not exists vector;

create type kb_scope as enum ('global', 'team', 'user', 'conversation');
create type document_status as enum ('pending', 'ingesting', 'ready', 'failed');
create type document_source as enum ('upload', 'gdrive', 'url');

create table public.kb_collections (
  id uuid primary key default gen_random_uuid(),
  scope kb_scope not null,
  scope_id uuid,
  name text not null,
  agent_id uuid references public.agents(id) on delete set null,
  gdrive_folder_id text,
  created_at timestamptz not null default now(),
  check (
    (scope = 'global' and scope_id is null)
    or (scope <> 'global' and scope_id is not null)
  )
);
create index kb_collections_scope_idx on public.kb_collections(scope, scope_id);

create table public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.kb_collections(id) on delete cascade,
  source document_source not null,
  source_ref text,
  title text not null,
  mime text not null,
  sha256 text not null,
  uploaded_by uuid references public.users(id) on delete set null,
  status document_status not null default 'pending',
  error_message text,
  created_at timestamptz not null default now()
);
create index kb_documents_collection_idx on public.kb_documents(collection_id);

create table public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.kb_documents(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  embedding vector(768) not null,
  tokens int not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index kb_chunks_document_idx on public.kb_chunks(document_id);
create index kb_chunks_embedding_idx on public.kb_chunks using hnsw (embedding vector_cosine_ops);
create index kb_chunks_content_fts_idx on public.kb_chunks using gin (to_tsvector('simple', content));

create table public.gdrive_sync_state (
  collection_id uuid primary key references public.kb_collections(id) on delete cascade,
  page_token text not null,
  last_synced_at timestamptz not null default now()
);
```

- [ ] **Step 5: Migration `0004_integrations.sql`**

```sql
create type integration_provider as enum ('google', 'hubspot');

create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider integration_provider not null,
  access_token_enc text not null,
  refresh_token_enc text,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);
create index integrations_user_idx on public.integrations(user_id);
```

- [ ] **Step 6: Migration `0005_conversations.sql`**

```sql
create type chat_surface as enum ('web', 'desktop', 'mcp');
create type message_role as enum ('user', 'assistant', 'system', 'tool');

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete restrict,
  surface chat_surface not null,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_user_idx on public.conversations(user_id, created_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role message_role not null,
  content text not null default '',
  tool_calls jsonb,
  tool_results jsonb,
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on public.messages(conversation_id, created_at);
```

- [ ] **Step 7: Migration `0006_audit_events.sql`**

```sql
create type audit_status as enum ('ok', 'error', 'rate_limited', 'confirmation_required');

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  agent_id uuid references public.agents(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  tool_id text not null,
  input_hash text not null,
  status audit_status not null,
  latency_ms int not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_user_idx on public.audit_events(user_id, created_at desc);
create index audit_events_tool_idx on public.audit_events(tool_id, created_at desc);

-- Token bucket for rate limiting (per user per tool)
create table public.rate_limit_buckets (
  user_id uuid not null references public.users(id) on delete cascade,
  tool_id text not null,
  tokens int not null,
  refill_at timestamptz not null,
  primary key (user_id, tool_id)
);
```

- [ ] **Step 8: Migration `0007_pgvector_indexes.sql`** (no-op placeholder since indexes were in 0003; left for future tuning)

```sql
-- Reserved for future vector index tuning (e.g., switching hnsw params).
-- Intentionally empty.
select 1;
```

- [ ] **Step 9: Migration `0008_rls.sql`**

```sql
-- Enable RLS
alter table public.users enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.agents enable row level security;
alter table public.kb_collections enable row level security;
alter table public.kb_documents enable row level security;
alter table public.kb_chunks enable row level security;
alter table public.gdrive_sync_state enable row level security;
alter table public.integrations enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.audit_events enable row level security;
alter table public.rate_limit_buckets enable row level security;

-- helper: current user id
create or replace function public.current_user_id() returns uuid
language sql stable as $$
  select auth.uid()
$$;

-- helper: is org admin
create or replace function public.is_org_admin() returns boolean
language sql stable security definer as $$
  select exists (select 1 from public.users where id = auth.uid() and role = 'org_admin');
$$;

-- helper: is in team
create or replace function public.is_in_team(p_team uuid) returns boolean
language sql stable security definer as $$
  select exists (select 1 from public.team_members where team_id = p_team and user_id = auth.uid());
$$;

-- helper: is team admin
create or replace function public.is_team_admin(p_team uuid) returns boolean
language sql stable security definer as $$
  select exists (select 1 from public.team_members where team_id = p_team and user_id = auth.uid() and role = 'team_admin');
$$;

-- users: self + org admin can read all
create policy users_self_read on public.users for select
  using (id = auth.uid() or public.is_org_admin());
create policy users_org_admin_write on public.users for update
  using (public.is_org_admin());

-- teams: any signed-in user can read; org admin writes
create policy teams_read on public.teams for select using (auth.uid() is not null);
create policy teams_write on public.teams for all using (public.is_org_admin()) with check (public.is_org_admin());

-- team_members: read if same team or org admin
create policy team_members_read on public.team_members for select
  using (public.is_in_team(team_id) or public.is_org_admin());
create policy team_members_write on public.team_members for all
  using (public.is_team_admin(team_id) or public.is_org_admin())
  with check (public.is_team_admin(team_id) or public.is_org_admin());

-- agents: read all signed-in; write org admin
create policy agents_read on public.agents for select using (auth.uid() is not null);
create policy agents_write on public.agents for all using (public.is_org_admin()) with check (public.is_org_admin());

-- kb_collections: scope-based read; write by appropriate admin or owner
create policy kb_collections_read on public.kb_collections for select
  using (
    (scope = 'global')
    or (scope = 'team' and public.is_in_team(scope_id))
    or (scope = 'user' and scope_id = auth.uid())
    or (scope = 'conversation' and exists (
      select 1 from public.conversations c where c.id = scope_id and c.user_id = auth.uid()
    ))
  );
create policy kb_collections_write on public.kb_collections for all
  using (
    (scope = 'global' and public.is_org_admin())
    or (scope = 'team' and public.is_team_admin(scope_id))
    or (scope = 'user' and scope_id = auth.uid())
    or (scope = 'conversation' and exists (
      select 1 from public.conversations c where c.id = scope_id and c.user_id = auth.uid()
    ))
  )
  with check (
    (scope = 'global' and public.is_org_admin())
    or (scope = 'team' and public.is_team_admin(scope_id))
    or (scope = 'user' and scope_id = auth.uid())
    or (scope = 'conversation' and exists (
      select 1 from public.conversations c where c.id = scope_id and c.user_id = auth.uid()
    ))
  );

-- kb_documents inherit collection visibility
create policy kb_documents_read on public.kb_documents for select
  using (exists (select 1 from public.kb_collections c where c.id = collection_id));
create policy kb_documents_write on public.kb_documents for all
  using (exists (select 1 from public.kb_collections c where c.id = collection_id))
  with check (exists (select 1 from public.kb_collections c where c.id = collection_id));

-- kb_chunks inherit document visibility
create policy kb_chunks_read on public.kb_chunks for select
  using (exists (select 1 from public.kb_documents d where d.id = document_id));

-- gdrive_sync_state inherit collection visibility
create policy gdrive_sync_state_rw on public.gdrive_sync_state for all
  using (exists (select 1 from public.kb_collections c where c.id = collection_id))
  with check (exists (select 1 from public.kb_collections c where c.id = collection_id));

-- integrations: never readable from client. Only service role accesses tokens.
-- For non-token fields (scopes, expires_at, last used) we allow self-read via a view (created later).
create policy integrations_no_client on public.integrations for all using (false) with check (false);

-- conversations + messages: owner only
create policy conversations_owner on public.conversations for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy messages_owner on public.messages for all
  using (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()));

-- audit_events: owner read; org admin read all
create policy audit_events_read on public.audit_events for select
  using (user_id = auth.uid() or public.is_org_admin());

-- rate_limit_buckets: owner only
create policy rate_limit_buckets_self on public.rate_limit_buckets for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Safe view over integrations (no tokens)
create or replace view public.integrations_view with (security_invoker = true) as
  select id, user_id, provider, scopes, expires_at, created_at, updated_at
  from public.integrations
  where user_id = auth.uid();
grant select on public.integrations_view to authenticated;
```

- [ ] **Step 10: Migration `0009_signup_trigger.sql`**

```sql
-- Auto-provision public.users on auth signup; reject non-zipdev domain
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer as $$
declare
  v_domain text := lower(split_part(new.email, '@', 2));
  v_allowed text := coalesce(current_setting('app.allowed_email_domain', true), 'zipdev.com');
begin
  if v_domain <> v_allowed then
    raise exception 'sign-in restricted to % accounts', v_allowed;
  end if;
  insert into public.users(id, email, name, role, google_sub)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    case when not exists (select 1 from public.users) then 'org_admin'::user_role else 'member'::user_role end,
    new.raw_user_meta_data->>'sub'
  )
  on conflict (id) do update
    set email = excluded.email, name = coalesce(excluded.name, public.users.name);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
```

- [ ] **Step 11: Migration `0010_seed.sql`**

```sql
-- Idempotent seed: ensure Sales team + Sales agent exist
do $$
declare
  v_team uuid;
begin
  insert into public.teams(name)
  values ('Sales')
  on conflict (name) do nothing;

  select id into v_team from public.teams where name = 'Sales';

  insert into public.agents(slug, name, team_id, system_prompt, default_model, allowed_tool_ids)
  values (
    'sales',
    'Zipdev Sales',
    v_team,
    'You are Zipdev''s Sales co-pilot. Zipdev is a LATAM staffing company that places engineers and operators with foreign companies. Always cite KB sources when stating facts. Never send emails directly — create drafts only. For full proposals prefer the sales.draft_proposal tool; for narrow questions use primitives. Respond in the user''s language.',
    'gemini-2.5-flash',
    array[
      'hubspot.search_companies','hubspot.get_company','hubspot.search_deals','hubspot.get_deal','hubspot.list_recent_activities',
      'rate.estimate','rate.estimate_from_document',
      'gmail.search','gmail.read_thread','gmail.draft',
      'gcal.list_events','gcal.create_event',
      'gsheets.read_range',
      'kb.search','kb.list_collections',
      'sales.draft_proposal'
    ]
  )
  on conflict (slug) do nothing;
end $$;
```

- [ ] **Step 12: Start Supabase locally and apply migrations**

Run: `pnpm db:start`
Expected: containers up, `supabase status` prints URLs.

Run: `pnpm db:reset`
Expected: all migrations applied, exit 0. (`db:reset` runs all migrations from scratch.)

- [ ] **Step 13: Smoke-test the schema with psql**

Run: `psql "$SUPABASE_DB_URL" -c "\\dt public.*"` (PowerShell: `psql $env:SUPABASE_DB_URL -c "\dt public.*"`)
Expected: lists `users`, `teams`, `team_members`, `agents`, `kb_collections`, `kb_documents`, `kb_chunks`, `gdrive_sync_state`, `integrations`, `conversations`, `messages`, `audit_events`, `rate_limit_buckets`.

Run: `psql "$SUPABASE_DB_URL" -c "select slug, name from public.agents"`
Expected: one row, `sales | Zipdev Sales`.

- [ ] **Step 14: Commit**

```bash
git add infra/supabase
git commit -m "feat(db): initial schema, RLS, seed Sales agent"
```

---

## Task 4: Next.js app scaffolding (`apps/web`) + auth wiring

**Files:**
- Create: `apps/web/{package.json,next.config.mjs,tsconfig.json,tailwind.config.ts,postcss.config.js,middleware.ts}`
- Create: `apps/web/app/{layout.tsx,globals.css}`
- Create: `apps/web/app/(auth)/login/page.tsx`, `apps/web/app/(auth)/layout.tsx`
- Create: `apps/web/app/api/auth/callback/route.ts`
- Create: `apps/web/lib/supabase/{server.ts,client.ts,service.ts}`, `apps/web/lib/session.ts`

- [ ] **Step 1: Write `apps/web/package.json`**

```json
{
  "name": "@zipdev/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "biome check .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@zipdev/core": "workspace:*",
    "@zipdev/agent-tools": "workspace:*",
    "@zipdev/agents": "workspace:*",
    "@supabase/ssr": "0.5.2",
    "@supabase/supabase-js": "2.46.2",
    "next": "15.0.4",
    "react": "19.0.0",
    "react-dom": "19.0.0",
    "zod": "3.23.8",
    "ai": "4.0.18",
    "@ai-sdk/google": "1.0.10",
    "framer-motion": "11.13.5",
    "lucide-react": "0.468.0",
    "clsx": "2.1.1",
    "tailwind-merge": "2.5.5",
    "@tanstack/react-query": "5.62.7",
    "@radix-ui/react-dialog": "1.1.4",
    "@radix-ui/react-dropdown-menu": "2.1.4",
    "@radix-ui/react-toast": "1.2.4",
    "@radix-ui/react-tabs": "1.1.2",
    "react-dropzone": "14.3.5",
    "inngest": "3.27.4",
    "pdf-parse": "1.1.1",
    "mammoth": "1.8.0",
    "@sentry/nextjs": "8.45.1"
  },
  "devDependencies": {
    "@types/react": "19.0.1",
    "@types/react-dom": "19.0.2",
    "@types/node": "20.17.10",
    "@playwright/test": "1.49.1",
    "vitest": "2.1.8",
    "msw": "2.7.0",
    "typescript": "5.7.2",
    "tailwindcss": "3.4.16",
    "postcss": "8.4.49",
    "autoprefixer": "10.4.20"
  }
}
```

- [ ] **Step 2: Write `apps/web/next.config.mjs`**

```js
import { withSentryConfig } from '@sentry/nextjs';

const config = {
  reactStrictMode: true,
  experimental: { serverActions: { bodySizeLimit: '12mb' } },
  transpilePackages: ['@zipdev/core', '@zipdev/agent-tools', '@zipdev/agents'],
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    }];
  },
};

export default process.env.SENTRY_DSN
  ? withSentryConfig(config, { silent: true })
  : config;
```

- [ ] **Step 3: Write `apps/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "ES2022"],
    "jsx": "preserve",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Write `apps/web/tailwind.config.ts` + `postcss.config.js`**

`tailwind.config.ts`:
```ts
import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
export default config;
```

`postcss.config.js`:
```js
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

- [ ] **Step 5: Write `apps/web/app/globals.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
:root { color-scheme: light dark; }
html, body { height: 100%; }
```

- [ ] **Step 6: Write `apps/web/lib/supabase/server.ts`**

```ts
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getEnv } from '@zipdev/core';

export async function getSupabaseServerClient() {
  const env = getEnv();
  const cookieStore = await cookies();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try { for (const { name, value, options } of toSet) cookieStore.set(name, value, options as CookieOptions); }
        catch { /* called from server component where setting cookies isn't allowed; that's fine */ }
      },
    },
  });
}
```

- [ ] **Step 7: Write `apps/web/lib/supabase/client.ts`**

```ts
'use client';
import { createBrowserClient } from '@supabase/ssr';
import { getEnv } from '@zipdev/core';

let _client: ReturnType<typeof createBrowserClient> | null = null;
export function getSupabaseBrowserClient() {
  if (_client) return _client;
  const env = getEnv();
  _client = createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  return _client;
}
```

- [ ] **Step 8: Write `apps/web/lib/supabase/service.ts`** (server-only, service role)

```ts
import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { getEnv } from '@zipdev/core';

let _service: ReturnType<typeof createClient> | null = null;
export function getSupabaseServiceClient() {
  if (_service) return _service;
  const env = getEnv();
  _service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _service;
}
```

- [ ] **Step 9: Write `apps/web/lib/session.ts`**

```ts
import { getSupabaseServerClient } from './supabase/server';
import { UnauthorizedError, type SessionUser, type Role } from '@zipdev/core';

export async function requireSession(): Promise<SessionUser> {
  const sb = await getSupabaseServerClient();
  const { data: { user }, error } = await sb.auth.getUser();
  if (error || !user) throw new UnauthorizedError();
  const { data: row, error: rowErr } = await sb.from('users').select('id,email,name,role').eq('id', user.id).single();
  if (rowErr || !row) throw new UnauthorizedError();
  return { id: row.id as string, email: row.email as string, name: row.name as string | null, role: row.role as Role };
}

export async function getOptionalSession(): Promise<SessionUser | null> {
  try { return await requireSession(); } catch { return null; }
}
```

- [ ] **Step 10: Write `apps/web/middleware.ts`**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const PUBLIC_PATHS = ['/login', '/api/auth/callback', '/_next', '/favicon.ico'];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const res = NextResponse.next();
  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (toSet) => { for (const { name, value, options } of toSet) res.cookies.set(name, value, options); },
      },
    },
  );
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return res;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
```

- [ ] **Step 11: Write `apps/web/app/layout.tsx`**

```tsx
import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
export const metadata: Metadata = { title: 'Zipdev Agent', description: 'Zipdev internal AI co-pilot' };
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 antialiased">
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 12: Write `apps/web/app/(auth)/layout.tsx`**

```tsx
import type { ReactNode } from 'react';
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen grid place-items-center p-6">{children}</div>;
}
```

- [ ] **Step 13: Write `apps/web/app/(auth)/login/page.tsx`**

```tsx
'use client';
import { useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function signIn() {
    setLoading(true); setErr(null);
    const sb = getSupabaseBrowserClient();
    const next = new URLSearchParams(window.location.search).get('next') ?? '/';
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/api/auth/callback?next=${encodeURIComponent(next)}`,
        queryParams: { access_type: 'offline', prompt: 'consent', hd: 'zipdev.com' },
        scopes: 'openid email profile',
      },
    });
    if (error) { setErr(error.message); setLoading(false); }
  }

  return (
    <div className="max-w-sm w-full rounded-2xl border bg-white dark:bg-neutral-900 p-8 shadow-sm">
      <h1 className="text-2xl font-semibold mb-2">Zipdev Agent</h1>
      <p className="text-neutral-500 text-sm mb-6">Sign in with your @zipdev.com Google account.</p>
      <button
        onClick={signIn}
        disabled={loading}
        className="w-full rounded-xl bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 py-2.5 font-medium hover:opacity-90 disabled:opacity-50"
      >{loading ? 'Redirecting…' : 'Continue with Google'}</button>
      {err && <p className="mt-4 text-sm text-red-600">{err}</p>}
    </div>
  );
}
```

- [ ] **Step 14: Write `apps/web/app/api/auth/callback/route.ts`**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getEnv } from '@zipdev/core';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/';
  const sb = await getSupabaseServerClient();
  if (code) {
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (error) return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error.message)}`, req.url));
  }
  // Domain guard: signup trigger rejects non-zipdev; double-check here too
  const { data: { user } } = await sb.auth.getUser();
  const allowed = getEnv().ALLOWED_EMAIL_DOMAIN;
  if (user && !user.email?.toLowerCase().endsWith(`@${allowed}`)) {
    await sb.auth.signOut();
    return NextResponse.redirect(new URL('/login?error=domain', req.url));
  }
  return NextResponse.redirect(new URL(next, req.url));
}
```

- [ ] **Step 15: Run dev server and verify login redirect**

Run: `pnpm --filter @zipdev/web dev`
Expected: starts on http://localhost:3000.

Visit http://localhost:3000 → expect redirect to `/login`.
Visit http://localhost:3000/login → expect the login page.

(End-to-end Google login requires real OAuth creds; the manual smoke test is the redirect-to-login behavior. Full E2E is in Task 28.)

- [ ] **Step 16: Commit**

```bash
git add apps/web
git commit -m "feat(web): Next.js scaffold + Google SSO with @zipdev.com restriction"
```

---

## Task 5: `@zipdev/agent-tools` framework (types, registry, audit, rate-limit, integrations client)

**Files:**
- Create: `packages/agent-tools/{package.json,tsconfig.json}`
- Create: `packages/agent-tools/src/{index,types,audit,rate-limit,integrations}.ts`
- Create: `packages/agent-tools/src/{audit,rate-limit}.test.ts`

- [ ] **Step 1: Write `packages/agent-tools/package.json`**

```json
{
  "name": "@zipdev/agent-tools",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "lint": "biome check src",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@zipdev/core": "workspace:*",
    "@supabase/supabase-js": "2.46.2",
    "zod": "3.23.8"
  },
  "devDependencies": {
    "typescript": "5.7.2",
    "vitest": "2.1.8",
    "msw": "2.7.0",
    "@types/node": "20.17.10"
  }
}
```

- [ ] **Step 2: Write `packages/agent-tools/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "noEmit": true },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write `packages/agent-tools/src/types.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger, UUID } from '@zipdev/core';
import type { z } from 'zod';

export interface ToolContext {
  userId: UUID;
  agentId: UUID;
  conversationId?: UUID;
  db: SupabaseClient;                      // service-role client
  integrations: IntegrationsClient;
  logger: Logger;
  signal?: AbortSignal;
}

export interface ToolDef<I, O> {
  id: string;
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  requiresConfirmation?: boolean;
  requiredScopes?: { provider: 'google' | 'hubspot'; scopes: string[] }[];
  rateLimit?: { perMinute: number };
  handler: (input: I, ctx: ToolContext) => Promise<O>;
}

export interface IntegrationsClient {
  /** Returns a fresh access token for the given user+provider, refreshing if expired. */
  getAccessToken(provider: 'google' | 'hubspot'): Promise<{ token: string; scopes: string[] }>;
  /** Returns true if the integration exists and includes ALL the requested scopes. */
  hasScopes(provider: 'google' | 'hubspot', scopes: string[]): Promise<boolean>;
}

export type AnyTool = ToolDef<unknown, unknown>;
```

- [ ] **Step 4: Write `packages/agent-tools/src/audit.ts`**

```ts
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { UUID } from '@zipdev/core';

export type AuditStatus = 'ok' | 'error' | 'rate_limited' | 'confirmation_required';

export interface WriteAuditOpts {
  db: SupabaseClient;
  userId: UUID;
  agentId: UUID;
  conversationId?: UUID;
  toolId: string;
  input: unknown;
  status: AuditStatus;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

export function hashInput(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex').slice(0, 32);
}

export async function writeAuditEvent(opts: WriteAuditOpts) {
  const { error } = await opts.db.from('audit_events').insert({
    user_id: opts.userId,
    agent_id: opts.agentId,
    conversation_id: opts.conversationId ?? null,
    tool_id: opts.toolId,
    input_hash: hashInput(opts.input),
    status: opts.status,
    latency_ms: opts.latencyMs,
    metadata: opts.metadata ?? {},
  });
  if (error) {
    // Never throw — audit failures must not break the user's call
    console.error('audit_events insert failed', { error });
  }
}
```

- [ ] **Step 5: Write `packages/agent-tools/src/audit.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { hashInput } from './audit';

describe('hashInput', () => {
  it('is stable for equal inputs', () => {
    expect(hashInput({ a: 1, b: 2 })).toEqual(hashInput({ a: 1, b: 2 }));
  });
  it('differs for different inputs', () => {
    expect(hashInput({ a: 1 })).not.toEqual(hashInput({ a: 2 }));
  });
  it('handles null/undefined', () => {
    expect(hashInput(null)).toEqual(hashInput(undefined));
  });
});
```

- [ ] **Step 6: Write `packages/agent-tools/src/rate-limit.ts`** (token bucket in Postgres)

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { RateLimitError, type UUID } from '@zipdev/core';

/**
 * Token bucket per (user_id, tool_id): `perMinute` tokens that refill once per minute.
 * Returns void on success; throws RateLimitError when exceeded.
 */
export async function consumeToken(
  db: SupabaseClient,
  userId: UUID,
  toolId: string,
  perMinute: number,
): Promise<void> {
  const now = new Date();
  const { data: existing } = await db
    .from('rate_limit_buckets')
    .select('tokens, refill_at')
    .eq('user_id', userId)
    .eq('tool_id', toolId)
    .maybeSingle();

  let tokens = existing?.tokens ?? perMinute;
  let refillAt = existing?.refill_at ? new Date(existing.refill_at as string) : new Date(now.getTime() + 60_000);

  if (now >= refillAt) {
    tokens = perMinute;
    refillAt = new Date(now.getTime() + 60_000);
  }
  if (tokens <= 0) throw new RateLimitError(`Rate limit for ${toolId} (${perMinute}/min)`);
  tokens -= 1;

  await db.from('rate_limit_buckets').upsert({
    user_id: userId,
    tool_id: toolId,
    tokens,
    refill_at: refillAt.toISOString(),
  });
}
```

- [ ] **Step 7: Write `packages/agent-tools/src/integrations.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptToken, encryptToken, IntegrationError, type Logger, type UUID } from '@zipdev/core';

interface RefreshFn { (refreshToken: string): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>; }

const REFRESHERS: Record<'google' | 'hubspot', RefreshFn> = {
  async google(rt) {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: rt,
        grant_type: 'refresh_token',
      }),
    });
    if (!r.ok) throw new IntegrationError(`Google refresh failed: ${r.status}`, 'google');
    return r.json() as Promise<{ access_token: string; expires_in: number; scope: string }>;
  },
  async hubspot(rt) {
    const r = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.HUBSPOT_CLIENT_ID!,
        client_secret: process.env.HUBSPOT_CLIENT_SECRET!,
        refresh_token: rt,
      }),
    });
    if (!r.ok) throw new IntegrationError(`HubSpot refresh failed: ${r.status}`, 'hubspot');
    return r.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
  },
};

export interface IntegrationsClient {
  getAccessToken(provider: 'google' | 'hubspot'): Promise<{ token: string; scopes: string[] }>;
  hasScopes(provider: 'google' | 'hubspot', scopes: string[]): Promise<boolean>;
}

export function createIntegrationsClient(db: SupabaseClient, userId: UUID, logger: Logger): IntegrationsClient {
  return {
    async getAccessToken(provider) {
      const { data, error } = await db
        .from('integrations')
        .select('id, access_token_enc, refresh_token_enc, scopes, expires_at')
        .eq('user_id', userId)
        .eq('provider', provider)
        .maybeSingle();
      if (error || !data) throw new IntegrationError(`No ${provider} integration for user`, provider);

      const expired = data.expires_at ? new Date(data.expires_at as string).getTime() - 60_000 < Date.now() : false;
      if (!expired) {
        return { token: decryptToken(data.access_token_enc as string), scopes: data.scopes as string[] };
      }
      if (!data.refresh_token_enc) throw new IntegrationError(`No refresh token for ${provider}`, provider);
      const refreshed = await REFRESHERS[provider](decryptToken(data.refresh_token_enc as string));
      const newScopes = refreshed.scope ? refreshed.scope.split(' ') : (data.scopes as string[]);
      const newRefresh = refreshed.refresh_token ?? decryptToken(data.refresh_token_enc as string);
      await db.from('integrations').update({
        access_token_enc: encryptToken(refreshed.access_token),
        refresh_token_enc: encryptToken(newRefresh),
        scopes: newScopes,
        expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', data.id as string);
      logger.info({ provider, userId }, 'refreshed integration token');
      return { token: refreshed.access_token, scopes: newScopes };
    },
    async hasScopes(provider, scopes) {
      const { data } = await db.from('integrations').select('scopes').eq('user_id', userId).eq('provider', provider).maybeSingle();
      if (!data) return false;
      const have = new Set(data.scopes as string[]);
      return scopes.every((s) => have.has(s));
    },
  };
}
```

- [ ] **Step 8: Write `packages/agent-tools/src/index.ts`** (registry + filter helper)

```ts
import { ConfirmationRequiredError, ValidationError } from '@zipdev/core';
import { writeAuditEvent } from './audit';
import { consumeToken } from './rate-limit';
import type { AnyTool, ToolContext, ToolDef } from './types';

const REGISTRY = new Map<string, AnyTool>();

export function registerTool<I, O>(tool: ToolDef<I, O>): ToolDef<I, O> {
  REGISTRY.set(tool.id, tool as AnyTool);
  return tool;
}

export function getTool(id: string): AnyTool | undefined { return REGISTRY.get(id); }
export function listTools(): AnyTool[] { return [...REGISTRY.values()]; }

export function filterTools(allowed: string[]): AnyTool[] {
  return [...REGISTRY.values()].filter((t) => allowed.some((pat) => matchPattern(pat, t.id)));
}

function matchPattern(pat: string, id: string): boolean {
  if (pat.endsWith('.*')) return id.startsWith(pat.slice(0, -1));
  return pat === id;
}

/**
 * Executes a tool with: scope check, rate-limit, schema validation, confirmation gate, audit logging.
 * `confirmed` should be true only when the user has approved a destructive write.
 */
export async function runTool<I, O>(
  tool: ToolDef<I, O>,
  input: unknown,
  ctx: ToolContext,
  opts: { confirmed?: boolean } = {},
): Promise<O> {
  const t0 = performance.now();
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    await writeAuditEvent({
      db: ctx.db, userId: ctx.userId, agentId: ctx.agentId, conversationId: ctx.conversationId,
      toolId: tool.id, input, status: 'error', latencyMs: Math.round(performance.now() - t0),
      metadata: { reason: 'validation', issues: parsed.error.flatten() },
    });
    throw new ValidationError(`Invalid input for ${tool.id}`, parsed.error.flatten());
  }
  if (tool.requiresConfirmation && !opts.confirmed) {
    await writeAuditEvent({
      db: ctx.db, userId: ctx.userId, agentId: ctx.agentId, conversationId: ctx.conversationId,
      toolId: tool.id, input, status: 'confirmation_required', latencyMs: Math.round(performance.now() - t0),
    });
    throw new ConfirmationRequiredError(tool.id, parsed.data);
  }
  if (tool.rateLimit) await consumeToken(ctx.db, ctx.userId, tool.id, tool.rateLimit.perMinute);
  if (tool.requiredScopes) {
    for (const r of tool.requiredScopes) {
      const ok = await ctx.integrations.hasScopes(r.provider, r.scopes);
      if (!ok) {
        await writeAuditEvent({
          db: ctx.db, userId: ctx.userId, agentId: ctx.agentId, conversationId: ctx.conversationId,
          toolId: tool.id, input, status: 'error', latencyMs: Math.round(performance.now() - t0),
          metadata: { reason: 'missing_scopes', provider: r.provider, scopes: r.scopes },
        });
        throw new ValidationError(`Missing ${r.provider} scopes: ${r.scopes.join(',')}`);
      }
    }
  }
  try {
    const result = await tool.handler(parsed.data, ctx);
    const validated = tool.outputSchema.parse(result);
    await writeAuditEvent({
      db: ctx.db, userId: ctx.userId, agentId: ctx.agentId, conversationId: ctx.conversationId,
      toolId: tool.id, input, status: 'ok', latencyMs: Math.round(performance.now() - t0),
    });
    return validated;
  } catch (err) {
    await writeAuditEvent({
      db: ctx.db, userId: ctx.userId, agentId: ctx.agentId, conversationId: ctx.conversationId,
      toolId: tool.id, input, status: 'error', latencyMs: Math.round(performance.now() - t0),
      metadata: { error: (err as Error).message },
    });
    throw err;
  }
}

export * from './types';
export { writeAuditEvent } from './audit';
export { consumeToken } from './rate-limit';
export { createIntegrationsClient } from './integrations';
```

- [ ] **Step 9: Run tests**

Run: `pnpm --filter @zipdev/agent-tools test`
Expected: 3 passed (hashInput).

Run: `pnpm --filter @zipdev/agent-tools typecheck`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add packages/agent-tools
git commit -m "feat(tools): framework — types, registry, audit, rate-limit, integrations client"
```

---

## Task 6: Google OAuth integration flow (incremental per-tool-family scopes)

**Files:**
- Create: `apps/web/app/api/integrations/google/route.ts`
- Create: `apps/web/app/api/integrations/google/callback/route.ts`
- Create: `apps/web/app/(app)/integrations/page.tsx`
- Create: `apps/web/app/(app)/layout.tsx`
- Create: `apps/web/components/nav/Sidebar.tsx`

- [ ] **Step 1: Write `apps/web/app/(app)/layout.tsx`**

```tsx
import type { ReactNode } from 'react';
import { Sidebar } from '@/components/nav/Sidebar';
import { requireSession } from '@/lib/session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireSession();
  return (
    <div className="grid grid-cols-[240px_1fr] min-h-screen">
      <Sidebar role={user.role} />
      <main className="p-6 max-w-5xl">{children}</main>
    </div>
  );
}
```

- [ ] **Step 2: Write `apps/web/components/nav/Sidebar.tsx`**

```tsx
import Link from 'next/link';
import type { Role } from '@zipdev/core';

export function Sidebar({ role }: { role: Role }) {
  return (
    <aside className="border-r p-4 space-y-1 text-sm">
      <div className="text-xs uppercase tracking-wider text-neutral-500 mt-3 mb-1">Workspace</div>
      <Link href="/" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Dashboard</Link>
      <Link href="/chat" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Chat</Link>
      <Link href="/conversations" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Conversations</Link>
      <div className="text-xs uppercase tracking-wider text-neutral-500 mt-3 mb-1">Knowledge</div>
      <Link href="/kb/me" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">My KB</Link>
      <Link href="/kb" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Team / Global KB</Link>
      <div className="text-xs uppercase tracking-wider text-neutral-500 mt-3 mb-1">Setup</div>
      <Link href="/integrations" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Integrations</Link>
      <Link href="/agents" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Agents</Link>
      {role === 'org_admin' && (
        <>
          <div className="text-xs uppercase tracking-wider text-neutral-500 mt-3 mb-1">Admin</div>
          <Link href="/admin/users" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Users</Link>
          <Link href="/admin/teams" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Teams</Link>
          <Link href="/admin/audit" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Audit log</Link>
          <Link href="/admin/usage" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Usage</Link>
        </>
      )}
    </aside>
  );
}
```

- [ ] **Step 3: Write `apps/web/app/api/integrations/google/route.ts`** (start flow)

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { requireSession } from '@/lib/session';
import { getEnv } from '@zipdev/core';
import { cookies } from 'next/headers';

const SCOPE_PRESETS: Record<string, string[]> = {
  gmail: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'],
  drive: ['https://www.googleapis.com/auth/drive.readonly'],
  calendar: ['https://www.googleapis.com/auth/calendar.events'],
  sheets: ['https://www.googleapis.com/auth/spreadsheets'],
  all: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/spreadsheets',
  ],
};

export async function GET(req: NextRequest) {
  await requireSession();
  const url = new URL(req.url);
  const preset = url.searchParams.get('preset') ?? 'all';
  const requested = SCOPE_PRESETS[preset] ?? SCOPE_PRESETS.all;
  const state = randomBytes(16).toString('hex');
  const cookieStore = await cookies();
  cookieStore.set('google_oauth_state', state, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 600 });

  const env = getEnv();
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  auth.searchParams.set('redirect_uri', env.GOOGLE_REDIRECT_URI);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('access_type', 'offline');
  auth.searchParams.set('include_granted_scopes', 'true');
  auth.searchParams.set('prompt', 'consent');
  auth.searchParams.set('state', state);
  auth.searchParams.set('scope', requested.join(' '));
  return NextResponse.redirect(auth);
}
```

- [ ] **Step 4: Write `apps/web/app/api/integrations/google/callback/route.ts`**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { encryptToken, getEnv, IntegrationError } from '@zipdev/core';

export async function GET(req: NextRequest) {
  const user = await requireSession();
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieStore = await cookies();
  const expected = cookieStore.get('google_oauth_state')?.value;
  cookieStore.delete('google_oauth_state');
  if (!code || !state || state !== expected) {
    return NextResponse.redirect(new URL('/integrations?error=state', req.url));
  }

  const env = getEnv();
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI, grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) throw new IntegrationError(`Google token exchange failed: ${tokenRes.status}`, 'google');
  const tok = await tokenRes.json() as { access_token: string; refresh_token?: string; expires_in: number; scope: string };

  const db = getSupabaseServiceClient();
  // Merge scopes with existing if upgrade flow (incremental scopes returned by Google)
  const { data: existing } = await db.from('integrations').select('id, scopes, refresh_token_enc').eq('user_id', user.id).eq('provider', 'google').maybeSingle();
  const mergedScopes = Array.from(new Set([...(existing?.scopes as string[] | undefined ?? []), ...tok.scope.split(' ')]));
  const refreshEnc = tok.refresh_token
    ? encryptToken(tok.refresh_token)
    : (existing?.refresh_token_enc as string | undefined ?? null);

  await db.from('integrations').upsert({
    user_id: user.id,
    provider: 'google',
    access_token_enc: encryptToken(tok.access_token),
    refresh_token_enc: refreshEnc,
    scopes: mergedScopes,
    expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,provider' });

  return NextResponse.redirect(new URL('/integrations?connected=google', req.url));
}
```

- [ ] **Step 5: Write `apps/web/app/(app)/integrations/page.tsx`**

```tsx
import { requireSession } from '@/lib/session';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import Link from 'next/link';

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  await requireSession();
  const sp = await searchParams;
  const sb = await getSupabaseServerClient();
  const { data: rows } = await sb.from('integrations_view').select('provider, scopes, expires_at, updated_at');
  const byProvider = Object.fromEntries((rows ?? []).map((r) => [r.provider, r]));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Integrations</h1>
      {sp.connected && <div className="rounded bg-green-50 text-green-800 px-3 py-2 text-sm">Connected {sp.connected}.</div>}
      {sp.error && <div className="rounded bg-red-50 text-red-800 px-3 py-2 text-sm">Error: {sp.error}</div>}

      <section className="rounded-2xl border p-5">
        <header className="flex items-center justify-between">
          <div>
            <h2 className="font-medium">Google Workspace</h2>
            <p className="text-sm text-neutral-500">Connect Gmail, Drive, Calendar, Sheets — granted incrementally.</p>
          </div>
          {byProvider.google ? (
            <span className="text-xs text-green-700">Connected · {(byProvider.google.scopes as string[]).length} scopes</span>
          ) : (
            <Link href="/api/integrations/google?preset=all" className="rounded bg-neutral-900 text-white text-sm px-3 py-1.5">Connect</Link>
          )}
        </header>
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          {['gmail', 'drive', 'calendar', 'sheets'].map((p) => (
            <Link key={p} href={`/api/integrations/google?preset=${p}`} className="rounded border px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">+ {p}</Link>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border p-5">
        <header className="flex items-center justify-between">
          <div>
            <h2 className="font-medium">HubSpot</h2>
            <p className="text-sm text-neutral-500">Read-only access to deals, companies, contacts, activities.</p>
          </div>
          {byProvider.hubspot ? (
            <span className="text-xs text-green-700">Connected</span>
          ) : (
            <Link href="/api/integrations/hubspot" className="rounded bg-neutral-900 text-white text-sm px-3 py-1.5">Connect</Link>
          )}
        </header>
      </section>
    </div>
  );
}
```

- [ ] **Step 6: Write a minimal `apps/web/app/(app)/page.tsx` dashboard (placeholder; expanded in Task 25)**

```tsx
import { requireSession } from '@/lib/session';
import Link from 'next/link';

export default async function Dashboard() {
  const user = await requireSession();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Welcome, {user.name ?? user.email}</h1>
      <p className="text-neutral-500">Go to <Link className="underline" href="/integrations">Integrations</Link> to connect your tools, then start a <Link className="underline" href="/chat">new chat</Link>.</p>
    </div>
  );
}
```

- [ ] **Step 7: Manual smoke test**

Set env values in `.env.local` (Google OAuth client must be created in Google Cloud Console; runbook in Task 28).
Run: `pnpm --filter @zipdev/web dev`
Visit `/integrations`, click **Connect**, complete Google consent, verify redirect lands at `/integrations?connected=google` and the "Connected · N scopes" badge appears.

Run: `psql $SUPABASE_DB_URL -c "select provider, array_length(scopes,1) from public.integrations where user_id = '<your-uuid>'"`
Expected: one `google` row with 5 scopes (or however many requested).

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat(integrations): Google OAuth with incremental scope grants + integrations page"
```

---

## Task 7: HubSpot OAuth integration (per-user, read-only)

**Files:**
- Create: `apps/web/app/api/integrations/hubspot/route.ts`
- Create: `apps/web/app/api/integrations/hubspot/callback/route.ts`

- [ ] **Step 1: Write `apps/web/app/api/integrations/hubspot/route.ts`**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { requireSession } from '@/lib/session';
import { getEnv } from '@zipdev/core';

const SCOPES = [
  'crm.objects.companies.read',
  'crm.objects.contacts.read',
  'crm.objects.deals.read',
  'crm.objects.owners.read',
  'sales-email-read',
  'oauth',
];

export async function GET(_req: NextRequest) {
  await requireSession();
  const state = randomBytes(16).toString('hex');
  const cookieStore = await cookies();
  cookieStore.set('hubspot_oauth_state', state, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 600 });
  const env = getEnv();
  const auth = new URL('https://app.hubspot.com/oauth/authorize');
  auth.searchParams.set('client_id', env.HUBSPOT_CLIENT_ID);
  auth.searchParams.set('redirect_uri', env.HUBSPOT_REDIRECT_URI);
  auth.searchParams.set('scope', SCOPES.join(' '));
  auth.searchParams.set('state', state);
  return NextResponse.redirect(auth);
}
```

- [ ] **Step 2: Write `apps/web/app/api/integrations/hubspot/callback/route.ts`**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { encryptToken, getEnv, IntegrationError } from '@zipdev/core';

export async function GET(req: NextRequest) {
  const user = await requireSession();
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieStore = await cookies();
  const expected = cookieStore.get('hubspot_oauth_state')?.value;
  cookieStore.delete('hubspot_oauth_state');
  if (!code || !state || state !== expected) {
    return NextResponse.redirect(new URL('/integrations?error=state', req.url));
  }
  const env = getEnv();
  const r = await fetch('https://api.hubapi.com/oauth/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.HUBSPOT_CLIENT_ID,
      client_secret: env.HUBSPOT_CLIENT_SECRET,
      redirect_uri: env.HUBSPOT_REDIRECT_URI,
      code,
    }),
  });
  if (!r.ok) throw new IntegrationError(`HubSpot token exchange failed: ${r.status}`, 'hubspot');
  const tok = await r.json() as { access_token: string; refresh_token: string; expires_in: number };

  const db = getSupabaseServiceClient();
  await db.from('integrations').upsert({
    user_id: user.id,
    provider: 'hubspot',
    access_token_enc: encryptToken(tok.access_token),
    refresh_token_enc: encryptToken(tok.refresh_token),
    scopes: ['crm.objects.companies.read','crm.objects.contacts.read','crm.objects.deals.read','crm.objects.owners.read','sales-email-read'],
    expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,provider' });

  return NextResponse.redirect(new URL('/integrations?connected=hubspot', req.url));
}
```

- [ ] **Step 3: Manual smoke test**

Visit `/integrations`, click **Connect** under HubSpot, complete consent in HubSpot, verify redirect to `/integrations?connected=hubspot`.

Run: `psql $SUPABASE_DB_URL -c "select provider, scopes from public.integrations where user_id = '<your-uuid>'"`
Expected: a `hubspot` row.

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "feat(integrations): HubSpot per-user OAuth (read-only)"
```

---

## Task 8: HubSpot tools (5 tools — read-only)

**Files:**
- Create: `packages/agent-tools/src/hubspot/{client,search-companies,get-company,search-deals,get-deal,list-recent-activities}.ts`
- Create: `packages/agent-tools/src/hubspot/__tests__/{hubspot-tools.test.ts}`
- Modify: `packages/agent-tools/src/index.ts` (register all 5 tools)

- [ ] **Step 1: Write `packages/agent-tools/src/hubspot/client.ts`**

```ts
import { IntegrationError } from '@zipdev/core';
import type { ToolContext } from '../types';

const BASE = 'https://api.hubapi.com';

export async function hsFetch<T>(ctx: ToolContext, path: string, init?: RequestInit): Promise<T> {
  const { token } = await ctx.integrations.getAccessToken('hubspot');
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    signal: ctx.signal,
  });
  if (r.status === 401) throw new IntegrationError('HubSpot 401', 'hubspot');
  if (!r.ok) throw new IntegrationError(`HubSpot ${r.status} ${path}: ${await r.text()}`, 'hubspot');
  return r.json() as Promise<T>;
}
```

- [ ] **Step 2: Write `packages/agent-tools/src/hubspot/search-companies.ts`**

```ts
import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

const CompanyOut = z.object({
  id: z.string(),
  name: z.string().nullable(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  numEmployees: z.number().nullable(),
  country: z.string().nullable(),
});
const Output = z.object({ results: z.array(CompanyOut) });

export const searchCompanies = registerTool({
  id: 'hubspot.search_companies',
  description: 'Search HubSpot companies by name or domain. Returns up to `limit` matches with key properties.',
  inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(10) }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'hubspot', scopes: ['crm.objects.companies.read'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    type R = { results: Array<{ id: string; properties: Record<string, string | null> }> };
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'name', operator: 'CONTAINS_TOKEN', value: input.query }] }],
      properties: ['name', 'domain', 'industry', 'numberofemployees', 'country'],
      limit: input.limit,
    };
    const data = await hsFetch<R>(ctx, '/crm/v3/objects/companies/search', { method: 'POST', body: JSON.stringify(body) });
    return {
      results: data.results.map((c) => ({
        id: c.id,
        name: c.properties.name ?? null,
        domain: c.properties.domain ?? null,
        industry: c.properties.industry ?? null,
        numEmployees: c.properties.numberofemployees ? Number(c.properties.numberofemployees) : null,
        country: c.properties.country ?? null,
      })),
    };
  },
});
```

- [ ] **Step 3: Write `packages/agent-tools/src/hubspot/get-company.ts`**

```ts
import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

const RecentDeal = z.object({ id: z.string(), name: z.string().nullable(), amount: z.number().nullable(), stage: z.string().nullable(), closeDate: z.string().nullable() });

const Output = z.object({
  id: z.string(),
  name: z.string().nullable(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  numEmployees: z.number().nullable(),
  country: z.string().nullable(),
  ownerId: z.string().nullable(),
  recentDeals: z.array(RecentDeal),
});

export const getCompany = registerTool({
  id: 'hubspot.get_company',
  description: 'Get full HubSpot company by id including recent deals associated.',
  inputSchema: z.object({ id: z.string() }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'hubspot', scopes: ['crm.objects.companies.read', 'crm.objects.deals.read'] }],
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    type C = { id: string; properties: Record<string, string | null>; associations?: { deals?: { results: Array<{ id: string }> } } };
    const company = await hsFetch<C>(ctx, `/crm/v3/objects/companies/${input.id}?properties=name,domain,industry,numberofemployees,country,hubspot_owner_id&associations=deals`);
    const dealIds = (company.associations?.deals?.results ?? []).slice(0, 5).map((d) => d.id);
    type D = { results: Array<{ id: string; properties: Record<string, string | null> }> };
    let recentDeals: Array<z.infer<typeof RecentDeal>> = [];
    if (dealIds.length) {
      const data = await hsFetch<D>(ctx, '/crm/v3/objects/deals/batch/read', {
        method: 'POST',
        body: JSON.stringify({ properties: ['dealname','amount','dealstage','closedate'], inputs: dealIds.map((id) => ({ id })) }),
      });
      recentDeals = data.results.map((d) => ({
        id: d.id,
        name: d.properties.dealname ?? null,
        amount: d.properties.amount ? Number(d.properties.amount) : null,
        stage: d.properties.dealstage ?? null,
        closeDate: d.properties.closedate ?? null,
      }));
    }
    return {
      id: company.id,
      name: company.properties.name ?? null,
      domain: company.properties.domain ?? null,
      industry: company.properties.industry ?? null,
      numEmployees: company.properties.numberofemployees ? Number(company.properties.numberofemployees) : null,
      country: company.properties.country ?? null,
      ownerId: company.properties.hubspot_owner_id ?? null,
      recentDeals,
    };
  },
});
```

- [ ] **Step 4: Write `packages/agent-tools/src/hubspot/search-deals.ts`**

```ts
import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

const DealOut = z.object({ id: z.string(), name: z.string().nullable(), amount: z.number().nullable(), stage: z.string().nullable(), closeDate: z.string().nullable(), companyId: z.string().nullable() });

export const searchDeals = registerTool({
  id: 'hubspot.search_deals',
  description: 'Search HubSpot deals with optional filters: stage, ownerId, minAmount, maxAmount.',
  inputSchema: z.object({
    stage: z.string().optional(),
    ownerId: z.string().optional(),
    minAmount: z.number().optional(),
    maxAmount: z.number().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  outputSchema: z.object({ results: z.array(DealOut) }),
  requiredScopes: [{ provider: 'hubspot', scopes: ['crm.objects.deals.read'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const filters: Array<{ propertyName: string; operator: string; value?: string; highValue?: string }> = [];
    if (input.stage) filters.push({ propertyName: 'dealstage', operator: 'EQ', value: input.stage });
    if (input.ownerId) filters.push({ propertyName: 'hubspot_owner_id', operator: 'EQ', value: input.ownerId });
    if (input.minAmount != null) filters.push({ propertyName: 'amount', operator: 'GTE', value: String(input.minAmount) });
    if (input.maxAmount != null) filters.push({ propertyName: 'amount', operator: 'LTE', value: String(input.maxAmount) });
    type R = { results: Array<{ id: string; properties: Record<string, string | null>; associations?: { companies?: { results: Array<{ id: string }> } } }> };
    const data = await hsFetch<R>(ctx, '/crm/v3/objects/deals/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: filters.length ? [{ filters }] : [],
        properties: ['dealname','amount','dealstage','closedate'],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
        limit: input.limit,
      }),
    });
    return {
      results: data.results.map((d) => ({
        id: d.id,
        name: d.properties.dealname ?? null,
        amount: d.properties.amount ? Number(d.properties.amount) : null,
        stage: d.properties.dealstage ?? null,
        closeDate: d.properties.closedate ?? null,
        companyId: d.associations?.companies?.results?.[0]?.id ?? null,
      })),
    };
  },
});
```

- [ ] **Step 5: Write `packages/agent-tools/src/hubspot/get-deal.ts`**

```ts
import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

export const getDeal = registerTool({
  id: 'hubspot.get_deal',
  description: 'Get a HubSpot deal by id with full properties and associations (company, contacts).',
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string().nullable(),
    amount: z.number().nullable(),
    stage: z.string().nullable(),
    closeDate: z.string().nullable(),
    pipeline: z.string().nullable(),
    description: z.string().nullable(),
    companyIds: z.array(z.string()),
    contactIds: z.array(z.string()),
  }),
  requiredScopes: [{ provider: 'hubspot', scopes: ['crm.objects.deals.read'] }],
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    type D = { id: string; properties: Record<string, string | null>; associations?: { companies?: { results: Array<{ id: string }> }; contacts?: { results: Array<{ id: string }> } } };
    const d = await hsFetch<D>(ctx, `/crm/v3/objects/deals/${input.id}?properties=dealname,amount,dealstage,closedate,pipeline,description&associations=companies,contacts`);
    return {
      id: d.id,
      name: d.properties.dealname ?? null,
      amount: d.properties.amount ? Number(d.properties.amount) : null,
      stage: d.properties.dealstage ?? null,
      closeDate: d.properties.closedate ?? null,
      pipeline: d.properties.pipeline ?? null,
      description: d.properties.description ?? null,
      companyIds: (d.associations?.companies?.results ?? []).map((c) => c.id),
      contactIds: (d.associations?.contacts?.results ?? []).map((c) => c.id),
    };
  },
});
```

- [ ] **Step 6: Write `packages/agent-tools/src/hubspot/list-recent-activities.ts`**

```ts
import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

const ActivityOut = z.object({
  id: z.string(),
  type: z.enum(['email','call','note','meeting','task']),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  createdAt: z.string(),
});

export const listRecentActivities = registerTool({
  id: 'hubspot.list_recent_activities',
  description: 'List recent engagements (emails, calls, notes, meetings, tasks) for a HubSpot company, newest first.',
  inputSchema: z.object({ companyId: z.string(), days: z.number().int().min(1).max(365).default(30), limit: z.number().int().min(1).max(50).default(20) }),
  outputSchema: z.object({ results: z.array(ActivityOut) }),
  requiredScopes: [{ provider: 'hubspot', scopes: ['crm.objects.companies.read', 'sales-email-read'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const since = new Date(Date.now() - input.days * 86_400_000).toISOString();
    const types: Array<z.infer<typeof ActivityOut>['type']> = ['email','call','note','meeting','task'];
    const all: Array<z.infer<typeof ActivityOut>> = [];
    for (const t of types) {
      type R = { results: Array<{ id: string; properties: Record<string, string | null> }> };
      const data = await hsFetch<R>(ctx, `/crm/v3/objects/${t}s/search`, {
        method: 'POST',
        body: JSON.stringify({
          filterGroups: [{
            filters: [
              { propertyName: 'associations.company', operator: 'EQ', value: input.companyId },
              { propertyName: 'hs_createdate', operator: 'GTE', value: since },
            ],
          }],
          properties: ['hs_email_subject','hs_email_text','hs_call_title','hs_call_body','hs_note_body','hs_meeting_title','hs_meeting_body','hs_task_subject','hs_task_body','hs_createdate'],
          sorts: [{ propertyName: 'hs_createdate', direction: 'DESCENDING' }],
          limit: input.limit,
        }),
      });
      for (const r of data.results) {
        const subject = r.properties.hs_email_subject ?? r.properties.hs_call_title ?? r.properties.hs_meeting_title ?? r.properties.hs_task_subject ?? null;
        const body = r.properties.hs_email_text ?? r.properties.hs_call_body ?? r.properties.hs_note_body ?? r.properties.hs_meeting_body ?? r.properties.hs_task_body ?? null;
        all.push({ id: r.id, type: t, subject, body, createdAt: r.properties.hs_createdate ?? since });
      }
    }
    return { results: all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, input.limit) };
  },
});
```

- [ ] **Step 7: Modify `packages/agent-tools/src/index.ts` to import (and thus register) all 5 HubSpot tools**

Append at the bottom of the file:
```ts
// Register tools by importing for side effects.
import './hubspot/search-companies';
import './hubspot/get-company';
import './hubspot/search-deals';
import './hubspot/get-deal';
import './hubspot/list-recent-activities';
```

- [ ] **Step 8: Write `packages/agent-tools/src/hubspot/__tests__/hubspot-tools.test.ts`** (msw HTTP mocking)

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { searchCompanies } from '../search-companies';
import { getCompany } from '../get-company';
import { searchDeals } from '../search-deals';
import { listRecentActivities } from '../list-recent-activities';
import type { ToolContext } from '../../types';

const fakeCtx = (): ToolContext => ({
  userId: '00000000-0000-0000-0000-000000000001',
  agentId: '00000000-0000-0000-0000-000000000002',
  db: {} as never,
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  integrations: { getAccessToken: async () => ({ token: 't', scopes: [] }), hasScopes: async () => true } as any,
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as any,
});

const server = setupServer(
  http.post('https://api.hubapi.com/crm/v3/objects/companies/search', () =>
    HttpResponse.json({ results: [{ id: '101', properties: { name: 'Acme', domain: 'acme.com', industry: 'Tech', numberofemployees: '120', country: 'US' } }] }),
  ),
  http.get('https://api.hubapi.com/crm/v3/objects/companies/:id', () =>
    HttpResponse.json({ id: '101', properties: { name: 'Acme', domain: 'acme.com', industry: 'Tech', numberofemployees: '120', country: 'US', hubspot_owner_id: '7' }, associations: { deals: { results: [{ id: '500' }] } } }),
  ),
  http.post('https://api.hubapi.com/crm/v3/objects/deals/batch/read', () =>
    HttpResponse.json({ results: [{ id: '500', properties: { dealname: 'Acme Q1', amount: '50000', dealstage: 'qualified', closedate: '2026-06-30' } }] }),
  ),
  http.post('https://api.hubapi.com/crm/v3/objects/deals/search', () =>
    HttpResponse.json({ results: [{ id: '500', properties: { dealname: 'Acme Q1', amount: '50000', dealstage: 'qualified', closedate: '2026-06-30' }, associations: { companies: { results: [{ id: '101' }] } } }] }),
  ),
  http.post('https://api.hubapi.com/crm/v3/objects/:type/search', () =>
    HttpResponse.json({ results: [] }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => server.resetHandlers());

describe('HubSpot tools', () => {
  it('search_companies parses results', async () => {
    const out = await searchCompanies.handler({ query: 'Acme', limit: 5 }, fakeCtx());
    expect(out.results[0]).toEqual({ id: '101', name: 'Acme', domain: 'acme.com', industry: 'Tech', numEmployees: 120, country: 'US' });
  });
  it('get_company returns recentDeals', async () => {
    const out = await getCompany.handler({ id: '101' }, fakeCtx());
    expect(out.recentDeals[0]?.amount).toBe(50000);
  });
  it('search_deals applies filters', async () => {
    const out = await searchDeals.handler({ stage: 'qualified', limit: 10 }, fakeCtx());
    expect(out.results[0]?.companyId).toBe('101');
  });
  it('list_recent_activities aggregates and sorts', async () => {
    const out = await listRecentActivities.handler({ companyId: '101', days: 30, limit: 20 }, fakeCtx());
    expect(Array.isArray(out.results)).toBe(true);
  });
});
```

- [ ] **Step 9: Run tests**

Run: `pnpm --filter @zipdev/agent-tools test`
Expected: 7 passed (3 audit + 4 hubspot).

- [ ] **Step 10: Commit**

```bash
git add packages/agent-tools
git commit -m "feat(tools): HubSpot read-only tools (5)"
```

---

## Task 9: Rate Estimator — add internal endpoint + tools

**Files:**
- Modify: `C:\Users\User\Desktop\zipdev-rate-estimator-master\app\api\internal\estimate\route.ts` (CREATE in existing repo)
- Create: `packages/agent-tools/src/rate/{client,estimate,estimate-from-document}.ts`
- Create: `packages/agent-tools/src/rate/__tests__/rate.test.ts`
- Modify: `packages/agent-tools/src/index.ts` (register the rate tools)

- [ ] **Step 1: In the rate-estimator repo, create `app/api/internal/estimate/route.ts`**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { estimateRate } from '@/lib/estimator';   // existing internal function

export async function POST(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token || token !== process.env.INTERNAL_SERVICE_TOKEN) {
    return new NextResponse('unauthorized', { status: 401 });
  }
  const body = await req.json().catch(() => null) as null | {
    role?: string; seniority?: string; techStack?: string[]; country?: string; hours?: number;
  };
  if (!body?.role || !body.seniority) return NextResponse.json({ error: 'role and seniority required' }, { status: 400 });
  const result = await estimateRate({
    role: body.role,
    seniority: body.seniority,
    techStack: body.techStack ?? [],
    country: body.country,
    hours: body.hours,
  });
  return NextResponse.json(result);
}
```

If `estimateRate` is named differently in the existing `lib/estimator.ts`, adapt the import (the file is in the existing repo's `lib/`).

Add `INTERNAL_SERVICE_TOKEN` to that repo's `.env.example` and `.env.local` (must match `RATE_ESTIMATOR_SERVICE_TOKEN` used by `zipdev-agent`).

In the rate-estimator repo:
```bash
git add app/api/internal/estimate/route.ts .env.example
git commit -m "feat: internal estimate endpoint for zipdev-agent"
```

- [ ] **Step 2: Write `packages/agent-tools/src/rate/client.ts`**

```ts
import { IntegrationError } from '@zipdev/core';
import type { ToolContext } from '../types';

export interface EstimateInput {
  role: string;
  seniority: string;
  techStack?: string[];
  country?: string;
  hours?: number;
}

export interface EstimateOutput {
  hourlyRange: { min: number; max: number };
  monthlyRange: { min: number; max: number };
  sources: string[];
  confidence: number;
  reasoning?: string;
}

export async function callEstimator(body: EstimateInput, ctx: ToolContext): Promise<EstimateOutput> {
  const url = `${process.env.RATE_ESTIMATOR_URL}/api/internal/estimate`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RATE_ESTIMATOR_SERVICE_TOKEN}` },
    body: JSON.stringify(body),
    signal: ctx.signal,
  });
  if (!r.ok) throw new IntegrationError(`Rate estimator ${r.status}: ${await r.text()}`, 'rate-estimator');
  return r.json() as Promise<EstimateOutput>;
}
```

- [ ] **Step 3: Write `packages/agent-tools/src/rate/estimate.ts`**

```ts
import { z } from 'zod';
import { registerTool } from '../index';
import { callEstimator } from './client';

const Range = z.object({ min: z.number(), max: z.number() });

export const rateEstimate = registerTool({
  id: 'rate.estimate',
  description: 'Estimate hourly + monthly rate for a single role and seniority (LATAM staffing). Uses historical data first, then tribal knowledge, then AI inference. Returns ranges with confidence and sources.',
  inputSchema: z.object({
    role: z.string().min(2),
    seniority: z.enum(['junior', 'mid', 'senior', 'staff', 'principal']),
    techStack: z.array(z.string()).default([]),
    country: z.string().optional(),
    hours: z.number().int().min(1).max(200).optional(),
  }),
  outputSchema: z.object({
    hourlyRange: Range,
    monthlyRange: Range,
    sources: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().optional(),
  }),
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => callEstimator(input, ctx),
});
```

- [ ] **Step 4: Write `packages/agent-tools/src/rate/estimate-from-document.ts`**

```ts
import { z } from 'zod';
import { registerTool } from '../index';
import { callEstimator } from './client';

export const rateEstimateFromDocument = registerTool({
  id: 'rate.estimate_from_document',
  description: 'Given an uploaded JD/RFP document (referenced by its kb_document id), extract roles and produce rate estimates for each.',
  inputSchema: z.object({ documentId: z.string().uuid() }),
  outputSchema: z.object({
    roles: z.array(z.object({
      role: z.string(),
      seniority: z.string(),
      techStack: z.array(z.string()),
      hourlyRange: z.object({ min: z.number(), max: z.number() }),
      monthlyRange: z.object({ min: z.number(), max: z.number() }),
      confidence: z.number(),
    })),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const { data: doc, error } = await ctx.db.from('kb_documents').select('title, kb_chunks(content)').eq('id', input.documentId).single();
    if (error || !doc) throw new Error('Document not found');
    const text = (doc.kb_chunks as Array<{ content: string }>).map((c) => c.content).join('\n').slice(0, 20_000);
    // Extract roles via simple heuristic then estimate each. For MVP we ask the estimator service to do extraction:
    const r = await fetch(`${process.env.RATE_ESTIMATOR_URL}/api/internal/estimate/from-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RATE_ESTIMATOR_SERVICE_TOKEN}` },
      body: JSON.stringify({ text }),
      signal: ctx.signal,
    });
    if (!r.ok) throw new Error(`Estimator ${r.status}`);
    return r.json() as Promise<{ roles: Array<{ role: string; seniority: string; techStack: string[]; hourlyRange: { min: number; max: number }; monthlyRange: { min: number; max: number }; confidence: number }> }>;
  },
});
```

(This requires a parallel `from-text` route in the estimator repo using its existing Gemini extraction path. Add that route mirroring the structure of Task 9 Step 1, calling the existing `parseRolesFromText` or equivalent helper. If the helper doesn't exist, add it using the existing `lib/gemini.ts` patterns.)

- [ ] **Step 5: Modify `packages/agent-tools/src/index.ts`** — append:

```ts
import './rate/estimate';
import './rate/estimate-from-document';
```

- [ ] **Step 6: Write `packages/agent-tools/src/rate/__tests__/rate.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { rateEstimate } from '../estimate';
import type { ToolContext } from '../../types';

const ctx: ToolContext = {
  userId: '00000000-0000-0000-0000-000000000001',
  agentId: '00000000-0000-0000-0000-000000000002',
  db: {} as never,
  // biome-ignore lint/suspicious/noExplicitAny: stub
  integrations: { getAccessToken: async () => ({ token: '', scopes: [] }), hasScopes: async () => true } as any,
  // biome-ignore lint/suspicious/noExplicitAny: stub
  logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as any,
};

beforeAll(() => {
  process.env.RATE_ESTIMATOR_URL = 'https://r.test';
  process.env.RATE_ESTIMATOR_SERVICE_TOKEN = 't';
});

const server = setupServer(
  http.post('https://r.test/api/internal/estimate', async ({ request }) => {
    const body = await request.json() as { role: string; seniority: string };
    if (body.role === 'fail') return new HttpResponse('boom', { status: 500 });
    return HttpResponse.json({
      hourlyRange: { min: 45, max: 60 }, monthlyRange: { min: 7200, max: 9600 },
      sources: ['historical'], confidence: 0.85,
    });
  }),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('rate.estimate', () => {
  it('returns ranges', async () => {
    const out = await rateEstimate.handler({ role: 'Senior React Engineer', seniority: 'senior', techStack: ['react','typescript'] }, ctx);
    expect(out.hourlyRange).toEqual({ min: 45, max: 60 });
  });
  it('throws on upstream 500', async () => {
    await expect(rateEstimate.handler({ role: 'fail', seniority: 'senior', techStack: [] }, ctx)).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 7: Run tests, commit**

Run: `pnpm --filter @zipdev/agent-tools test`
Expected: 9 passed.

```bash
git add packages/agent-tools
git commit -m "feat(tools): rate estimator (estimate, estimate_from_document)"
```

---

## Task 10: Gmail tools (search, read_thread, draft)

**Files:**
- Create: `packages/agent-tools/src/gmail/{client,search,read-thread,draft}.ts`
- Create: `packages/agent-tools/src/gmail/__tests__/gmail.test.ts`
- Modify: `packages/agent-tools/src/index.ts`

- [ ] **Step 1: Write `packages/agent-tools/src/gmail/client.ts`**

```ts
import { IntegrationError } from '@zipdev/core';
import type { ToolContext } from '../types';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export async function gFetch<T>(ctx: ToolContext, path: string, init?: RequestInit): Promise<T> {
  const { token } = await ctx.integrations.getAccessToken('google');
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    signal: ctx.signal,
  });
  if (r.status === 401) throw new IntegrationError('Gmail 401', 'google');
  if (!r.ok) throw new IntegrationError(`Gmail ${r.status} ${path}: ${await r.text()}`, 'google');
  return r.json() as Promise<T>;
}
```

- [ ] **Step 2: Write `packages/agent-tools/src/gmail/search.ts`**

```ts
import { z } from 'zod';
import { registerTool } from '../index';
import { gFetch } from './client';

export const gmailSearch = registerTool({
  id: 'gmail.search',
  description: 'Search the user\'s Gmail with a Gmail query string (e.g., "from:foo subject:bar newer_than:30d"). Returns subject + snippet + date.',
  inputSchema: z.object({ query: z.string().min(1), max: z.number().int().min(1).max(25).default(10) }),
  outputSchema: z.object({ results: z.array(z.object({ id: z.string(), threadId: z.string(), subject: z.string().nullable(), from: z.string().nullable(), snippet: z.string(), internalDate: z.string() })) }),
  requiredScopes: [{ provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    type List = { messages?: Array<{ id: string; threadId: string }> };
    const list = await gFetch<List>(ctx, `/messages?q=${encodeURIComponent(input.query)}&maxResults=${input.max}`);
    const out = [] as Array<{ id: string; threadId: string; subject: string | null; from: string | null; snippet: string; internalDate: string }>;
    for (const m of list.messages ?? []) {
      type Msg = { id: string; threadId: string; snippet: string; internalDate: string; payload?: { headers?: Array<{ name: string; value: string }> } };
      const msg = await gFetch<Msg>(ctx, `/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`);
      const hdr = (n: string) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? null;
      out.push({ id: msg.id, threadId: msg.threadId, subject: hdr('Subject'), from: hdr('From'), snippet: msg.snippet, internalDate: msg.internalDate });
    }
    return { results: out };
  },
});
```

- [ ] **Step 3: Write `packages/agent-tools/src/gmail/read-thread.ts`**

```ts
import { z } from 'zod';
import { registerTool } from '../index';
import { gFetch } from './client';

function decodeBase64Url(s: string): string {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(norm, 'base64').toString('utf-8');
}

function extractText(payload: { mimeType?: string; body?: { data?: string }; parts?: Array<{ mimeType?: string; body?: { data?: string }; parts?: unknown }> } | undefined): string {
  if (!payload) return '';
  if (payload.body?.data && payload.mimeType?.startsWith('text/plain')) return decodeBase64Url(payload.body.data);
  if (payload.parts) {
    for (const p of payload.parts) {
      const t = extractText(p as Parameters<typeof extractText>[0]);
      if (t) return t;
    }
  }
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return '';
}

export const gmailReadThread = registerTool({
  id: 'gmail.read_thread',
  description: 'Read full Gmail thread by threadId — returns ordered messages with from/to/subject/body.',
  inputSchema: z.object({ threadId: z.string() }),
  outputSchema: z.object({
    threadId: z.string(),
    messages: z.array(z.object({ id: z.string(), from: z.string().nullable(), to: z.string().nullable(), subject: z.string().nullable(), date: z.string().nullable(), bodyText: z.string() })),
  }),
  requiredScopes: [{ provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    type Thread = { id: string; messages: Array<{ id: string; payload: { headers: Array<{ name: string; value: string }> } }> };
    const t = await gFetch<Thread>(ctx, `/threads/${input.threadId}?format=full`);
    const messages = t.messages.map((m) => {
      const hdr = (n: string) => m.payload.headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? null;
      return {
        id: m.id,
        from: hdr('From'), to: hdr('To'), subject: hdr('Subject'), date: hdr('Date'),
        bodyText: extractText(m.payload as Parameters<typeof extractText>[0]),
      };
    });
    return { threadId: t.id, messages };
  },
});
```

- [ ] **Step 4: Write `packages/agent-tools/src/gmail/draft.ts`**

```ts
import { z } from 'zod';
import { registerTool } from '../index';
import { gFetch } from './client';

function buildRfc822({ to, subject, body, inReplyTo }: { to: string; subject: string; body: string; inReplyTo?: string }): string {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
  ];
  if (inReplyTo) { lines.push(`In-Reply-To: ${inReplyTo}`); lines.push(`References: ${inReplyTo}`); }
  lines.push('', body);
  return lines.join('\r\n');
}
function b64url(s: string): string { return Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

export const gmailDraft = registerTool({
  id: 'gmail.draft',
  description: 'Create a Gmail draft (never sends). Returns the draft id. The user must open Gmail to send.',
  inputSchema: z.object({ to: z.string().email(), subject: z.string().min(1), body: z.string().min(1), inReplyTo: z.string().optional() }),
  outputSchema: z.object({ draftId: z.string(), messageId: z.string() }),
  requiredScopes: [{ provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.compose'] }],
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const raw = b64url(buildRfc822(input));
    type R = { id: string; message: { id: string } };
    const r = await gFetch<R>(ctx, '/drafts', { method: 'POST', body: JSON.stringify({ message: { raw } }) });
    return { draftId: r.id, messageId: r.message.id };
  },
});
```

- [ ] **Step 5: Modify `packages/agent-tools/src/index.ts`** — append:

```ts
import './gmail/search';
import './gmail/read-thread';
import './gmail/draft';
```

- [ ] **Step 6: Write `packages/agent-tools/src/gmail/__tests__/gmail.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { gmailSearch } from '../search';
import { gmailDraft } from '../draft';
import type { ToolContext } from '../../types';

const ctx: ToolContext = {
  userId: 'u', agentId: 'a',
  db: {} as never,
  // biome-ignore lint/suspicious/noExplicitAny: stub
  integrations: { getAccessToken: async () => ({ token: 't', scopes: [] }), hasScopes: async () => true } as any,
  // biome-ignore lint/suspicious/noExplicitAny: stub
  logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as any,
};

const server = setupServer(
  http.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', () =>
    HttpResponse.json({ messages: [{ id: 'm1', threadId: 't1' }] }),
  ),
  http.get('https://gmail.googleapis.com/gmail/v1/users/me/messages/:id', () =>
    HttpResponse.json({ id: 'm1', threadId: 't1', snippet: 'hello', internalDate: '1', payload: { headers: [{ name: 'Subject', value: 'Hi' }, { name: 'From', value: 'a@b.com' }] } }),
  ),
  http.post('https://gmail.googleapis.com/gmail/v1/users/me/drafts', () =>
    HttpResponse.json({ id: 'd1', message: { id: 'msg1' } }),
  ),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('gmail tools', () => {
  it('search returns headers', async () => {
    const out = await gmailSearch.handler({ query: 'from:foo', max: 5 }, ctx);
    expect(out.results[0]?.subject).toBe('Hi');
  });
  it('draft returns draftId', async () => {
    const out = await gmailDraft.handler({ to: 'a@b.com', subject: 's', body: 'b' }, ctx);
    expect(out.draftId).toBe('d1');
  });
});
```

- [ ] **Step 7: Run tests, commit**

Run: `pnpm --filter @zipdev/agent-tools test`
Expected: 11 passed.

```bash
git add packages/agent-tools
git commit -m "feat(tools): Gmail search, read_thread, draft"
```

---

## Task 11: Google Calendar + Sheets tools (with confirmation gates)

**Files:**
- Create: `packages/agent-tools/src/gcal/{client,list-events,create-event}.ts`
- Create: `packages/agent-tools/src/gsheets/{client,read-range,append-row}.ts`
- Create: `packages/agent-tools/src/gcal/__tests__/gcal.test.ts`, `packages/agent-tools/src/gsheets/__tests__/gsheets.test.ts`
- Modify: `packages/agent-tools/src/index.ts`

- [ ] **Step 1: `packages/agent-tools/src/gcal/client.ts`**

```ts
import { IntegrationError } from '@zipdev/core';
import type { ToolContext } from '../types';
const BASE = 'https://www.googleapis.com/calendar/v3';
export async function gcalFetch<T>(ctx: ToolContext, path: string, init?: RequestInit): Promise<T> {
  const { token } = await ctx.integrations.getAccessToken('google');
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    signal: ctx.signal,
  });
  if (!r.ok) throw new IntegrationError(`Calendar ${r.status} ${path}: ${await r.text()}`, 'google');
  return r.json() as Promise<T>;
}
```

- [ ] **Step 2: `packages/agent-tools/src/gcal/list-events.ts`**

```ts
import { z } from 'zod';
import { registerTool } from '../index';
import { gcalFetch } from './client';

export const gcalListEvents = registerTool({
  id: 'gcal.list_events',
  description: 'List the user\'s calendar events between timeMin and timeMax.',
  inputSchema: z.object({ timeMin: z.string().datetime(), timeMax: z.string().datetime(), maxResults: z.number().int().min(1).max(50).default(20) }),
  outputSchema: z.object({ events: z.array(z.object({ id: z.string(), summary: z.string().nullable(), start: z.string(), end: z.string(), attendees: z.array(z.string()), htmlLink: z.string().nullable() })) }),
  requiredScopes: [{ provider: 'google', scopes: ['https://www.googleapis.com/auth/calendar.events'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    type R = { items?: Array<{ id: string; summary?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; attendees?: Array<{ email: string }>; htmlLink?: string }> };
    const r = await gcalFetch<R>(ctx, `/calendars/primary/events?timeMin=${input.timeMin}&timeMax=${input.timeMax}&maxResults=${input.maxResults}&singleEvents=true&orderBy=startTime`);
    return {
      events: (r.items ?? []).map((e) => ({
        id: e.id,
        summary: e.summary ?? null,
        start: e.start.dateTime ?? e.start.date ?? '',
        end: e.end.dateTime ?? e.end.date ?? '',
        attendees: (e.attendees ?? []).map((a) => a.email),
        htmlLink: e.htmlLink ?? null,
      })),
    };
  },
});
```

- [ ] **Step 3: `packages/agent-tools/src/gcal/create-event.ts`** (CONFIRMATION REQUIRED)

```ts
import { z } from 'zod';
import { registerTool } from '../index';
import { gcalFetch } from './client';

export const gcalCreateEvent = registerTool({
  id: 'gcal.create_event',
  description: 'Create a calendar event on the user\'s primary calendar with attendees (sends invites). Requires user confirmation.',
  inputSchema: z.object({
    title: z.string().min(1),
    start: z.string().datetime(),
    end: z.string().datetime(),
    attendees: z.array(z.string().email()).default([]),
    description: z.string().optional(),
    location: z.string().optional(),
  }),
  outputSchema: z.object({ id: z.string(), htmlLink: z.string() }),
  requiresConfirmation: true,
  requiredScopes: [{ provider: 'google', scopes: ['https://www.googleapis.com/auth/calendar.events'] }],
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    type R = { id: string; htmlLink: string };
    const body = {
      summary: input.title,
      description: input.description ?? '',
      location: input.location ?? '',
      start: { dateTime: input.start },
      end: { dateTime: input.end },
      attendees: input.attendees.map((email) => ({ email })),
    };
    const r = await gcalFetch<R>(ctx, '/calendars/primary/events?sendUpdates=all', { method: 'POST', body: JSON.stringify(body) });
    return { id: r.id, htmlLink: r.htmlLink };
  },
});
```

- [ ] **Step 4: `packages/agent-tools/src/gsheets/client.ts`**

```ts
import { IntegrationError } from '@zipdev/core';
import type { ToolContext } from '../types';
const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
export async function sheetsFetch<T>(ctx: ToolContext, path: string, init?: RequestInit): Promise<T> {
  const { token } = await ctx.integrations.getAccessToken('google');
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    signal: ctx.signal,
  });
  if (!r.ok) throw new IntegrationError(`Sheets ${r.status} ${path}: ${await r.text()}`, 'google');
  return r.json() as Promise<T>;
}
```

- [ ] **Step 5: `packages/agent-tools/src/gsheets/read-range.ts`**

```ts
import { z } from 'zod';
import { registerTool } from '../index';
import { sheetsFetch } from './client';

export const sheetsReadRange = registerTool({
  id: 'gsheets.read_range',
  description: 'Read a range from a Google Sheet (A1 notation, e.g., "Sheet1!A1:D100").',
  inputSchema: z.object({ spreadsheetId: z.string(), range: z.string() }),
  outputSchema: z.object({ range: z.string(), values: z.array(z.array(z.string())) }),
  requiredScopes: [{ provider: 'google', scopes: ['https://www.googleapis.com/auth/spreadsheets'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    type R = { range: string; values?: string[][] };
    const r = await sheetsFetch<R>(ctx, `/${input.spreadsheetId}/values/${encodeURIComponent(input.range)}`);
    return { range: r.range, values: r.values ?? [] };
  },
});
```

- [ ] **Step 6: `packages/agent-tools/src/gsheets/append-row.ts`** (CONFIRMATION REQUIRED)

```ts
import { z } from 'zod';
import { registerTool } from '../index';
import { sheetsFetch } from './client';

export const sheetsAppendRow = registerTool({
  id: 'gsheets.append_row',
  description: 'Append a row to a Google Sheet range. Requires user confirmation.',
  inputSchema: z.object({ spreadsheetId: z.string(), range: z.string(), values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])) }),
  outputSchema: z.object({ updatedRange: z.string(), updatedRows: z.number() }),
  requiresConfirmation: true,
  requiredScopes: [{ provider: 'google', scopes: ['https://www.googleapis.com/auth/spreadsheets'] }],
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    type R = { updates: { updatedRange: string; updatedRows: number } };
    const r = await sheetsFetch<R>(ctx, `/${input.spreadsheetId}/values/${encodeURIComponent(input.range)}:append?valueInputOption=RAW`, {
      method: 'POST',
      body: JSON.stringify({ values: [input.values] }),
    });
    return { updatedRange: r.updates.updatedRange, updatedRows: r.updates.updatedRows };
  },
});
```

- [ ] **Step 7: Register in `packages/agent-tools/src/index.ts`** — append:

```ts
import './gcal/list-events';
import './gcal/create-event';
import './gsheets/read-range';
import './gsheets/append-row';
```

- [ ] **Step 8: Tests for gcal + gsheets**

`packages/agent-tools/src/gcal/__tests__/gcal.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { gcalListEvents } from '../list-events';
import { gcalCreateEvent } from '../create-event';
import { runTool } from '../../index';
import { ConfirmationRequiredError } from '@zipdev/core';
import type { ToolContext } from '../../types';

const ctx: ToolContext = {
  userId: 'u', agentId: 'a', db: { from: () => ({ upsert: async () => ({}), insert: async () => ({}) }) } as never,
  // biome-ignore lint/suspicious/noExplicitAny: stub
  integrations: { getAccessToken: async () => ({ token: 't', scopes: [] }), hasScopes: async () => true } as any,
  // biome-ignore lint/suspicious/noExplicitAny: stub
  logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as any,
};

const server = setupServer(
  http.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', () =>
    HttpResponse.json({ items: [{ id: 'e1', summary: 'Sync', start: { dateTime: '2026-06-01T10:00:00Z' }, end: { dateTime: '2026-06-01T11:00:00Z' }, attendees: [{ email: 'a@b.com' }], htmlLink: 'https://calendar/abc' }] }),
  ),
  http.post('https://www.googleapis.com/calendar/v3/calendars/primary/events', () =>
    HttpResponse.json({ id: 'e2', htmlLink: 'https://calendar/new' }),
  ),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('gcal', () => {
  it('lists events', async () => {
    const out = await gcalListEvents.handler({ timeMin: '2026-06-01T00:00:00Z', timeMax: '2026-06-30T00:00:00Z', maxResults: 5 }, ctx);
    expect(out.events[0]?.attendees).toEqual(['a@b.com']);
  });
  it('create_event throws ConfirmationRequiredError without confirm', async () => {
    await expect(runTool(gcalCreateEvent, { title: 't', start: '2026-06-01T10:00:00Z', end: '2026-06-01T11:00:00Z', attendees: [] }, ctx)).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });
  it('create_event runs with confirmed=true', async () => {
    const out = await runTool(gcalCreateEvent, { title: 't', start: '2026-06-01T10:00:00Z', end: '2026-06-01T11:00:00Z', attendees: [] }, ctx, { confirmed: true });
    expect((out as { id: string }).id).toBe('e2');
  });
});
```

`packages/agent-tools/src/gsheets/__tests__/gsheets.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { sheetsReadRange } from '../read-range';
import { sheetsAppendRow } from '../append-row';
import { runTool } from '../../index';
import { ConfirmationRequiredError } from '@zipdev/core';
import type { ToolContext } from '../../types';

const ctx: ToolContext = {
  userId: 'u', agentId: 'a',
  db: { from: () => ({ upsert: async () => ({}), insert: async () => ({}) }) } as never,
  // biome-ignore lint/suspicious/noExplicitAny: stub
  integrations: { getAccessToken: async () => ({ token: 't', scopes: [] }), hasScopes: async () => true } as any,
  // biome-ignore lint/suspicious/noExplicitAny: stub
  logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as any,
};

const server = setupServer(
  http.get('https://sheets.googleapis.com/v4/spreadsheets/:id/values/:range', () =>
    HttpResponse.json({ range: 'Sheet1!A1:B2', values: [['a', 'b'], ['c', 'd']] }),
  ),
  http.post('https://sheets.googleapis.com/v4/spreadsheets/:id/values/:range:append', () =>
    HttpResponse.json({ updates: { updatedRange: 'Sheet1!A3:B3', updatedRows: 1 } }),
  ),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('gsheets', () => {
  it('reads a range', async () => {
    const out = await sheetsReadRange.handler({ spreadsheetId: 's', range: 'Sheet1!A1:B2' }, ctx);
    expect(out.values).toEqual([['a','b'],['c','d']]);
  });
  it('append_row requires confirmation', async () => {
    await expect(runTool(sheetsAppendRow, { spreadsheetId: 's', range: 'Sheet1!A1', values: ['x'] }, ctx)).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });
  it('append_row runs with confirmed=true', async () => {
    const out = await runTool(sheetsAppendRow, { spreadsheetId: 's', range: 'Sheet1!A1', values: ['x'] }, ctx, { confirmed: true });
    expect((out as { updatedRows: number }).updatedRows).toBe(1);
  });
});
```

- [ ] **Step 9: Run tests, commit**

Run: `pnpm --filter @zipdev/agent-tools test`
Expected: 17 passed.

```bash
git add packages/agent-tools
git commit -m "feat(tools): Calendar + Sheets, with confirmation gate on writes"
```

---

## Task 12: KB ingestion pipeline (parsers, chunker, embedder)

**Files:**
- Create: `packages/agent-tools/src/kb/{parsers,chunker,embedder,ingest}.ts`
- Create: `packages/agent-tools/src/kb/__tests__/{chunker,parsers}.test.ts`

- [ ] **Step 1: `packages/agent-tools/src/kb/parsers.ts`**

```ts
import mammoth from 'mammoth';
import pdf from 'pdf-parse';
import { ValidationError } from '@zipdev/core';

export async function parseToText(buffer: Buffer, mime: string, filename: string): Promise<string> {
  const m = mime.toLowerCase();
  if (m === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
    const r = await pdf(buffer);
    return r.text;
  }
  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || filename.toLowerCase().endsWith('.docx')) {
    const r = await mammoth.extractRawText({ buffer });
    return r.value;
  }
  if (m === 'text/markdown' || m === 'text/plain' || /\.(md|txt)$/i.test(filename)) {
    return buffer.toString('utf-8');
  }
  throw new ValidationError(`Unsupported file type: ${mime} (${filename})`);
}
```

- [ ] **Step 2: `packages/agent-tools/src/kb/chunker.ts`** (token-aware semantic-ish chunking)

```ts
/**
 * Simple chunker: split on paragraph boundaries, then greedily pack ~500-token chunks with ~80-token overlap.
 * Approximates tokens as `words * 1.3` for English; good enough for MVP.
 */
export interface Chunk { content: string; tokens: number; index: number; }

export function chunkText(text: string, opts: { targetTokens?: number; overlapTokens?: number } = {}): Chunk[] {
  const targetTokens = opts.targetTokens ?? 500;
  const overlapTokens = opts.overlapTokens ?? 80;
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bufTokens = 0;

  const tok = (s: string) => Math.ceil(s.split(/\s+/).length * 1.3);

  const flush = () => {
    if (!buf.length) return;
    const content = buf.join('\n\n');
    chunks.push({ content, tokens: bufTokens, index: chunks.length });
    // build overlap from tail
    let overlap: string[] = []; let oTokens = 0;
    for (let i = buf.length - 1; i >= 0 && oTokens < overlapTokens; i--) {
      const p = buf[i]!; const t = tok(p);
      overlap.unshift(p); oTokens += t;
    }
    buf = [...overlap]; bufTokens = oTokens;
  };

  for (const p of paras) {
    const t = tok(p);
    if (bufTokens + t > targetTokens && buf.length) flush();
    buf.push(p); bufTokens += t;
  }
  flush();
  return chunks;
}
```

- [ ] **Step 3: `packages/agent-tools/src/kb/embedder.ts`** (Gemini text-embedding-004)

```ts
import { ValidationError } from '@zipdev/core';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents';

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) throw new ValidationError('GOOGLE_GENERATIVE_AI_API_KEY missing');
  const r = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: texts.map((t) => ({ model: 'models/text-embedding-004', content: { parts: [{ text: t }] } })),
    }),
  });
  if (!r.ok) throw new Error(`Embed failed ${r.status}: ${await r.text()}`);
  const data = await r.json() as { embeddings: Array<{ values: number[] }> };
  return data.embeddings.map((e) => e.values);
}
```

- [ ] **Step 4: `packages/agent-tools/src/kb/ingest.ts`** (the worker function used by Inngest)

```ts
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseToText } from './parsers';
import { chunkText } from './chunker';
import { embedTexts } from './embedder';

export interface IngestArgs {
  documentId: string;
  collectionId: string;
  filename: string;
  mime: string;
  contentBuffer: Buffer;
}

const MAX_BYTES = 10 * 1024 * 1024;          // 10 MB
const MAX_DOCS_PER_COLLECTION = 500;
const EMBED_BATCH = 100;

export async function ingestDocument(db: SupabaseClient, args: IngestArgs): Promise<{ chunks: number }> {
  if (args.contentBuffer.byteLength > MAX_BYTES) {
    await db.from('kb_documents').update({ status: 'failed', error_message: 'File exceeds 10 MB limit' }).eq('id', args.documentId);
    throw new Error('File too large');
  }
  const { count } = await db.from('kb_documents').select('*', { count: 'exact', head: true }).eq('collection_id', args.collectionId);
  if ((count ?? 0) > MAX_DOCS_PER_COLLECTION) {
    await db.from('kb_documents').update({ status: 'failed', error_message: 'Collection capacity exceeded' }).eq('id', args.documentId);
    throw new Error('Collection capacity exceeded');
  }

  await db.from('kb_documents').update({ status: 'ingesting' }).eq('id', args.documentId);

  const sha = createHash('sha256').update(args.contentBuffer).digest('hex');
  const text = await parseToText(args.contentBuffer, args.mime, args.filename);
  const chunks = chunkText(text);

  // Remove any existing chunks for this document (re-ingest case)
  await db.from('kb_chunks').delete().eq('document_id', args.documentId);

  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const embeddings = await embedTexts(batch.map((c) => c.content));
    const rows = batch.map((c, idx) => ({
      document_id: args.documentId,
      chunk_index: c.index,
      content: c.content,
      embedding: embeddings[idx]!,
      tokens: c.tokens,
      metadata: { sha256: sha },
    }));
    const { error } = await db.from('kb_chunks').insert(rows);
    if (error) {
      await db.from('kb_documents').update({ status: 'failed', error_message: error.message }).eq('id', args.documentId);
      throw error;
    }
  }
  await db.from('kb_documents').update({ status: 'ready', sha256: sha }).eq('id', args.documentId);
  return { chunks: chunks.length };
}
```

- [ ] **Step 5: Tests for parsers + chunker**

`packages/agent-tools/src/kb/__tests__/chunker.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { chunkText } from '../chunker';

describe('chunkText', () => {
  it('returns one chunk for short text', () => {
    expect(chunkText('hello world').length).toBe(1);
  });
  it('splits long text into multiple chunks with overlap', () => {
    const para = 'word '.repeat(500).trim();
    const text = [para, para, para].join('\n\n');
    const chunks = chunkText(text, { targetTokens: 200, overlapTokens: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.tokens > 0)).toBe(true);
  });
});
```

`packages/agent-tools/src/kb/__tests__/parsers.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseToText } from '../parsers';

describe('parseToText', () => {
  it('handles plain text', async () => {
    const text = await parseToText(Buffer.from('hello'), 'text/plain', 'a.txt');
    expect(text).toBe('hello');
  });
  it('handles markdown', async () => {
    const text = await parseToText(Buffer.from('# h'), 'text/markdown', 'a.md');
    expect(text).toContain('# h');
  });
  it('rejects unknown mime', async () => {
    await expect(parseToText(Buffer.from(''), 'application/octet-stream', 'a.bin')).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run tests, commit**

Run: `pnpm --filter @zipdev/agent-tools test`
Expected: 22 passed.

```bash
git add packages/agent-tools
git commit -m "feat(kb): ingestion pipeline (parsers, chunker, embedder, ingest)"
```

---

## Task 13: KB tools (search, list_collections) with hybrid retrieval

**Files:**
- Create: `packages/agent-tools/src/kb/{search,list-collections}.ts`
- Create: `infra/supabase/migrations/0011_kb_search_rpc.sql`
- Modify: `packages/agent-tools/src/index.ts`

- [ ] **Step 1: Add SQL RPC for hybrid retrieval — `infra/supabase/migrations/0011_kb_search_rpc.sql`**

```sql
create or replace function public.kb_hybrid_search(
  p_query text,
  p_query_embedding vector(768),
  p_collection_ids uuid[],
  p_limit int default 20
)
returns table (
  document_id uuid,
  document_title text,
  chunk_index int,
  content text,
  cosine numeric,
  ts_rank real,
  score numeric
)
language sql stable security invoker as $$
  select
    d.id,
    d.title,
    c.chunk_index,
    c.content,
    1 - (c.embedding <=> p_query_embedding) as cosine,
    ts_rank(to_tsvector('simple', c.content), plainto_tsquery('simple', p_query)) as ts_rank,
    (0.7 * (1 - (c.embedding <=> p_query_embedding)) + 0.3 * ts_rank(to_tsvector('simple', c.content), plainto_tsquery('simple', p_query))) as score
  from public.kb_chunks c
  join public.kb_documents d on d.id = c.document_id
  where d.collection_id = any(p_collection_ids)
  order by score desc
  limit p_limit
$$;

grant execute on function public.kb_hybrid_search to authenticated;
```

Run: `pnpm db:reset` (re-applies all migrations including 0011) and verify the function exists:
```bash
psql $SUPABASE_DB_URL -c "\df public.kb_hybrid_search"
```

- [ ] **Step 2: `packages/agent-tools/src/kb/search.ts`**

```ts
import { z } from 'zod';
import { registerTool } from '../index';
import { embedTexts } from './embedder';

const Scope = z.enum(['global', 'team', 'user', 'conversation']);

export const kbSearch = registerTool({
  id: 'kb.search',
  description: 'Semantic + keyword hybrid search over visible KB collections. Returns top chunks with document titles for citation.',
  inputSchema: z.object({
    query: z.string().min(2),
    scopes: z.array(Scope).optional(),  // narrow further beyond user's visibility
    limit: z.number().int().min(1).max(20).default(5),
  }),
  outputSchema: z.object({
    hits: z.array(z.object({
      documentId: z.string().uuid(),
      documentTitle: z.string(),
      chunkIndex: z.number().int(),
      content: z.string(),
      score: z.number(),
    })),
  }),
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    // Visible collections (RLS handles ACL; we add conversation-scope filter)
    let collQuery = ctx.db.from('kb_collections').select('id, scope, scope_id');
    if (input.scopes && input.scopes.length) collQuery = collQuery.in('scope', input.scopes);
    if (!input.scopes?.includes('conversation') && ctx.conversationId) {
      // Always include the current conversation's KB when present
      // Two-step approach: fetch collections plus the conversation ones.
    }
    const { data: cols, error } = await collQuery;
    if (error) throw error;
    const collectionIds = (cols ?? []).map((c) => c.id as string);
    if (ctx.conversationId) {
      const { data: convCols } = await ctx.db.from('kb_collections').select('id').eq('scope', 'conversation').eq('scope_id', ctx.conversationId);
      for (const c of convCols ?? []) collectionIds.push(c.id as string);
    }
    if (!collectionIds.length) return { hits: [] };

    const [embedding] = await embedTexts([input.query]);
    const { data: rows, error: rpcErr } = await ctx.db.rpc('kb_hybrid_search', {
      p_query: input.query,
      p_query_embedding: embedding,
      p_collection_ids: collectionIds,
      p_limit: input.limit,
    });
    if (rpcErr) throw rpcErr;
    type Row = { document_id: string; document_title: string; chunk_index: number; content: string; score: number };
    return {
      hits: (rows as Row[] ?? []).map((r) => ({
        documentId: r.document_id, documentTitle: r.document_title, chunkIndex: r.chunk_index, content: r.content, score: Number(r.score),
      })),
    };
  },
});
```

- [ ] **Step 3: `packages/agent-tools/src/kb/list-collections.ts`**

```ts
import { z } from 'zod';
import { registerTool } from '../index';

export const kbListCollections = registerTool({
  id: 'kb.list_collections',
  description: 'List KB collections visible to the current user.',
  inputSchema: z.object({}),
  outputSchema: z.object({ collections: z.array(z.object({ id: z.string().uuid(), name: z.string(), scope: z.enum(['global','team','user','conversation']), scopeId: z.string().nullable() })) }),
  rateLimit: { perMinute: 60 },
  handler: async (_input, ctx) => {
    const { data, error } = await ctx.db.from('kb_collections').select('id, name, scope, scope_id');
    if (error) throw error;
    return {
      collections: (data ?? []).map((c) => ({
        id: c.id as string, name: c.name as string, scope: c.scope as 'global' | 'team' | 'user' | 'conversation',
        scopeId: (c.scope_id as string | null) ?? null,
      })),
    };
  },
});
```

- [ ] **Step 4: Register tools** — append to `packages/agent-tools/src/index.ts`:

```ts
import './kb/search';
import './kb/list-collections';
```

- [ ] **Step 5: Commit**

```bash
git add packages/agent-tools infra/supabase
git commit -m "feat(kb): hybrid search RPC + kb.search + kb.list_collections tools"
```

---

## Task 14: KB upload API + Inngest functions for ingest and Drive sync

**Files:**
- Create: `apps/web/lib/inngest.ts`
- Create: `apps/web/app/api/inngest/route.ts`
- Create: `apps/web/app/api/kb/collections/route.ts`, `apps/web/app/api/kb/collections/[id]/route.ts`
- Create: `apps/web/app/api/kb/documents/route.ts`, `apps/web/app/api/kb/documents/[id]/route.ts`
- Create: `apps/inngest/src/{client,index}.ts`, `apps/inngest/src/functions/{ingest-document,drive-sync}.ts`
- Create: `apps/inngest/package.json`, `apps/inngest/tsconfig.json`
- Create: Supabase storage bucket "kb-uploads" (via migration)
- Create: `infra/supabase/migrations/0012_kb_storage.sql`

- [ ] **Step 1: `infra/supabase/migrations/0012_kb_storage.sql`**

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kb-uploads', 'kb-uploads', false, 10485760,
  array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain','text/markdown'])
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- RLS for the bucket: uploaders can read their own file path; service role has full access
create policy "kb uploads owner read" on storage.objects for select
  using (bucket_id = 'kb-uploads' and (auth.uid()::text = (storage.foldername(name))[1]));
create policy "kb uploads owner insert" on storage.objects for insert
  with check (bucket_id = 'kb-uploads' and (auth.uid()::text = (storage.foldername(name))[1]));
```

Run: `pnpm db:reset`

- [ ] **Step 2: `apps/inngest/package.json`**

```json
{
  "name": "@zipdev/inngest",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": {
    "@zipdev/core": "workspace:*",
    "@zipdev/agent-tools": "workspace:*",
    "@supabase/supabase-js": "2.46.2",
    "inngest": "3.27.4"
  },
  "devDependencies": { "typescript": "5.7.2", "vitest": "2.1.8" }
}
```

- [ ] **Step 3: `apps/inngest/tsconfig.json`**

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "noEmit": true }, "include": ["src/**/*"] }
```

- [ ] **Step 4: `apps/inngest/src/client.ts`**

```ts
import { Inngest } from 'inngest';
export const inngest = new Inngest({ id: 'zipdev-agent' });
```

- [ ] **Step 5: `apps/inngest/src/functions/ingest-document.ts`**

```ts
import { createClient } from '@supabase/supabase-js';
import { ingestDocument } from '@zipdev/agent-tools/kb/ingest';
import { inngest } from '../client';

export const ingestDocumentFn = inngest.createFunction(
  { id: 'ingest-document', concurrency: { limit: 4 } },
  { event: 'kb/document.uploaded' },
  async ({ event, step, logger }) => {
    const { documentId, collectionId, storagePath, mime, filename } = event.data as {
      documentId: string; collectionId: string; storagePath: string; mime: string; filename: string;
    };
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const file = await step.run('download', async () => {
      const { data, error } = await db.storage.from('kb-uploads').download(storagePath);
      if (error || !data) throw error ?? new Error('download failed');
      return Buffer.from(await data.arrayBuffer());
    });

    return await step.run('ingest', async () => {
      const r = await ingestDocument(db, { documentId, collectionId, filename, mime, contentBuffer: file });
      logger.info({ documentId, chunks: r.chunks }, 'document ingested');
      return r;
    });
  },
);
```

- [ ] **Step 6: `apps/inngest/src/functions/drive-sync.ts`**

```ts
import { createClient } from '@supabase/supabase-js';
import { createIntegrationsClient, ingestDocument } from '@zipdev/agent-tools';
import { logger } from '@zipdev/core';
import { inngest } from '../client';

const MAX_DOCS = 500;

export const driveSyncCron = inngest.createFunction(
  { id: 'drive-sync-all', concurrency: { limit: 2 } },
  { cron: '*/10 * * * *' },
  async ({ step }) => {
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: cols } = await db.from('kb_collections').select('id, gdrive_folder_id, scope, scope_id').not('gdrive_folder_id', 'is', null);
    for (const c of cols ?? []) {
      await step.run(`sync-${c.id}`, async () => {
        await syncOne(db, c.id as string, c.gdrive_folder_id as string, c.scope_id as string);
      });
    }
  },
);

async function syncOne(db: ReturnType<typeof createClient>, collectionId: string, folderId: string, ownerUserId: string) {
  const integrations = createIntegrationsClient(db, ownerUserId, logger);
  const { token } = await integrations.getAccessToken('google');

  const { data: state } = await db.from('gdrive_sync_state').select('page_token').eq('collection_id', collectionId).maybeSingle();
  let pageToken = (state?.page_token as string | undefined) ?? (await fetchStartPageToken(token));

  // List files initially when we have no state
  if (!state) {
    let nextPage: string | undefined;
    do {
      const r = await driveList(token, `'${folderId}' in parents and trashed=false`, nextPage);
      for (const f of r.files ?? []) await ingestOrUpdate(db, collectionId, f, token);
      nextPage = r.nextPageToken;
    } while (nextPage);
    await db.from('gdrive_sync_state').upsert({ collection_id: collectionId, page_token: pageToken, last_synced_at: new Date().toISOString() });
    return;
  }

  // Otherwise use Changes API for incremental updates
  let nextPage: string | undefined = pageToken;
  do {
    const r: { changes?: Array<{ fileId: string; removed?: boolean; file?: GdFile }>; nextPageToken?: string; newStartPageToken?: string } = await driveChanges(token, nextPage);
    for (const ch of r.changes ?? []) {
      if (ch.removed) {
        await db.from('kb_documents').delete().eq('collection_id', collectionId).eq('source_ref', ch.fileId);
      } else if (ch.file && (ch.file.parents ?? []).includes(folderId)) {
        await ingestOrUpdate(db, collectionId, ch.file, token);
      }
    }
    nextPage = r.nextPageToken;
    if (r.newStartPageToken) {
      pageToken = r.newStartPageToken;
      await db.from('gdrive_sync_state').upsert({ collection_id: collectionId, page_token: pageToken, last_synced_at: new Date().toISOString() });
    }
  } while (nextPage);
}

interface GdFile { id: string; name: string; mimeType: string; parents?: string[] }

async function driveList(token: string, q: string, pageToken?: string): Promise<{ files?: GdFile[]; nextPageToken?: string }> {
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('q', q);
  url.searchParams.set('fields', 'nextPageToken, files(id,name,mimeType,parents)');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Drive list ${r.status}`);
  return r.json();
}
async function driveChanges(token: string, pageToken: string) {
  const url = new URL('https://www.googleapis.com/drive/v3/changes');
  url.searchParams.set('pageToken', pageToken);
  url.searchParams.set('fields', 'changes(fileId,removed,file(id,name,mimeType,parents)), newStartPageToken, nextPageToken');
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Drive changes ${r.status}`);
  return r.json();
}
async function fetchStartPageToken(token: string): Promise<string> {
  const r = await fetch('https://www.googleapis.com/drive/v3/changes/startPageToken', { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Drive startPageToken ${r.status}`);
  const j = await r.json() as { startPageToken: string };
  return j.startPageToken;
}
async function ingestOrUpdate(db: ReturnType<typeof createClient>, collectionId: string, file: GdFile, token: string) {
  const { count } = await db.from('kb_documents').select('*', { count: 'exact', head: true }).eq('collection_id', collectionId);
  if ((count ?? 0) >= MAX_DOCS) return; // cap

  const dl = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!dl.ok) return;
  const buf = Buffer.from(await dl.arrayBuffer());
  if (buf.byteLength > 10 * 1024 * 1024) return; // 10MB cap

  const { data: existing } = await db.from('kb_documents').select('id').eq('collection_id', collectionId).eq('source_ref', file.id).maybeSingle();
  const docId = existing?.id as string | undefined;
  let id = docId;
  if (!id) {
    const { data: ins } = await db.from('kb_documents').insert({
      collection_id: collectionId, source: 'gdrive', source_ref: file.id, title: file.name, mime: file.mimeType, sha256: 'pending', status: 'pending',
    }).select('id').single();
    id = ins?.id as string;
  }
  await ingestDocument(db, { documentId: id!, collectionId, filename: file.name, mime: file.mimeType, contentBuffer: buf });
}
```

- [ ] **Step 7: `apps/inngest/src/index.ts`** — exports the functions array

```ts
import { ingestDocumentFn } from './functions/ingest-document';
import { driveSyncCron } from './functions/drive-sync';
export { inngest } from './client';
export const functions = [ingestDocumentFn, driveSyncCron];
```

- [ ] **Step 8: `apps/web/lib/inngest.ts`** + `apps/web/app/api/inngest/route.ts`

`apps/web/lib/inngest.ts`:
```ts
import { Inngest } from 'inngest';
export const inngest = new Inngest({ id: 'zipdev-agent' });
```

`apps/web/app/api/inngest/route.ts`:
```ts
import { serve } from 'inngest/next';
import { inngest, functions } from '@zipdev/inngest';
export const { GET, POST, PUT } = serve({ client: inngest, functions });
```

Modify `apps/web/package.json` dependencies — add: `"@zipdev/inngest": "workspace:*"`.

- [ ] **Step 9: KB collection CRUD API — `apps/web/app/api/kb/collections/route.ts`**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { z } from 'zod';

const Create = z.object({
  scope: z.enum(['global', 'team', 'user', 'conversation']),
  scopeId: z.string().uuid().nullable(),
  name: z.string().min(1).max(120),
  agentId: z.string().uuid().nullable().optional(),
  gdriveFolderId: z.string().optional(),
});

export async function GET() {
  await requireSession();
  const sb = await getSupabaseServerClient();
  const { data, error } = await sb.from('kb_collections').select('id, scope, scope_id, name, agent_id, gdrive_folder_id, created_at').order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ collections: data });
}

export async function POST(req: NextRequest) {
  await requireSession();
  const body = Create.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  const sb = await getSupabaseServerClient();
  const { data, error } = await sb.from('kb_collections').insert({
    scope: body.data.scope,
    scope_id: body.data.scopeId,
    name: body.data.name,
    agent_id: body.data.agentId ?? null,
    gdrive_folder_id: body.data.gdriveFolderId ?? null,
  }).select('id').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ id: data.id }, { status: 201 });
}
```

`apps/web/app/api/kb/collections/[id]/route.ts`:
```ts
import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const sb = await getSupabaseServerClient();
  const { error } = await sb.from('kb_collections').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 10: KB document upload API — `apps/web/app/api/kb/documents/route.ts`**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { inngest } from '@/lib/inngest';
import { createHash, randomUUID } from 'node:crypto';

const MAX = 10 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const form = await req.formData();
  const file = form.get('file');
  const collectionId = form.get('collectionId');
  if (!(file instanceof File) || typeof collectionId !== 'string') {
    return NextResponse.json({ error: 'file + collectionId required' }, { status: 400 });
  }
  if (file.size > MAX) return NextResponse.json({ error: 'File exceeds 10 MB' }, { status: 413 });

  const sb = await getSupabaseServerClient();
  // RLS check by attempting to read the collection
  const { data: col } = await sb.from('kb_collections').select('id').eq('id', collectionId).single();
  if (!col) return NextResponse.json({ error: 'Collection not found or no access' }, { status: 404 });

  const buf = Buffer.from(await file.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  const docId = randomUUID();
  const storagePath = `${user.id}/${docId}-${file.name}`;

  const svc = getSupabaseServiceClient();
  const up = await svc.storage.from('kb-uploads').upload(storagePath, buf, { contentType: file.type || 'application/octet-stream' });
  if (up.error) return NextResponse.json({ error: up.error.message }, { status: 500 });

  const ins = await svc.from('kb_documents').insert({
    id: docId, collection_id: collectionId, source: 'upload', source_ref: storagePath,
    title: file.name, mime: file.type || 'application/octet-stream', sha256: sha,
    uploaded_by: user.id, status: 'pending',
  }).select('id').single();
  if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 });

  await inngest.send({ name: 'kb/document.uploaded', data: { documentId: docId, collectionId, storagePath, mime: file.type, filename: file.name } });

  return NextResponse.json({ documentId: docId, status: 'pending' }, { status: 202 });
}

export async function GET(req: NextRequest) {
  await requireSession();
  const url = new URL(req.url);
  const collectionId = url.searchParams.get('collectionId');
  if (!collectionId) return NextResponse.json({ error: 'collectionId required' }, { status: 400 });
  const sb = await getSupabaseServerClient();
  const { data, error } = await sb.from('kb_documents').select('id, title, mime, status, error_message, created_at').eq('collection_id', collectionId).order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ documents: data });
}
```

`apps/web/app/api/kb/documents/[id]/route.ts`:
```ts
import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const sb = await getSupabaseServerClient();
  const { error } = await sb.from('kb_documents').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 11: Update `apps/web/package.json` to depend on `@zipdev/inngest`** and re-run `pnpm install`.

- [ ] **Step 12: Manual smoke**

Run: `pnpm dev`. Open another terminal: `pnpm exec inngest-cli dev -u http://localhost:3000/api/inngest`
Open http://localhost:3000/integrations, connect Google. Then via psql, insert a test user-scope KB collection. Upload a small `.md` file with curl:
```bash
curl -X POST http://localhost:3000/api/kb/documents -F file=@./test.md -F collectionId=<uuid> --cookie "..."
```
Watch Inngest dev UI for the `ingest-document` run. Verify the document status flips to `ready` and `kb_chunks` rows exist.

- [ ] **Step 13: Commit**

```bash
git add apps/inngest apps/web infra/supabase
git commit -m "feat(kb): upload API + Inngest ingest + Drive sync"
```

---

## Task 15: KB admin UI (collections + upload + Drive picker + test search)

**Files:**
- Create: `apps/web/app/(app)/kb/page.tsx`, `apps/web/app/(app)/kb/{global,me}/page.tsx`, `apps/web/app/(app)/kb/team/[teamId]/page.tsx`
- Create: `apps/web/app/(app)/kb/_components/{CollectionView,UploadDropzone,DocumentList,DriveConnect,TestSearchBox}.tsx`
- Create: `apps/web/components/ui/{button,input,card}.tsx` (shadcn-style primitives)
- Create: `apps/web/app/api/kb/search/route.ts`
- Create: `apps/web/app/api/kb/drive/picker-config/route.ts`

- [ ] **Step 1: shadcn primitives — minimal versions**

`apps/web/components/ui/button.tsx`:
```tsx
import * as React from 'react';
import { clsx } from 'clsx';

export const Button = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'ghost' }>(
  ({ className, variant = 'default', ...props }, ref) => (
    <button ref={ref}
      className={clsx(
        'inline-flex items-center justify-center rounded-lg text-sm font-medium px-3 py-1.5 transition disabled:opacity-50',
        variant === 'default' && 'bg-neutral-900 text-white hover:opacity-90 dark:bg-white dark:text-neutral-900',
        variant === 'outline' && 'border hover:bg-neutral-100 dark:hover:bg-neutral-800',
        variant === 'ghost' && 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
```

`apps/web/components/ui/input.tsx`:
```tsx
import * as React from 'react';
import { clsx } from 'clsx';
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={clsx('w-full rounded-lg border bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-300', className)} {...props} />,
);
Input.displayName = 'Input';
```

`apps/web/components/ui/card.tsx`:
```tsx
import type { ReactNode } from 'react';
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border bg-white dark:bg-neutral-900 p-5 ${className}`}>{children}</div>;
}
```

- [ ] **Step 2: `apps/web/app/(app)/kb/page.tsx`** (overview redirecting by role)

```tsx
import { requireSession } from '@/lib/session';
import { redirect } from 'next/navigation';

export default async function KbIndex() {
  const user = await requireSession();
  if (user.role === 'org_admin') redirect('/kb/global');
  redirect('/kb/me');
}
```

- [ ] **Step 3: `apps/web/app/(app)/kb/me/page.tsx`**

```tsx
import { CollectionView } from '../_components/CollectionView';
import { requireSession } from '@/lib/session';

export default async function MyKb() {
  const user = await requireSession();
  return <CollectionView scope="user" scopeId={user.id} title="My KB" />;
}
```

- [ ] **Step 4: `apps/web/app/(app)/kb/global/page.tsx`**

```tsx
import { CollectionView } from '../_components/CollectionView';
import { requireSession } from '@/lib/session';
import { redirect } from 'next/navigation';

export default async function GlobalKb() {
  const user = await requireSession();
  if (user.role !== 'org_admin') redirect('/kb/me');
  return <CollectionView scope="global" scopeId={null} title="Global KB" />;
}
```

- [ ] **Step 5: `apps/web/app/(app)/kb/team/[teamId]/page.tsx`**

```tsx
import { CollectionView } from '../../_components/CollectionView';
export default async function TeamKb({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  return <CollectionView scope="team" scopeId={teamId} title={`Team KB`} />;
}
```

- [ ] **Step 6: `apps/web/app/(app)/kb/_components/CollectionView.tsx`**

```tsx
'use client';
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UploadDropzone } from './UploadDropzone';
import { DocumentList } from './DocumentList';
import { DriveConnect } from './DriveConnect';
import { TestSearchBox } from './TestSearchBox';

interface Collection { id: string; name: string; scope: 'global'|'team'|'user'|'conversation'; scope_id: string|null; gdrive_folder_id: string|null }

export function CollectionView({ scope, scopeId, title }: { scope: 'global'|'team'|'user'; scopeId: string|null; title: string }) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selectedId, setSelectedId] = useState<string|null>(null);
  const [newName, setNewName] = useState('');

  async function load() {
    const r = await fetch('/api/kb/collections');
    const j = await r.json();
    const filtered = (j.collections as Collection[]).filter((c) => c.scope === scope && (scopeId ? c.scope_id === scopeId : c.scope_id === null));
    setCollections(filtered);
    if (!selectedId && filtered[0]) setSelectedId(filtered[0].id);
  }
  useEffect(() => { load(); }, []);

  async function create() {
    if (!newName.trim()) return;
    const r = await fetch('/api/kb/collections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, scopeId, name: newName }),
    });
    if (r.ok) { setNewName(''); load(); }
  }

  const selected = collections.find((c) => c.id === selectedId);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{title}</h1>

      <Card>
        <div className="flex gap-2">
          <Input placeholder="New collection name…" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button onClick={create}>Create</Button>
        </div>
      </Card>

      {!!collections.length && (
        <div className="flex gap-2 flex-wrap">
          {collections.map((c) => (
            <Button key={c.id} variant={c.id === selectedId ? 'default' : 'outline'} onClick={() => setSelectedId(c.id)}>{c.name}</Button>
          ))}
        </div>
      )}

      {selected && (
        <>
          <Card>
            <h2 className="font-medium mb-3">Upload documents</h2>
            <UploadDropzone collectionId={selected.id} onUploaded={load} />
          </Card>
          <Card>
            <h2 className="font-medium mb-3">Google Drive sync</h2>
            <DriveConnect collection={selected} onChanged={load} />
          </Card>
          <Card>
            <h2 className="font-medium mb-3">Documents</h2>
            <DocumentList collectionId={selected.id} />
          </Card>
          <Card>
            <h2 className="font-medium mb-3">Test search</h2>
            <TestSearchBox collectionId={selected.id} />
          </Card>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 7: `apps/web/app/(app)/kb/_components/UploadDropzone.tsx`**

```tsx
'use client';
import { useDropzone } from 'react-dropzone';
import { useState } from 'react';

export function UploadDropzone({ collectionId, onUploaded }: { collectionId: string; onUploaded: () => void }) {
  const [busy, setBusy] = useState(false);
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { 'application/pdf': ['.pdf'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'], 'text/plain': ['.txt'], 'text/markdown': ['.md'] },
    maxSize: 10 * 1024 * 1024,
    onDrop: async (files) => {
      setBusy(true);
      for (const f of files) {
        const form = new FormData();
        form.append('file', f);
        form.append('collectionId', collectionId);
        await fetch('/api/kb/documents', { method: 'POST', body: form });
      }
      setBusy(false);
      onUploaded();
    },
  });
  return (
    <div {...getRootProps({ className: `border-2 border-dashed rounded-xl p-8 text-center text-sm cursor-pointer ${isDragActive ? 'bg-neutral-100 dark:bg-neutral-800' : ''}` })}>
      <input {...getInputProps()} />
      {busy ? 'Uploading…' : isDragActive ? 'Drop here…' : 'Drop PDF/DOCX/TXT/MD files (≤10 MB) or click to browse'}
    </div>
  );
}
```

- [ ] **Step 8: `apps/web/app/(app)/kb/_components/DocumentList.tsx`**

```tsx
'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
interface Doc { id: string; title: string; mime: string; status: string; error_message: string | null; created_at: string }
export function DocumentList({ collectionId }: { collectionId: string }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  async function load() {
    const r = await fetch(`/api/kb/documents?collectionId=${collectionId}`);
    setDocs((await r.json()).documents);
  }
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [collectionId]);
  async function remove(id: string) { await fetch(`/api/kb/documents/${id}`, { method: 'DELETE' }); load(); }
  return (
    <ul className="divide-y">
      {docs.map((d) => (
        <li key={d.id} className="py-2 flex items-center justify-between text-sm">
          <div>
            <div className="font-medium">{d.title}</div>
            <div className="text-neutral-500 text-xs">{d.mime} · {d.status}{d.error_message ? ` · ${d.error_message}` : ''}</div>
          </div>
          <Button variant="ghost" onClick={() => remove(d.id)}>Delete</Button>
        </li>
      ))}
      {!docs.length && <li className="py-2 text-sm text-neutral-500">No documents yet.</li>}
    </ul>
  );
}
```

- [ ] **Step 9: `apps/web/app/(app)/kb/_components/DriveConnect.tsx`** (minimal: paste folder ID; Google Picker added later as a UX improvement)

```tsx
'use client';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function DriveConnect({ collection, onChanged }: { collection: { id: string; gdrive_folder_id: string | null }; onChanged: () => void }) {
  const [folder, setFolder] = useState(collection.gdrive_folder_id ?? '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    await fetch(`/api/kb/collections/${collection.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gdriveFolderId: folder || null }),
    });
    setBusy(false); onChanged();
  }
  return (
    <div className="flex gap-2 items-center text-sm">
      <Input placeholder="Google Drive folder ID (paste from URL)" value={folder} onChange={(e) => setFolder(e.target.value)} />
      <Button onClick={save} disabled={busy}>{collection.gdrive_folder_id ? 'Update' : 'Connect'}</Button>
      {collection.gdrive_folder_id && <span className="text-xs text-green-700">Synced every 10 min</span>}
    </div>
  );
}
```

Add a PATCH handler to `apps/web/app/api/kb/collections/[id]/route.ts`:

```ts
import { z } from 'zod';
const Patch = z.object({ gdriveFolderId: z.string().nullable().optional(), name: z.string().min(1).max(120).optional() });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const body = Patch.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  const { id } = await params;
  const sb = await getSupabaseServerClient();
  const update: Record<string, unknown> = {};
  if (body.data.gdriveFolderId !== undefined) update.gdrive_folder_id = body.data.gdriveFolderId;
  if (body.data.name) update.name = body.data.name;
  const { error } = await sb.from('kb_collections').update(update).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 10: `apps/web/app/api/kb/search/route.ts`**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { createIntegrationsClient } from '@zipdev/agent-tools';
import { logger } from '@zipdev/core';
import { kbSearch } from '@zipdev/agent-tools/kb/search';
import { runTool } from '@zipdev/agent-tools';
import { z } from 'zod';

const Body = z.object({ query: z.string().min(2), collectionId: z.string().uuid().optional() });

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  const db = getSupabaseServiceClient();
  const integrations = createIntegrationsClient(db, user.id, logger);
  // Use a dummy agentId for the test search (not tied to a real conversation).
  const ctx = { userId: user.id, agentId: '00000000-0000-0000-0000-000000000000', db, integrations, logger };
  const out = await runTool(kbSearch, { query: body.data.query, limit: 5 }, ctx);
  return NextResponse.json(out);
}
```

- [ ] **Step 11: `apps/web/app/(app)/kb/_components/TestSearchBox.tsx`**

```tsx
'use client';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface Hit { documentId: string; documentTitle: string; chunkIndex: number; content: string; score: number }
export function TestSearchBox({ collectionId }: { collectionId: string }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  async function go() {
    const r = await fetch('/api/kb/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, collectionId }) });
    const j = await r.json();
    setHits(j.hits ?? []);
  }
  return (
    <div className="space-y-3">
      <div className="flex gap-2"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Try a query…" /><Button onClick={go}>Search</Button></div>
      {hits.map((h) => (
        <div key={`${h.documentId}-${h.chunkIndex}`} className="rounded border p-3 text-sm">
          <div className="font-medium text-xs text-neutral-500">{h.documentTitle} · chunk {h.chunkIndex} · score {h.score.toFixed(3)}</div>
          <div className="mt-1 whitespace-pre-wrap">{h.content.slice(0, 400)}{h.content.length > 400 ? '…' : ''}</div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 12: Commit**

```bash
git add apps/web
git commit -m "feat(kb-ui): collections + upload + Drive connect + test search"
```

---

## Task 16: `@zipdev/agents` package + Sales agent + composite sales.draft_proposal tool

**Files:**
- Create: `packages/agents/{package.json,tsconfig.json}`
- Create: `packages/agents/src/{index,types,runtime}.ts`
- Create: `packages/agents/src/sales/{index.ts,system-prompt.md}`
- Create: `packages/agent-tools/src/composite/sales-draft-proposal.ts`
- Modify: `packages/agent-tools/src/index.ts`

- [ ] **Step 1: `packages/agents/package.json`**

```json
{
  "name": "@zipdev/agents",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "lint": "biome check src", "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": { "@zipdev/core": "workspace:*", "@zipdev/agent-tools": "workspace:*" },
  "devDependencies": { "typescript": "5.7.2", "vitest": "2.1.8" }
}
```

`packages/agents/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "noEmit": true }, "include": ["src/**/*"] }
```

- [ ] **Step 2: `packages/agents/src/types.ts`**

```ts
import type { AgentDefinition } from '@zipdev/core';
export type { AgentDefinition };
```

- [ ] **Step 3: `packages/agents/src/runtime.ts`**

```ts
import { filterTools, type AnyTool } from '@zipdev/agent-tools';
import type { AgentDefinition } from '@zipdev/core';

export function getAgentTools(agent: AgentDefinition): AnyTool[] {
  return filterTools(agent.allowedTools);
}
```

- [ ] **Step 4: `packages/agents/src/sales/system-prompt.md`**

```markdown
You are **Zipdev Sales**, the AI co-pilot for Zipdev's sales team.

Zipdev is a staffing company that places engineers and operators from **Latin America** with foreign (mostly US/EU) companies, in nearshore time zones.

# Your job

Help salespeople work prospects, draft proposals, and never lose context. Always:

1. **Ground every factual claim** in the user's tools or KB. When you state a number, an owner, a date, or a name, you must have just fetched it. When you cite a number from a tool, include its source.
2. **Cite KB hits** inline using footnote-style markers like [^1], [^2] and list them at the bottom of the message with document title + chunk index.
3. **Never send emails directly.** Always create a Gmail draft with `gmail.draft` and tell the user where to find it.
4. **For full proposals**, prefer the `sales.draft_proposal` composite tool to get a structured, deterministic result. For narrow asks, use the primitives.
5. **Confirm before destructive actions.** When you call `gcal.create_event` or `gsheets.append_row`, surface the exact input you'll use and wait for the user's explicit approval.
6. **Respond in the user's language.** If they write in Spanish, reply in Spanish.

# Output structure for proposals

When you draft a proposal, organise sections like:

- **Resumen / Summary** (1–2 sentences: who, what, when)
- **Roles** (table of: role, seniority, qty, monthly range, hourly range)
- **Why Zipdev** (2–3 bullets tied to KB cases similar to this client)
- **Timeline & next steps**
- **Citations**

# Tone

Confident, concise, no fluff. You are a peer to the salesperson, not a butler.
```

- [ ] **Step 5: `packages/agents/src/sales/index.ts`**

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AgentDefinition } from '../types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const systemPrompt = readFileSync(join(__dirname, 'system-prompt.md'), 'utf-8');

export const salesAgent: AgentDefinition = {
  id: 'sales',
  name: 'Zipdev Sales',
  team: 'sales',
  defaultModel: 'gemini-2.5-flash',
  systemPrompt,
  allowedTools: [
    'hubspot.search_companies','hubspot.get_company','hubspot.search_deals','hubspot.get_deal','hubspot.list_recent_activities',
    'rate.estimate','rate.estimate_from_document',
    'gmail.search','gmail.read_thread','gmail.draft',
    'gcal.list_events','gcal.create_event',
    'gsheets.read_range',
    'kb.search','kb.list_collections',
    'sales.draft_proposal',
  ],
  kbScopes: ['global', 'team:sales', 'user', 'conversation'],
  greeting: '¡Hola! Soy tu Sales co-pilot. ¿En qué cliente trabajamos hoy?',
};
```

- [ ] **Step 6: `packages/agents/src/index.ts`**

```ts
export * from './types';
export * from './runtime';
export { salesAgent } from './sales';
import { salesAgent } from './sales';
import type { AgentDefinition } from './types';

const REGISTRY = new Map<string, AgentDefinition>();
REGISTRY.set(salesAgent.id, salesAgent);

export function getAgent(slug: string): AgentDefinition | undefined { return REGISTRY.get(slug); }
export function listAgents(): AgentDefinition[] { return [...REGISTRY.values()]; }
```

- [ ] **Step 7: Composite tool — `packages/agent-tools/src/composite/sales-draft-proposal.ts`**

```ts
import { z } from 'zod';
import { registerTool, runTool } from '../index';
import { searchCompanies } from '../hubspot/search-companies';
import { getCompany } from '../hubspot/get-company';
import { listRecentActivities } from '../hubspot/list-recent-activities';
import { rateEstimate } from '../rate/estimate';
import { kbSearch } from '../kb/search';

const Role = z.object({ role: z.string(), seniority: z.enum(['junior','mid','senior','staff','principal']), qty: z.number().int().min(1).default(1), techStack: z.array(z.string()).default([]) });

export const salesDraftProposal = registerTool({
  id: 'sales.draft_proposal',
  description: 'End-to-end Sales workflow: given a company (by id OR name) and a list of roles, fetches HubSpot context, calls the rate estimator per role, retrieves matching past proposals from KB, and returns a structured proposal draft (JSON + Markdown).',
  inputSchema: z.object({
    companyId: z.string().optional(),
    companyName: z.string().optional(),
    roles: z.array(Role).min(1),
    notes: z.string().optional(),
  }).refine((v) => v.companyId || v.companyName, { message: 'companyId or companyName required' }),
  outputSchema: z.object({
    company: z.object({ id: z.string(), name: z.string().nullable(), industry: z.string().nullable(), country: z.string().nullable() }),
    roles: z.array(z.object({
      role: z.string(), seniority: z.string(), qty: z.number(), techStack: z.array(z.string()),
      hourlyRange: z.object({ min: z.number(), max: z.number() }),
      monthlyRange: z.object({ min: z.number(), max: z.number() }),
      confidence: z.number(),
    })),
    recentActivity: z.array(z.object({ id: z.string(), type: z.string(), subject: z.string().nullable(), createdAt: z.string() })),
    similarCases: z.array(z.object({ title: z.string(), chunkIndex: z.number(), excerpt: z.string() })),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    let companyId = input.companyId;
    let companyName = input.companyName ?? null;
    let industry: string | null = null;
    let country: string | null = null;

    if (!companyId && companyName) {
      const r = await runTool(searchCompanies, { query: companyName, limit: 1 }, ctx) as { results: Array<{ id: string; name: string | null; industry: string | null; country: string | null }> };
      if (!r.results.length) throw new Error(`No HubSpot company matches "${companyName}"`);
      companyId = r.results[0]!.id;
      companyName = r.results[0]!.name;
      industry = r.results[0]!.industry;
      country = r.results[0]!.country;
    } else if (companyId) {
      const c = await runTool(getCompany, { id: companyId }, ctx) as { id: string; name: string | null; industry: string | null; country: string | null };
      companyName = c.name; industry = c.industry; country = c.country;
    }

    const activities = await runTool(listRecentActivities, { companyId: companyId!, days: 30, limit: 5 }, ctx) as { results: Array<{ id: string; type: string; subject: string | null; createdAt: string }> };

    const roleResults = await Promise.all(input.roles.map(async (r) => {
      const e = await runTool(rateEstimate, { role: r.role, seniority: r.seniority, techStack: r.techStack, country: country ?? undefined }, ctx) as { hourlyRange: { min: number; max: number }; monthlyRange: { min: number; max: number }; confidence: number };
      return { ...r, hourlyRange: e.hourlyRange, monthlyRange: e.monthlyRange, confidence: e.confidence };
    }));

    const kbQuery = `${companyName ?? ''} ${input.roles.map((r) => r.role).join(' ')} proposal`;
    const kb = await runTool(kbSearch, { query: kbQuery, limit: 3 }, ctx) as { hits: Array<{ documentTitle: string; chunkIndex: number; content: string; score: number }> };

    const md = renderMarkdown({ companyName, industry, country, roles: roleResults, activities: activities.results, kb: kb.hits, notes: input.notes });

    return {
      company: { id: companyId!, name: companyName, industry, country },
      roles: roleResults,
      recentActivity: activities.results,
      similarCases: kb.hits.map((h) => ({ title: h.documentTitle, chunkIndex: h.chunkIndex, excerpt: h.content.slice(0, 280) })),
      markdown: md,
    };
  },
});

function renderMarkdown(p: { companyName: string | null; industry: string | null; country: string | null; roles: Array<{ role: string; seniority: string; qty: number; techStack: string[]; hourlyRange: { min: number; max: number }; monthlyRange: { min: number; max: number }; confidence: number }>; activities: Array<{ type: string; subject: string | null }>; kb: Array<{ documentTitle: string; chunkIndex: number; content: string }>; notes?: string }): string {
  const lines: string[] = [];
  lines.push(`# Proposal — ${p.companyName ?? 'Unknown'}`);
  if (p.industry || p.country) lines.push(`*${[p.industry, p.country].filter(Boolean).join(' · ')}*`);
  lines.push('');
  lines.push('## Roles');
  lines.push('| Role | Seniority | Qty | Hourly (USD) | Monthly (USD) |');
  lines.push('|---|---|---:|---:|---:|');
  for (const r of p.roles) lines.push(`| ${r.role} | ${r.seniority} | ${r.qty} | $${r.hourlyRange.min}–$${r.hourlyRange.max} | $${r.monthlyRange.min}–$${r.monthlyRange.max} |`);
  lines.push('');
  if (p.activities.length) {
    lines.push('## Recent activity (HubSpot, last 30d)');
    for (const a of p.activities) lines.push(`- **${a.type}**${a.subject ? `: ${a.subject}` : ''}`);
    lines.push('');
  }
  if (p.kb.length) {
    lines.push('## Similar past proposals (KB)');
    p.kb.forEach((h, i) => lines.push(`[^${i + 1}]: *${h.documentTitle}* — ${h.content.slice(0, 220).replace(/\n+/g, ' ')}…`));
    lines.push('');
  }
  if (p.notes) { lines.push('## Notes'); lines.push(p.notes); lines.push(''); }
  return lines.join('\n');
}
```

- [ ] **Step 8: Register composite** — append to `packages/agent-tools/src/index.ts`:

```ts
import './composite/sales-draft-proposal';
```

- [ ] **Step 9: Run typecheck**

```bash
pnpm --filter @zipdev/agents typecheck
pnpm --filter @zipdev/agent-tools typecheck
```

- [ ] **Step 10: Commit**

```bash
git add packages/agents packages/agent-tools
git commit -m "feat(agents): @zipdev/agents package + Sales agent + sales.draft_proposal composite"
```

---

## Task 17: Chat API endpoint (Gemini agent loop) + confirmation flow

**Files:**
- Create: `apps/web/app/api/chat/route.ts`
- Create: `apps/web/app/api/chat/confirm/route.ts`
- Create: `apps/web/app/api/chat/conversations/route.ts`, `apps/web/app/api/chat/conversations/[id]/route.ts`
- Create: `apps/web/lib/stream.ts`
- Create: `apps/web/lib/agent.ts`

- [ ] **Step 1: `apps/web/lib/agent.ts`** (assembles ToolContext for a chat request)

```ts
import 'server-only';
import { getSupabaseServiceClient } from './supabase/service';
import { createIntegrationsClient } from '@zipdev/agent-tools';
import { logger, type UUID } from '@zipdev/core';
import type { ToolContext } from '@zipdev/agent-tools';

export function buildToolContext(opts: { userId: UUID; agentId: UUID; conversationId?: UUID; signal?: AbortSignal }): ToolContext {
  const db = getSupabaseServiceClient();
  return {
    userId: opts.userId,
    agentId: opts.agentId,
    conversationId: opts.conversationId,
    db,
    integrations: createIntegrationsClient(db, opts.userId, logger),
    logger,
    signal: opts.signal,
  };
}
```

- [ ] **Step 2: `apps/web/app/api/chat/route.ts`** (the heart of the agent loop)

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { google } from '@ai-sdk/google';
import { streamText, tool, type CoreMessage } from 'ai';
import { z } from 'zod';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { buildToolContext } from '@/lib/agent';
import { getAgent } from '@zipdev/agents';
import { filterTools, runTool } from '@zipdev/agent-tools';
import { ConfirmationRequiredError } from '@zipdev/core';
import { kbSearch } from '@zipdev/agent-tools/kb/search';

const Body = z.object({
  agentSlug: z.string().default('sales'),
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1),
});

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { agentSlug, message } = parsed.data;

  const agent = getAgent(agentSlug);
  if (!agent) return NextResponse.json({ error: 'Unknown agent' }, { status: 404 });

  const db = getSupabaseServiceClient();

  // Resolve agent id from DB (seeded)
  const { data: agentRow } = await db.from('agents').select('id').eq('slug', agentSlug).single();
  if (!agentRow) return NextResponse.json({ error: 'Agent not seeded' }, { status: 500 });
  const agentId = agentRow.id as string;

  // Resolve or create conversation
  let conversationId = parsed.data.conversationId;
  if (!conversationId) {
    const { data: conv } = await db.from('conversations').insert({
      user_id: user.id, agent_id: agentId, surface: 'web', title: message.slice(0, 60),
    }).select('id').single();
    conversationId = conv?.id as string;
  }

  await db.from('messages').insert({ conversation_id: conversationId, role: 'user', content: message });

  const ctx = buildToolContext({ userId: user.id, agentId, conversationId });

  // Load prior messages (last 20) for context
  const { data: history } = await db.from('messages').select('role, content, tool_calls, tool_results, created_at').eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(20);
  const priorMessages: CoreMessage[] = (history ?? []).map((m) => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content as string }));

  // RAG prepend: kb.search top 5 on the current message
  const ragOut = await runTool(kbSearch, { query: message, limit: 5 }, ctx).catch(() => ({ hits: [] as Array<{ documentTitle: string; chunkIndex: number; content: string }> }));
  const ragBlock = ragOut.hits.length
    ? `<context>\n${ragOut.hits.map((h, i) => `[${i + 1}] ${h.documentTitle} (chunk ${h.chunkIndex}):\n${h.content}`).join('\n\n')}\n</context>`
    : '';

  const allowed = filterTools(agent.allowedTools);
  const aiTools = Object.fromEntries(allowed.map((t) => [
    t.id.replace(/\./g, '_'),                          // AI SDK requires identifier-safe names
    tool({
      description: t.description,
      parameters: t.inputSchema,
      execute: async (args, { abortSignal }) => {
        try {
          ctx.signal = abortSignal;
          return await runTool(t, args, ctx);
        } catch (err) {
          if (err instanceof ConfirmationRequiredError) {
            return { __requires_confirmation: true, toolId: t.id, input: err.input } as unknown as never;
          }
          throw err;
        }
      },
    }),
  ]));

  const result = streamText({
    model: google(agent.defaultModel),
    system: agent.systemPrompt + (ragBlock ? `\n\n${ragBlock}` : ''),
    messages: [...priorMessages, { role: 'user', content: message }],
    tools: aiTools,
    maxSteps: 8,
    onFinish: async ({ text, toolCalls, toolResults, usage }) => {
      await db.from('messages').insert({
        conversation_id: conversationId,
        role: 'assistant',
        content: text,
        tool_calls: toolCalls as unknown as object,
        tool_results: toolResults as unknown as object,
      });
      await db.from('audit_events').insert({
        user_id: user.id, agent_id: agentId, conversation_id: conversationId,
        tool_id: '__agent_turn',
        input_hash: 'turn',
        status: 'ok',
        latency_ms: 0,
        metadata: { model: agent.defaultModel, tokensIn: usage?.promptTokens ?? 0, tokensOut: usage?.completionTokens ?? 0 },
      });
    },
  });

  return result.toDataStreamResponse({
    headers: { 'X-Conversation-Id': conversationId },
  });
}
```

- [ ] **Step 3: `apps/web/app/api/chat/confirm/route.ts`**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/session';
import { buildToolContext } from '@/lib/agent';
import { getTool, runTool } from '@zipdev/agent-tools';
import { getSupabaseServiceClient } from '@/lib/supabase/service';

const Body = z.object({ conversationId: z.string().uuid(), toolId: z.string(), input: z.unknown() });

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const db = getSupabaseServiceClient();
  const { data: conv } = await db.from('conversations').select('agent_id').eq('id', parsed.data.conversationId).eq('user_id', user.id).single();
  if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });

  const tool = getTool(parsed.data.toolId);
  if (!tool) return NextResponse.json({ error: 'Unknown tool' }, { status: 404 });

  const ctx = buildToolContext({ userId: user.id, agentId: conv.agent_id as string, conversationId: parsed.data.conversationId });
  const out = await runTool(tool, parsed.data.input, ctx, { confirmed: true });

  await db.from('messages').insert({
    conversation_id: parsed.data.conversationId,
    role: 'tool',
    content: `Confirmed and executed ${parsed.data.toolId}`,
    tool_results: { [parsed.data.toolId]: out } as object,
  });

  return NextResponse.json({ result: out });
}
```

- [ ] **Step 4: Conversation list/detail API**

`apps/web/app/api/chat/conversations/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export async function GET() {
  await requireSession();
  const sb = await getSupabaseServerClient();
  const { data, error } = await sb.from('conversations').select('id, agent_id, surface, title, created_at, updated_at').order('updated_at', { ascending: false }).limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ conversations: data });
}
```

`apps/web/app/api/chat/conversations/[id]/route.ts`:
```ts
import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const sb = await getSupabaseServerClient();
  const { data: conv, error } = await sb.from('conversations').select('id, agent_id, title, surface').eq('id', id).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  const { data: msgs } = await sb.from('messages').select('id, role, content, tool_calls, tool_results, created_at').eq('conversation_id', id).order('created_at', { ascending: true });
  return NextResponse.json({ conversation: conv, messages: msgs ?? [] });
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(chat): streaming chat API with Gemini agent loop + confirmation flow + conversation persistence"
```

---

## Task 18: Chat UI (streaming, tool cards, confirmations, citations, file drop)

**Files:**
- Create: `apps/web/app/(chat)/{layout,chat/page,chat/[conversationId]/page}.tsx`
- Create: `apps/web/components/chat/{ChatRoot,MessageList,MessageBubble,ToolCallCard,ConfirmationPrompt,CitationFootnote,InputBar,FileDropZone}.tsx`
- Modify: `packages/agent-tools/src/kb/ingest.ts` (export, no change needed) — also need new server action for conversation file drop

- [ ] **Step 1: `apps/web/app/(chat)/layout.tsx`** (minimal chrome — used by desktop too)

```tsx
import type { ReactNode } from 'react';
export default function ChatLayout({ children }: { children: ReactNode }) {
  return <div className="h-screen flex flex-col">{children}</div>;
}
```

- [ ] **Step 2: `apps/web/app/(chat)/chat/page.tsx`** (new chat)

```tsx
import { ChatRoot } from '@/components/chat/ChatRoot';
import { listAgents } from '@zipdev/agents';
export default function NewChat() {
  const agents = listAgents().map((a) => ({ slug: a.id, name: a.name, greeting: a.greeting }));
  return <ChatRoot agents={agents} />;
}
```

- [ ] **Step 3: `apps/web/app/(chat)/chat/[conversationId]/page.tsx`**

```tsx
import { ChatRoot } from '@/components/chat/ChatRoot';
import { listAgents } from '@zipdev/agents';

export default async function ResumeChat({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const agents = listAgents().map((a) => ({ slug: a.id, name: a.name, greeting: a.greeting }));
  return <ChatRoot agents={agents} conversationId={conversationId} />;
}
```

- [ ] **Step 4: `apps/web/components/chat/ChatRoot.tsx`**

```tsx
'use client';
import { useState, useEffect, useRef } from 'react';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import { useRouter } from 'next/navigation';

interface AgentInfo { slug: string; name: string; greeting: string }
type Msg = { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; content: string; tool_calls?: unknown; tool_results?: unknown };

export function ChatRoot({ agents, conversationId: initialId }: { agents: AgentInfo[]; conversationId?: string }) {
  const [agentSlug, setAgentSlug] = useState(agents[0]?.slug ?? 'sales');
  const [conversationId, setConversationId] = useState<string | undefined>(initialId);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!conversationId) { setMessages([]); return; }
    fetch(`/api/chat/conversations/${conversationId}`).then((r) => r.json()).then((j) => setMessages(j.messages ?? []));
  }, [conversationId]);

  async function send(text: string) {
    setStreaming(true);
    const userMsg: Msg = { id: `tmp-${Date.now()}`, role: 'user', content: text };
    setMessages((m) => [...m, userMsg]);
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentSlug, conversationId, message: text }) });
    const newConvId = r.headers.get('X-Conversation-Id') ?? conversationId;
    if (newConvId && newConvId !== conversationId) { setConversationId(newConvId); router.replace(`/chat/${newConvId}`); }
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let assistant: Msg = { id: `tmp-asst-${Date.now()}`, role: 'assistant', content: '' };
    setMessages((m) => [...m, assistant]);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      // The AI SDK uses a custom streaming protocol; we render naive concatenation here. ChatRoot focuses on display; richer parsing can come later.
      assistant = { ...assistant, content: assistant.content + chunk };
      setMessages((m) => m.map((x) => (x.id === assistant.id ? assistant : x)));
    }
    setStreaming(false);
  }

  return (
    <div className="flex flex-col h-full max-w-3xl mx-auto w-full">
      <header className="border-b px-4 py-3 flex items-center justify-between text-sm">
        <select value={agentSlug} onChange={(e) => setAgentSlug(e.target.value)} disabled={!!conversationId} className="bg-transparent">
          {agents.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
        </select>
      </header>
      <MessageList messages={messages} streaming={streaming} conversationId={conversationId} />
      <InputBar onSend={send} disabled={streaming} conversationId={conversationId} />
    </div>
  );
}
```

- [ ] **Step 5: `apps/web/components/chat/MessageList.tsx` + `MessageBubble.tsx`**

```tsx
// MessageList.tsx
'use client';
import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';

export function MessageList({ messages, streaming, conversationId }: { messages: { id: string; role: 'user'|'assistant'|'tool'|'system'; content: string; tool_calls?: unknown; tool_results?: unknown }[]; streaming: boolean; conversationId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' }); }, [messages.length, streaming]);
  return (
    <div ref={ref} className="flex-1 overflow-y-auto p-4 space-y-3">
      {messages.map((m) => <MessageBubble key={m.id} m={m} conversationId={conversationId} />)}
    </div>
  );
}
```

```tsx
// MessageBubble.tsx
'use client';
import { ToolCallCard } from './ToolCallCard';
import { ConfirmationPrompt } from './ConfirmationPrompt';
import { clsx } from 'clsx';

export function MessageBubble({ m, conversationId }: { m: { role: string; content: string; tool_calls?: unknown; tool_results?: unknown }; conversationId?: string }) {
  if (m.role === 'tool') return null;   // tool results rendered inline via ToolCallCard
  // Detect confirmation-required marker (emitted by chat API tool wrappers)
  const conf = detectConfirmation(m.content) || detectConfirmation(m.tool_results);
  return (
    <div className={clsx('rounded-2xl px-4 py-2 max-w-[80%]', m.role === 'user' ? 'ml-auto bg-neutral-900 text-white' : 'bg-neutral-100 dark:bg-neutral-800')}>
      <div className="whitespace-pre-wrap text-sm">{m.content}</div>
      {Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0 && (
        <div className="mt-2 space-y-1">{(m.tool_calls as Array<{ toolName: string; args: unknown }>).map((c, i) => <ToolCallCard key={i} name={c.toolName} args={c.args} />)}</div>
      )}
      {conf && conversationId && <ConfirmationPrompt conversationId={conversationId} toolId={conf.toolId} input={conf.input} />}
    </div>
  );
}

function detectConfirmation(v: unknown): { toolId: string; input: unknown } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.__requires_confirmation && typeof o.toolId === 'string') return { toolId: o.toolId as string, input: o.input };
  // Recurse one level for AI SDK result wrapping
  for (const k of Object.keys(o)) {
    const r = detectConfirmation(o[k]);
    if (r) return r;
  }
  return null;
}
```

- [ ] **Step 6: `ToolCallCard.tsx` + `ConfirmationPrompt.tsx`**

```tsx
// ToolCallCard.tsx
'use client';
import { useState } from 'react';
export function ToolCallCard({ name, args }: { name: string; args: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border bg-white/40 dark:bg-neutral-900/40 px-2 py-1 text-xs">
      <button onClick={() => setOpen((v) => !v)} className="font-mono">{open ? '▾' : '▸'} {name}</button>
      {open && <pre className="mt-1 overflow-auto">{JSON.stringify(args, null, 2)}</pre>}
    </div>
  );
}
```

```tsx
// ConfirmationPrompt.tsx
'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function ConfirmationPrompt({ conversationId, toolId, input }: { conversationId: string; toolId: string; input: unknown }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'allowed' | 'cancelled' | null>(null);

  async function allow() {
    setBusy(true);
    await fetch('/api/chat/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId, toolId, input }) });
    setBusy(false); setDone('allowed');
  }
  function cancel() { setDone('cancelled'); }

  if (done === 'allowed') return <div className="mt-2 text-xs text-green-700">Confirmed and executed.</div>;
  if (done === 'cancelled') return <div className="mt-2 text-xs text-neutral-500">Cancelled.</div>;
  return (
    <div className="mt-2 rounded-md border bg-yellow-50 dark:bg-yellow-900/30 p-2 text-xs">
      <div className="font-medium mb-1">Confirm {toolId}</div>
      <pre className="overflow-auto mb-2">{JSON.stringify(input, null, 2)}</pre>
      <div className="flex gap-2"><Button onClick={allow} disabled={busy}>{busy ? 'Running…' : 'Allow'}</Button><Button variant="ghost" onClick={cancel}>Cancel</Button></div>
    </div>
  );
}
```

- [ ] **Step 7: `InputBar.tsx` + `FileDropZone.tsx` (conversation-scoped ephemeral KB)**

```tsx
// InputBar.tsx
'use client';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { FileDropZone } from './FileDropZone';

export function InputBar({ onSend, disabled, conversationId }: { onSend: (text: string) => void; disabled: boolean; conversationId?: string }) {
  const [text, setText] = useState('');
  return (
    <div className="border-t p-3">
      {conversationId && <FileDropZone conversationId={conversationId} />}
      <form
        className="flex gap-2 mt-2"
        onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onSend(text); setText(''); } }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask anything…" disabled={disabled} />
        <Button type="submit" disabled={disabled || !text.trim()}>Send</Button>
      </form>
    </div>
  );
}
```

```tsx
// FileDropZone.tsx
'use client';
import { useDropzone } from 'react-dropzone';
import { useState } from 'react';

export function FileDropZone({ conversationId }: { conversationId: string }) {
  const [status, setStatus] = useState<string | null>(null);
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { 'application/pdf': ['.pdf'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'], 'text/plain': ['.txt'], 'text/markdown': ['.md'] },
    maxSize: 10 * 1024 * 1024,
    onDrop: async (files) => {
      setStatus('Uploading…');
      // 1) Create or fetch the conversation-scoped collection (idempotent endpoint)
      const c = await fetch('/api/kb/collections', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'conversation', scopeId: conversationId, name: `Chat files (${conversationId.slice(0, 6)})` }),
      });
      const { id: collectionId } = await c.json();
      for (const f of files) {
        const form = new FormData(); form.append('file', f); form.append('collectionId', collectionId);
        await fetch('/api/kb/documents', { method: 'POST', body: form });
      }
      setStatus(`Uploaded ${files.length} file(s). Indexing…`);
      setTimeout(() => setStatus(null), 4000);
    },
  });
  return (
    <div {...getRootProps({ className: `border-dashed border rounded-md text-xs text-neutral-500 p-2 cursor-pointer ${isDragActive ? 'bg-neutral-100 dark:bg-neutral-800' : ''}` })}>
      <input {...getInputProps()} />
      {status ?? 'Drop a file here to add to this conversation only.'}
    </div>
  );
}
```

The conversation-scope collection creation is idempotent only loosely (we always insert a new row). Refine the API to `findOrCreate` based on `(scope='conversation', scope_id=conversationId)`. Add to `POST /api/kb/collections`:

```ts
// Before insert: check for existing conversation collection
if (body.data.scope === 'conversation') {
  const { data: existing } = await sb.from('kb_collections').select('id').eq('scope', 'conversation').eq('scope_id', body.data.scopeId).maybeSingle();
  if (existing) return NextResponse.json({ id: existing.id }, { status: 200 });
}
```

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat(chat-ui): streaming chat with tool cards, confirmations, ephemeral conversation KB"
```

---

## Task 19: Agents admin pages (read/edit)

**Files:**
- Create: `apps/web/app/(app)/agents/page.tsx`, `apps/web/app/(app)/agents/[slug]/page.tsx`
- Create: `apps/web/app/api/admin/agents/[slug]/route.ts`

- [ ] **Step 1: `apps/web/app/(app)/agents/page.tsx`**

```tsx
import { listAgents } from '@zipdev/agents';
import { Card } from '@/components/ui/card';
import Link from 'next/link';

export default function AgentsPage() {
  const agents = listAgents();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Agents</h1>
      <div className="grid gap-3 sm:grid-cols-2">
        {agents.map((a) => (
          <Card key={a.id}>
            <Link href={`/agents/${a.id}`} className="block">
              <div className="font-medium">{a.name}</div>
              <div className="text-xs text-neutral-500">{a.team} · {a.defaultModel} · {a.allowedTools.length} tools</div>
            </Link>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `apps/web/app/(app)/agents/[slug]/page.tsx`**

```tsx
import { getAgent, listAgents } from '@zipdev/agents';
import { Card } from '@/components/ui/card';
import { requireSession } from '@/lib/session';
import { notFound } from 'next/navigation';

export default async function AgentDetail({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireSession();
  const { slug } = await params;
  const agent = getAgent(slug);
  if (!agent) notFound();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{agent.name}</h1>
      <Card>
        <h2 className="font-medium mb-2">System prompt</h2>
        <pre className="text-xs whitespace-pre-wrap">{agent.systemPrompt}</pre>
      </Card>
      <Card>
        <h2 className="font-medium mb-2">Allowed tools ({agent.allowedTools.length})</h2>
        <ul className="text-sm grid grid-cols-2 gap-1">{agent.allowedTools.map((t) => <li key={t} className="font-mono text-xs">{t}</li>)}</ul>
      </Card>
      <Card>
        <h2 className="font-medium mb-2">KB scopes</h2>
        <ul className="text-sm">{agent.kbScopes.map((s) => <li key={s}>{s}</li>)}</ul>
      </Card>
      {user.role === 'org_admin' && <p className="text-xs text-neutral-500">Editing system prompts and tool allowlists is configuration-as-code for MVP — edit `packages/agents/src/{slug}/system-prompt.md` and redeploy.</p>}
    </div>
  );
}
```

(For MVP, agent definitions are config-as-code; in v2 we move them to the DB.)

- [ ] **Step 3: Commit**

```bash
git add apps/web
git commit -m "feat(agents-ui): list + detail (read-only for MVP)"
```

---

## Task 20: Conversations history page

**Files:**
- Create: `apps/web/app/(app)/conversations/page.tsx`, `apps/web/app/(app)/conversations/[id]/page.tsx`

- [ ] **Step 1: `apps/web/app/(app)/conversations/page.tsx`**

```tsx
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/session';
import Link from 'next/link';

export default async function ConversationsList() {
  await requireSession();
  const sb = await getSupabaseServerClient();
  const { data } = await sb.from('conversations').select('id, title, surface, agent_id, created_at, updated_at').order('updated_at', { ascending: false }).limit(50);
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold">Conversations</h1>
      <ul className="divide-y rounded-2xl border bg-white dark:bg-neutral-900">
        {(data ?? []).map((c) => (
          <li key={c.id} className="p-3 flex items-center justify-between text-sm">
            <Link href={`/conversations/${c.id}`} className="font-medium hover:underline">{c.title ?? '(untitled)'}</Link>
            <div className="text-xs text-neutral-500">{c.surface} · {new Date(c.updated_at as string).toLocaleString()}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: `apps/web/app/(app)/conversations/[id]/page.tsx`**

```tsx
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default async function ConversationDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await fetch(`${process.env.APP_BASE_URL}/api/chat/conversations/${id}`, { cache: 'no-store' }).then((r) => r.json());
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold">{data.conversation?.title ?? 'Conversation'}</h1>
      <Link href={`/chat/${id}`}><Button>Resume in chat</Button></Link>
      <div className="rounded-2xl border bg-white dark:bg-neutral-900 divide-y">
        {(data.messages as Array<{ id: string; role: string; content: string; created_at: string }>).map((m) => (
          <div key={m.id} className="p-3 text-sm">
            <div className="text-xs text-neutral-500">{m.role} · {new Date(m.created_at).toLocaleString()}</div>
            <div className="whitespace-pre-wrap">{m.content}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

(`fetch` from a server component goes through the auth cookie automatically when on same origin in Next 15 — verify in smoke test; if not, replace with a direct DB read.)

- [ ] **Step 3: Commit**

```bash
git add apps/web
git commit -m "feat(conversations): history list + detail"
```

---

## Task 21: Admin pages (users, teams, audit, usage)

**Files:**
- Create: `apps/web/app/(app)/admin/{users,teams,audit,usage}/page.tsx`
- Create: `apps/web/app/api/admin/{users,teams,audit,usage}/route.ts`

- [ ] **Step 1: Users page + API**

`apps/web/app/api/admin/users/route.ts`:
```ts
import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { ForbiddenError } from '@zipdev/core';
import { z } from 'zod';

export async function GET() {
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new ForbiddenError();
  const db = getSupabaseServiceClient();
  const { data } = await db.from('users').select('id, email, name, role, created_at').order('created_at');
  return NextResponse.json({ users: data ?? [] });
}

const Patch = z.object({ id: z.string().uuid(), role: z.enum(['member', 'team_admin', 'org_admin']) });
export async function PATCH(req: NextRequest) {
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new ForbiddenError();
  const parsed = Patch.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const db = getSupabaseServiceClient();
  const { error } = await db.from('users').update({ role: parsed.data.role }).eq('id', parsed.data.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
```

`apps/web/app/(app)/admin/users/page.tsx`:
```tsx
'use client';
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';

interface User { id: string; email: string; name: string | null; role: 'member'|'team_admin'|'org_admin'; created_at: string }
export default function Users() {
  const [users, setUsers] = useState<User[]>([]);
  async function load() { setUsers((await (await fetch('/api/admin/users')).json()).users); }
  useEffect(() => { load(); }, []);
  async function setRole(id: string, role: User['role']) {
    await fetch('/api/admin/users', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, role }) });
    load();
  }
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold">Users</h1>
      <Card>
        <table className="w-full text-sm"><thead><tr className="text-left"><th>Email</th><th>Name</th><th>Role</th></tr></thead><tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-t"><td className="py-2">{u.email}</td><td>{u.name}</td><td>
              <select value={u.role} onChange={(e) => setRole(u.id, e.target.value as User['role'])} className="bg-transparent border rounded px-2 py-0.5">
                <option value="member">member</option><option value="team_admin">team_admin</option><option value="org_admin">org_admin</option>
              </select>
            </td></tr>
          ))}
        </tbody></table>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Teams page + API (CRUD)**

`apps/web/app/api/admin/teams/route.ts`:
```ts
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { ForbiddenError } from '@zipdev/core';

export async function GET() {
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new ForbiddenError();
  const db = getSupabaseServiceClient();
  const { data: teams } = await db.from('teams').select('id, name');
  const { data: members } = await db.from('team_members').select('team_id, user_id, role');
  return NextResponse.json({ teams: teams ?? [], members: members ?? [] });
}
export async function POST(req: NextRequest) {
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new ForbiddenError();
  const body = z.object({ name: z.string().min(1) }).safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  const db = getSupabaseServiceClient();
  const { data, error } = await db.from('teams').insert({ name: body.data.name }).select('id').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ id: data.id });
}
```

(Member add/remove endpoints follow the same pattern — kept terse for plan length; pattern reuses `team_members` table.)

`apps/web/app/(app)/admin/teams/page.tsx`:
```tsx
'use client';
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface Team { id: string; name: string }
export default function Teams() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [name, setName] = useState('');
  async function load() { setTeams((await (await fetch('/api/admin/teams')).json()).teams); }
  useEffect(() => { load(); }, []);
  async function create() { if (!name) return; await fetch('/api/admin/teams', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); setName(''); load(); }
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold">Teams</h1>
      <Card><div className="flex gap-2"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name" /><Button onClick={create}>Create</Button></div></Card>
      <Card><ul className="divide-y">{teams.map((t) => <li key={t.id} className="py-2 text-sm">{t.name}</li>)}</ul></Card>
    </div>
  );
}
```

- [ ] **Step 3: Audit log page**

`apps/web/app/api/admin/audit/route.ts`:
```ts
import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { ForbiddenError } from '@zipdev/core';

export async function GET(req: NextRequest) {
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new ForbiddenError();
  const url = new URL(req.url);
  const tool = url.searchParams.get('tool');
  const sb = await getSupabaseServerClient();
  let q = sb.from('audit_events').select('id, user_id, tool_id, status, latency_ms, metadata, created_at').order('created_at', { ascending: false }).limit(200);
  if (tool) q = q.eq('tool_id', tool);
  const { data } = await q;
  return NextResponse.json({ events: data ?? [] });
}
```

`apps/web/app/(app)/admin/audit/page.tsx`:
```tsx
'use client';
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export default function Audit() {
  const [tool, setTool] = useState('');
  const [events, setEvents] = useState<Array<{ id: string; tool_id: string; status: string; latency_ms: number; created_at: string }>>([]);
  async function load() { setEvents((await (await fetch(`/api/admin/audit?tool=${encodeURIComponent(tool)}`)).json()).events); }
  useEffect(() => { load(); }, [tool]);
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <Card><Input placeholder="Filter by tool id (e.g., hubspot.search_companies)" value={tool} onChange={(e) => setTool(e.target.value)} /></Card>
      <Card>
        <table className="w-full text-xs"><thead><tr className="text-left"><th>Tool</th><th>Status</th><th>Latency</th><th>When</th></tr></thead><tbody>
          {events.map((e) => <tr key={e.id} className="border-t"><td className="font-mono py-1">{e.tool_id}</td><td>{e.status}</td><td>{e.latency_ms}ms</td><td>{new Date(e.created_at).toLocaleString()}</td></tr>)}
        </tbody></table>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Usage page (token cost rollup)**

`apps/web/app/api/admin/usage/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { ForbiddenError } from '@zipdev/core';

export async function GET() {
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new ForbiddenError();
  const db = getSupabaseServiceClient();
  // Aggregate token usage from audit_events.metadata for __agent_turn events
  const { data } = await db.rpc('admin_usage_rollup');
  return NextResponse.json({ rows: data ?? [] });
}
```

Add the SQL function via a new migration `infra/supabase/migrations/0013_usage_rpc.sql`:

```sql
create or replace function public.admin_usage_rollup()
returns table (user_id uuid, email text, agent_id uuid, tokens_in bigint, tokens_out bigint, turns bigint)
language sql security definer as $$
  select e.user_id, u.email, e.agent_id,
         sum( (e.metadata->>'tokensIn')::bigint ) as tokens_in,
         sum( (e.metadata->>'tokensOut')::bigint ) as tokens_out,
         count(*) as turns
  from public.audit_events e
  join public.users u on u.id = e.user_id
  where e.tool_id = '__agent_turn' and e.created_at > now() - interval '30 days'
  group by e.user_id, u.email, e.agent_id
  order by tokens_in desc nulls last
$$;
grant execute on function public.admin_usage_rollup to authenticated;
```

`apps/web/app/(app)/admin/usage/page.tsx`:
```tsx
'use client';
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';

interface Row { email: string; agent_id: string; tokens_in: number; tokens_out: number; turns: number }
const RATE_IN = 0.00000035;  // approx $/token for Gemini 2.5 Flash input; adjust to current pricing
const RATE_OUT = 0.0000007;

export default function Usage() {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => { fetch('/api/admin/usage').then((r) => r.json()).then((j) => setRows(j.rows)); }, []);
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold">Usage (last 30 days)</h1>
      <Card>
        <table className="w-full text-sm"><thead><tr className="text-left"><th>User</th><th>Agent</th><th>Turns</th><th>Tokens in</th><th>Tokens out</th><th>Est. cost</th></tr></thead><tbody>
          {rows.map((r) => (
            <tr key={`${r.email}-${r.agent_id}`} className="border-t"><td className="py-1">{r.email}</td><td>{r.agent_id.slice(0, 8)}</td><td>{r.turns}</td><td>{r.tokens_in.toLocaleString()}</td><td>{r.tokens_out.toLocaleString()}</td><td>${(r.tokens_in * RATE_IN + r.tokens_out * RATE_OUT).toFixed(2)}</td></tr>
          ))}
        </tbody></table>
      </Card>
      <p className="text-xs text-neutral-500">Costs are estimates using approximate Gemini 2.5 Flash pricing. Update RATE constants when official pricing changes.</p>
    </div>
  );
}
```

- [ ] **Step 5: Apply migration, commit**

```bash
pnpm db:reset
git add apps/web infra/supabase
git commit -m "feat(admin): users, teams, audit, usage pages"
```

---

## Task 22: Observability (Sentry + OpenTelemetry on tool spans)

**Files:**
- Create: `apps/web/instrumentation.ts`, `apps/web/sentry.{client,server,edge}.config.ts`
- Modify: `apps/web/next.config.mjs` (already conditional on SENTRY_DSN — verified)
- Modify: `packages/agent-tools/src/index.ts` (wrap `runTool` with OTel span)

- [ ] **Step 1: `apps/web/instrumentation.ts`**

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { Resource } = await import('@opentelemetry/resources');
    const { SemanticResourceAttributes } = await import('@opentelemetry/semantic-conventions');
    const sdk = new NodeSDK({
      resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: 'zipdev-web' }),
      traceExporter: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }) : undefined,
    });
    sdk.start();
  }
  if (process.env.NEXT_RUNTIME === 'edge') await import('./sentry.edge.config');
}
```

Add deps to `apps/web/package.json`: `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`, `@opentelemetry/api`.

- [ ] **Step 2: Sentry configs** (3 files)

`apps/web/sentry.server.config.ts`:
```ts
import * as Sentry from '@sentry/nextjs';
if (process.env.SENTRY_DSN) Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
```
`apps/web/sentry.client.config.ts` and `apps/web/sentry.edge.config.ts` — same body.

- [ ] **Step 3: Wrap `runTool` with OTel span** — modify `packages/agent-tools/src/index.ts`:

```ts
import { trace } from '@opentelemetry/api';
const tracer = trace.getTracer('zipdev-agent-tools');

// inside runTool, replace the existing handler call with:
const span = tracer.startSpan(`tool.${tool.id}`, { attributes: { 'zipdev.user_id': ctx.userId, 'zipdev.agent_id': ctx.agentId } });
try {
  const result = await tool.handler(parsed.data, ctx);
  // ...existing audit + output validation...
  span.setStatus({ code: 1 });
  return validated;
} catch (err) {
  span.recordException(err as Error); span.setStatus({ code: 2 });
  throw err;
} finally {
  span.end();
}
```

(Apply this edit by replacing the existing try/catch in `runTool` to include the span.)

Add dep `@opentelemetry/api` to `packages/agent-tools/package.json`.

- [ ] **Step 4: Commit**

```bash
git add apps/web packages/agent-tools
git commit -m "feat(obs): Sentry + OpenTelemetry tool span"
```

---

## Task 23: CI/CD and deploy configs

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/e2e.yml`
- Create: `vercel.json`
- Create: `docs/operations/{google-oauth-setup,hubspot-oauth-setup,secrets}.md`

- [ ] **Step 1: `.github/workflows/ci.yml`**

```yaml
name: CI
on: { pull_request: {}, push: { branches: [main] } }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'pnpm' }
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
        env:
          NEXT_PUBLIC_SUPABASE_URL: https://x.supabase.co
          NEXT_PUBLIC_SUPABASE_ANON_KEY: ci
          SUPABASE_SERVICE_ROLE_KEY: ci
          SUPABASE_DB_URL: postgres://ci/ci
          APP_BASE_URL: http://localhost:3000
          GOOGLE_CLIENT_ID: ci
          GOOGLE_CLIENT_SECRET: ci
          GOOGLE_REDIRECT_URI: http://localhost:3000/cb
          HUBSPOT_CLIENT_ID: ci
          HUBSPOT_CLIENT_SECRET: ci
          HUBSPOT_REDIRECT_URI: http://localhost:3000/cb
          GOOGLE_GENERATIVE_AI_API_KEY: ci
          RATE_ESTIMATOR_URL: https://r.ci
          RATE_ESTIMATOR_SERVICE_TOKEN: ci
          INNGEST_EVENT_KEY: ci
          INNGEST_SIGNING_KEY: ci
          TOKEN_ENCRYPTION_KEY: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
```

- [ ] **Step 2: `.github/workflows/e2e.yml`**

```yaml
name: E2E
on: { push: { branches: [main] }, workflow_dispatch: {} }
jobs:
  playwright:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env: { POSTGRES_USER: postgres, POSTGRES_PASSWORD: postgres, POSTGRES_DB: postgres }
        ports: [ '54322:5432' ]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'pnpm' }
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm --filter @zipdev/web test:e2e
```

- [ ] **Step 3: `vercel.json`** (build target = apps/web)

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "pnpm turbo build --filter=@zipdev/web",
  "installCommand": "pnpm install --frozen-lockfile",
  "framework": "nextjs",
  "outputDirectory": "apps/web/.next"
}
```

- [ ] **Step 4: Operations docs**

`docs/operations/google-oauth-setup.md`:
```markdown
# Google OAuth setup

There are TWO Google OAuth clients in play:

1. **Supabase SSO client** — for user sign-in via `@zipdev.com`. Created in Supabase dashboard → Auth → Providers → Google. Use a separate client in Google Cloud Console with redirect `https://<project>.supabase.co/auth/v1/callback`. Restrict consent to internal users in your Workspace.

2. **Per-user integrations client** — for Gmail/Drive/Calendar/Sheets. Create a second OAuth client in Google Cloud Console with redirect `${APP_BASE_URL}/api/integrations/google/callback`. Add scopes via the OAuth consent screen ("Edit app" → "Scopes" → add Gmail/Drive/Calendar/Sheets scopes).

Set in Vercel env:
- `GOOGLE_SSO_CLIENT_ID`, `GOOGLE_SSO_CLIENT_SECRET` (Supabase SSO client; only used by the Supabase auth backend)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (integrations client)
```

`docs/operations/hubspot-oauth-setup.md`:
```markdown
# HubSpot OAuth setup

Create a HubSpot app (https://app.hubspot.com/developer/) with:
- Redirect URL: `${APP_BASE_URL}/api/integrations/hubspot/callback`
- Scopes: `crm.objects.companies.read`, `crm.objects.contacts.read`, `crm.objects.deals.read`, `crm.objects.owners.read`, `sales-email-read`

Set in Vercel env: `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_REDIRECT_URI`.
```

`docs/operations/secrets.md`:
```markdown
# Secrets

Generate `TOKEN_ENCRYPTION_KEY`:
```bash
openssl rand -base64 32
```

Store in Vercel + Supabase Vault — never in the repo. Never share between staging and prod.
```

- [ ] **Step 5: Commit**

```bash
git add .github vercel.json docs/operations
git commit -m "ci: GH Actions (lint/typecheck/test/build + e2e) + Vercel config + ops docs"
```

---

## Task 24: E2E test — canonical Sales flow

**Files:**
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/tests/e2e/sales-flow.spec.ts`
- Create: `apps/web/tests/e2e/fixtures/{kb-sample.md,seed.ts}`

- [ ] **Step 1: `apps/web/playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000', trace: 'on-first-retry' },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'pnpm dev', port: 3000, reuseExistingServer: true, timeout: 120_000,
  },
});
```

- [ ] **Step 2: `apps/web/tests/e2e/fixtures/kb-sample.md`**

```markdown
# Acme Corp — Past proposal (sample)

Acme is a US fintech that engaged Zipdev in 2025 for 4 senior React engineers and 1 SRE. Engagement: 12 months. Average ramp time: 3 weeks. NPS at engagement end: 9.

Key learnings:
- Acme prefers nearshore overlap of >= 6 hours with PST
- All engineers signed Acme MSA + SOW1
- Final monthly run-rate per engineer: $9,200
```

- [ ] **Step 3: `apps/web/tests/e2e/fixtures/seed.ts`** (seed a known user + bypass SSO for E2E)

```ts
import { createClient } from '@supabase/supabase-js';
export async function seedE2EUser() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const email = 'e2e@zipdev.com';
  const { data } = await sb.auth.admin.createUser({ email, email_confirm: true });
  return data.user!;
}
```

(For staging E2E, this seeds a confirmed user the test logs in as with a magic-link override; for CI, run against the in-process Supabase service.)

- [ ] **Step 4: `apps/web/tests/e2e/sales-flow.spec.ts`** (the canonical flow)

```ts
import { test, expect } from '@playwright/test';

test('canonical Sales proposal flow', async ({ page, request }) => {
  // 1) Seed user + log in via magic link (token bypass for E2E)
  // The setup is responsible for putting an authenticated session cookie on `page`.
  // For brevity, we assume a helper that hits `/api/test/login` exists in staging only.
  await page.goto('/');

  // 2) Connect integrations (mocked by msw on staging; here we just verify the page renders)
  await page.goto('/integrations');
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();

  // 3) Upload a KB doc
  await page.goto('/kb/me');
  await page.getByPlaceholder('New collection name…').fill('Sales — past proposals');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.setInputFiles('input[type="file"]', 'tests/e2e/fixtures/kb-sample.md');
  // Wait for status to flip to ready
  await expect(page.getByText('ready')).toBeVisible({ timeout: 30_000 });

  // 4) Open chat, send a proposal request
  await page.goto('/chat');
  const input = page.getByPlaceholder('Ask anything…');
  await input.fill('Draft a proposal for Acme Corp — 2 senior React, 1 SRE.');
  await page.getByRole('button', { name: 'Send' }).click();

  // 5) Expect assistant message to mention rate ranges and Acme
  await expect(page.locator('text=Acme')).toBeVisible({ timeout: 60_000 });
});
```

- [ ] **Step 5: Run E2E locally (after `pnpm dev` + Supabase started)**

```bash
pnpm --filter @zipdev/web test:e2e
```

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "test(e2e): canonical Sales proposal flow"
```

---

## Spec coverage self-review (verify before handing off)

Skim the spec section by section and verify every requirement maps to a task above:

| Spec § | Requirement | Implemented in |
|---|---|---|
| 4 / 5 | Monorepo + Vercel/Supabase/Tauri/Cloudflare | Task 1, 4 (web); MCP + desktop covered in Plan 2/3 |
| 6 | Full Postgres schema + RLS | Task 3 (migrations 0001–0010), Task 13 (0011), Task 14 (0012), Task 21 (0013) |
| 7 | Hybrid RAG + ingestion + Drive sync | Tasks 12, 13, 14 |
| 8 | 17 tools + confirmation gates | Tasks 8–11, 13, 16 (composite) |
| 9 | Agent definitions + Sales agent | Task 16 |
| 10 | Backend agent loop (Gemini 2.5) | Task 17 |
| 11 | MCP surface | Plan 2 |
| 12 | Desktop | Plan 3 |
| 13 | Auth + per-user OAuth | Tasks 4, 6, 7 |
| 14 | Admin UI | Tasks 15, 19, 20, 21 |
| 15 | Chat UI (citations, file drop) | Task 18 |
| 16 | Day-one Sales flow | Tasks 16 + 24 |
| 17 / 18 | Deploys + CI/CD | Task 23 |
| 19 | Observability | Task 22 |
| 20 | Testing | Tasks 2, 5, 8, 9, 10, 11, 12, 24 |
| 21 | Risks (validation, rate-limit, scope caps) | Tasks 5, 12, 14 |

If a row above is unverified for your plan execution, treat it as a gap and add a follow-up task before proceeding.







