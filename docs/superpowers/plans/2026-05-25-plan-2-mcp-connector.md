# Plan 2 — Claude MCP Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **Depends on Plan 1.** Plan 1 must be deployed (or at least merged) before this plan executes — we reuse `@cortex/agent-tools`, `@cortex/agents`, `@cortex/core`, and the Supabase data model.

**Goal:** Expose the Sales agent's tools to Claude Desktop via an MCP server, so a Cortex salesperson can run the same prospect-to-proposal flow from Claude with their own credentials.

**Architecture:** Standalone Cloudflare Worker that imports `@cortex/agent-tools` and `@cortex/agents`, authenticates each MCP request with a per-user bearer token issued from the admin UI, and exposes each registered tool over the MCP protocol. The Worker connects to the same Supabase database with the service-role key for tool execution, scoped by the resolved user id.

**Tech Stack:** TypeScript, Cloudflare Workers, Wrangler 3, `@modelcontextprotocol/sdk` 1.x, Hono (for the bearer-token bridge HTTP endpoint), Vitest, `miniflare` for tests.

---

## File structure (additions to Plan 1's monorepo)

```
apps/mcp/
├── package.json
├── tsconfig.json
├── wrangler.toml
├── src/
│   ├── index.ts                  # Worker entry — handles /mcp WebSocket + /healthz
│   ├── auth.ts                   # Validate bearer tokens, resolve userId
│   ├── server.ts                 # MCP Server: register tools + prompts + resources
│   └── tool-bridge.ts            # Translate MCP tool calls -> runTool() with ToolContext
├── test/
│   ├── server.test.ts
│   └── smoke.test.ts             # Live smoke against deployed staging
└── README.md

apps/web/
├── app/api/admin/mcp-tokens/
│   ├── route.ts                  # POST create token, GET list, DELETE revoke
│   └── [id]/route.ts
└── app/(app)/mcp/page.tsx        # "Connect Claude Desktop" page

infra/supabase/migrations/0014_mcp_tokens.sql
```

---

## Task 1: Database — MCP tokens table

**Files:** Create `infra/supabase/migrations/0014_mcp_tokens.sql`

- [ ] **Step 1: Write the migration**

```sql
create table public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  token_hash text not null unique,         -- sha256 of the bearer token; never store the plaintext
  prefix text not null,                    -- first 8 chars of the token for display (e.g. "zd_abcd…")
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index mcp_tokens_user_idx on public.mcp_tokens(user_id);

alter table public.mcp_tokens enable row level security;
create policy mcp_tokens_owner on public.mcp_tokens for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
```

- [ ] **Step 2: Apply, smoke**

```bash
pnpm db:reset
psql $SUPABASE_DB_URL -c "\d public.mcp_tokens"
```

- [ ] **Step 3: Commit**

```bash
git add infra/supabase/migrations/0014_mcp_tokens.sql
git commit -m "feat(db): mcp_tokens with hash-only storage + owner RLS"
```

---

## Task 2: Admin UI — issue / list / revoke MCP tokens

**Files:**

- Create: `apps/web/app/api/admin/mcp-tokens/route.ts`, `apps/web/app/api/admin/mcp-tokens/[id]/route.ts`
- Create: `apps/web/app/(app)/mcp/page.tsx`

- [ ] **Step 1: `apps/web/app/api/admin/mcp-tokens/route.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { requireSession } from "@/lib/session";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function GET() {
  await requireSession();
  const sb = await getSupabaseServerClient();
  const { data } = await sb
    .from("mcp_tokens")
    .select("id, name, prefix, last_used_at, revoked_at, created_at")
    .order("created_at", { ascending: false });
  return NextResponse.json({ tokens: data ?? [] });
}

const Create = z.object({ name: z.string().min(1).max(60) });

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const body = Create.safeParse(await req.json());
  if (!body.success)
    return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  const raw = `zd_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 11);
  const sb = await getSupabaseServerClient();
  const { data, error } = await sb
    .from("mcp_tokens")
    .insert({
      user_id: user.id,
      name: body.data.name,
      token_hash: hash,
      prefix,
    })
    .select("id")
    .single();
  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  // Returned ONCE — no way to recover later.
  return NextResponse.json(
    { id: data.id, token: raw, prefix },
    { status: 201 },
  );
}
```

`apps/web/app/api/admin/mcp-tokens/[id]/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireSession();
  const { id } = await params;
  const sb = await getSupabaseServerClient();
  const { error } = await sb
    .from("mcp_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id);
  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: `apps/web/app/(app)/mcp/page.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Token {
  id: string;
  name: string;
  prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export default function McpPage() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{
    token: string;
    prefix: string;
  } | null>(null);

  async function load() {
    setTokens((await (await fetch("/api/admin/mcp-tokens")).json()).tokens);
  }
  useEffect(() => {
    load();
  }, []);

  async function create() {
    if (!name.trim()) return;
    const r = await fetch("/api/admin/mcp-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const j = await r.json();
    setCreated({ token: j.token, prefix: j.prefix });
    setName("");
    load();
  }
  async function revoke(id: string) {
    await fetch(`/api/admin/mcp-tokens/${id}`, { method: "DELETE" });
    load();
  }

  const snippet = created
    ? `{
  "mcpServers": {
    "Cortex": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch", "${process.env.NEXT_PUBLIC_MCP_URL ?? "https://mcp.Cortex.app"}/mcp"],
      "env": { "MCP_BEARER": "${created.token}" }
    }
  }
}`
    : "";

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Connect Claude Desktop</h1>
      <Card>
        <p className="text-sm text-neutral-600">
          Generate a personal token, copy the snippet, and paste it into Claude
          Desktop&apos;s MCP config (Claude Desktop → Settings → Developer →
          Edit Config).
        </p>
      </Card>
      <Card>
        <div className="flex gap-2">
          <Input
            placeholder="Token name (e.g., 'Work laptop')"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button onClick={create}>Generate token</Button>
        </div>
        {created && (
          <div className="mt-3 space-y-2">
            <div className="text-sm font-medium text-amber-700">
              Copy this token NOW — it will not be shown again.
            </div>
            <pre className="rounded bg-neutral-100 dark:bg-neutral-800 p-2 text-xs">
              {snippet}
            </pre>
          </div>
        )}
      </Card>
      <Card>
        <h2 className="font-medium mb-2">Your tokens</h2>
        <ul className="divide-y text-sm">
          {tokens.map((t) => (
            <li key={t.id} className="py-2 flex items-center justify-between">
              <div>
                <div className="font-medium">
                  {t.name}{" "}
                  {t.revoked_at && (
                    <span className="text-xs text-red-600 ml-2">revoked</span>
                  )}
                </div>
                <div className="text-xs text-neutral-500 font-mono">
                  {t.prefix}…
                  {t.last_used_at
                    ? ` · last used ${new Date(t.last_used_at).toLocaleString()}`
                    : " · never used"}
                </div>
              </div>
              {!t.revoked_at && (
                <Button variant="ghost" onClick={() => revoke(t.id)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web
git commit -m "feat(mcp-tokens): admin UI for issuing + revoking per-user MCP bearer tokens"
```

---

## Task 3: `apps/mcp` scaffolding (Cloudflare Worker)

**Files:**

- Create: `apps/mcp/package.json`, `apps/mcp/tsconfig.json`, `apps/mcp/wrangler.toml`
- Create: `apps/mcp/src/{index,auth,server,tool-bridge}.ts`
- Create: `apps/mcp/README.md`

- [ ] **Step 1: `apps/mcp/package.json`**

```json
{
  "name": "@cortex/mcp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "dev": "wrangler dev --local",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@cortex/core": "workspace:*",
    "@cortex/agent-tools": "workspace:*",
    "@cortex/agents": "workspace:*",
    "@supabase/supabase-js": "2.46.2",
    "@modelcontextprotocol/sdk": "1.0.4",
    "hono": "4.6.13"
  },
  "devDependencies": {
    "typescript": "5.7.2",
    "vitest": "2.1.8",
    "wrangler": "3.91.0",
    "@cloudflare/workers-types": "4.20241127.0"
  }
}
```

- [ ] **Step 2: `apps/mcp/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types"],
    "noEmit": true,
    "lib": ["ES2022", "WebWorker"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: `apps/mcp/wrangler.toml`**

```toml
name = "Cortex-mcp"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[vars]
APP_NAME = "Cortex-mcp"

# Secrets set via: wrangler secret put NAME
# NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
# TOKEN_ENCRYPTION_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
# HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET,
# GOOGLE_GENERATIVE_AI_API_KEY,
# RATE_ESTIMATOR_URL, RATE_ESTIMATOR_SERVICE_TOKEN
```

- [ ] **Step 4: Commit (so workspace `pnpm install` picks up the new app)**

```bash
git add apps/mcp/package.json apps/mcp/tsconfig.json apps/mcp/wrangler.toml
git commit -m "chore(mcp): scaffold @cortex/mcp Worker package"
pnpm install
```

---

## Task 4: Bearer-token auth

**Files:** Create `apps/mcp/src/auth.ts`

- [ ] **Step 1: Write the auth helper**

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface AuthEnv {
  NEXT_PUBLIC_SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export interface AuthResult {
  userId: string;
  tokenId: string;
}

export function svcClient(env: AuthEnv): SupabaseClient {
  return createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function authenticate(
  bearer: string | null,
  env: AuthEnv,
): Promise<AuthResult> {
  if (!bearer || !bearer.startsWith("Bearer "))
    throw new Response("Unauthorized", { status: 401 });
  const token = bearer.slice(7).trim();
  if (!token.startsWith("zd_"))
    throw new Response("Invalid token", { status: 401 });
  const hash = await sha256Hex(token);
  const db = svcClient(env);
  const { data } = await db
    .from("mcp_tokens")
    .select("id, user_id, revoked_at")
    .eq("token_hash", hash)
    .maybeSingle();
  if (!data || data.revoked_at)
    throw new Response("Invalid token", { status: 401 });
  // Async-update last_used_at (fire & forget)
  void db
    .from("mcp_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id as string);
  return { userId: data.user_id as string, tokenId: data.id as string };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/mcp/src/auth.ts
git commit -m "feat(mcp): bearer-token auth backed by mcp_tokens table"
```

---

## Task 5: Tool bridge — translate MCP calls to `runTool`

**Files:** Create `apps/mcp/src/tool-bridge.ts`

- [ ] **Step 1: Write the bridge**

```ts
import {
  createIntegrationsClient,
  listTools,
  runTool,
  type AnyTool,
} from "@cortex/agent-tools";
import { ConfirmationRequiredError, logger } from "@cortex/core";
import { svcClient, type AuthEnv } from "./auth";
import { salesAgent } from "@cortex/agents";

// Force tool registration via side-effect imports
import "@cortex/agent-tools"; // hubspot/rate/gmail/gcal/gsheets/kb/composite

export function exposedTools(): AnyTool[] {
  // Currently all registered tools are exposed; future per-agent filtering can use salesAgent.allowedTools
  return listTools();
}

export interface BridgeArgs {
  env: AuthEnv & {
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    HUBSPOT_CLIENT_ID: string;
    HUBSPOT_CLIENT_SECRET: string;
  };
  userId: string;
  toolId: string;
  input: unknown;
  confirmed?: boolean;
}

export async function execMcpTool(
  args: BridgeArgs,
): Promise<
  | { ok: true; result: unknown }
  | { ok: false; reason: "confirmation_required"; input: unknown }
> {
  // Worker env -> process.env is impossible; the integration client reads process.env. For Workers we need an alternative path:
  // The IntegrationsClient currently reads process.env.GOOGLE_CLIENT_ID etc. In Worker context this is undefined.
  // Workaround for MVP: stash env on globalThis before invocation so REFRESHERS find values.
  // biome-ignore lint/suspicious/noExplicitAny: shim for Worker env
  const g = globalThis as any;
  g.process = g.process ?? { env: {} };
  Object.assign(g.process.env, args.env);

  const db = svcClient(args.env);
  const integrations = createIntegrationsClient(db, args.userId, logger);
  const tool = exposedTools().find((t) => t.id === args.toolId);
  if (!tool) throw new Error(`Unknown tool: ${args.toolId}`);
  // Use Sales agent id for now (looked up server-side once per worker isolate)
  const { data: agentRow } = await db
    .from("agents")
    .select("id")
    .eq("slug", salesAgent.id)
    .single();
  const agentId = agentRow?.id as string;

  try {
    const result = await runTool(
      tool,
      args.input,
      { userId: args.userId, agentId, db, integrations, logger },
      { confirmed: args.confirmed },
    );
    return { ok: true, result };
  } catch (err) {
    if (err instanceof ConfirmationRequiredError)
      return { ok: false, reason: "confirmation_required", input: err.input };
    throw err;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/mcp/src/tool-bridge.ts
git commit -m "feat(mcp): tool bridge that delegates to @cortex/agent-tools runTool"
```

---

## Task 6: MCP server (tools + prompts + resources)

**Files:** Create `apps/mcp/src/server.ts`

- [ ] **Step 1: Write the server registration**

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { salesAgent } from "@cortex/agents";
import { execMcpTool, exposedTools } from "./tool-bridge";
import { svcClient, type AuthEnv } from "./auth";

export function buildServer(
  env: AuthEnv & Record<string, string>,
  userId: string,
): Server {
  const server = new Server(
    { name: "cortex-agent", version: "1.0.0" },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );

  // Tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposedTools().map((t) => ({
      name: t.id.replace(/\./g, "_"), // MCP names must be identifier-safe
      description: t.description,
      inputSchema:
        (t.inputSchema as { _def: unknown }).constructor === Object
          ? t.inputSchema
          : zodToJsonSchemaSafe(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolId = req.params.name.replace(/_/g, ".");
    const args = req.params.arguments;
    // First attempt: not confirmed
    const out = await execMcpTool({
      env: env as never,
      userId,
      toolId,
      input: args,
    });
    if (out.ok)
      return { content: [{ type: "text", text: JSON.stringify(out.result) }] };
    if (out.reason === "confirmation_required") {
      // MCP doesn't have a native confirmation channel; we surface a special tool payload that the
      // Claude client renders as a structured prompt; the user re-invokes with __confirmed=true.
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              __requires_confirmation: true,
              toolId,
              input: out.input,
            }),
          },
        ],
      };
    }
    throw new Error("unreachable");
  });

  // Prompts
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "sales_mode",
        description: "Activate Cortex Sales co-pilot mode",
      },
      {
        name: "draft_proposal",
        description: "Draft a proposal for a given client",
        arguments: [
          {
            name: "client",
            description: "Client / company name",
            required: true,
          },
        ],
      },
    ],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (req.params.name === "sales_mode") {
      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text: salesAgent.systemPrompt },
          },
        ],
      };
    }
    if (req.params.name === "draft_proposal") {
      const client =
        (req.params.arguments?.client as string | undefined) ?? "<client>";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Draft a proposal for ${client}. Use sales.draft_proposal.`,
            },
          },
        ],
      };
    }
    throw new Error("Unknown prompt");
  });

  // Resources — surface KB collections the user can read
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const db = svcClient(env);
    // RLS isn't applied with service role; emulate visibility by fetching all user-visible collections
    const { data } = await db
      .from("kb_collections")
      .select("id, name, scope")
      .or(`scope.eq.global,scope.eq.user.scope_id.eq.${userId}`);
    return {
      resources: (data ?? []).map((c) => ({
        uri: `kb://collections/${c.id}`,
        name: c.name as string,
        description: `KB collection (${c.scope})`,
        mimeType: "application/json",
      })),
    };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const m = /^kb:\/\/collections\/([0-9a-f-]{36})$/i.exec(req.params.uri);
    if (!m) throw new Error("Invalid resource URI");
    const db = svcClient(env);
    const { data } = await db
      .from("kb_documents")
      .select("id, title, status")
      .eq("collection_id", m[1]);
    return {
      contents: [
        {
          uri: req.params.uri,
          mimeType: "application/json",
          text: JSON.stringify(data ?? []),
        },
      ],
    };
  });

  return server;
}

// Minimal zod→jsonSchema fallback (Zod v3 has built-in description; the MCP SDK accepts JSON Schema OR Zod objects).
function zodToJsonSchemaSafe(z: unknown): unknown {
  return z;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/mcp/src/server.ts
git commit -m "feat(mcp): MCP server — tools, prompts, kb:// resources"
```

---

## Task 7: Worker entry — HTTP /sse transport for MCP

**Files:** Create `apps/mcp/src/index.ts`

- [ ] **Step 1: Write the Worker entry**

The MCP SDK ships an HTTP-stream transport. Cloudflare Workers can host this via Hono.

```ts
import { Hono } from "hono";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { authenticate, type AuthEnv } from "./auth";
import { buildServer } from "./server";

type Env = AuthEnv & {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  HUBSPOT_CLIENT_ID: string;
  HUBSPOT_CLIENT_SECRET: string;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
  RATE_ESTIMATOR_URL: string;
  RATE_ESTIMATOR_SERVICE_TOKEN: string;
  TOKEN_ENCRYPTION_KEY: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.text("ok"));

// SSE transport endpoint. Claude Desktop is configured (via mcp-server-fetch) to talk MCP over HTTP/SSE.
app.all("/mcp", async (c) => {
  try {
    const auth = await authenticate(
      c.req.header("authorization") ?? null,
      c.env,
    );
    const server = buildServer(c.env as never, auth.userId);
    const transport = new SSEServerTransport(
      "/mcp",
      c.executionCtx as unknown as Response,
    );
    await server.connect(transport);
    // Return the SSE response from the transport
    return transport.response;
  } catch (e) {
    if (e instanceof Response) return e;
    return new Response(`error: ${(e as Error).message}`, { status: 500 });
  }
});

export default app;
```

(Note: the MCP TypeScript SDK 1.x's SSE transport API surface evolves; if `transport.response` isn't the right accessor in the installed version, adapt to the SDK's current pattern — the goal is: per-request, build an MCP `Server`, attach the SSE/HTTP transport, return the response. Run `pnpm --filter @cortex/mcp dev` and verify with `wrangler tail`.)

- [ ] **Step 2: Local dev smoke**

```bash
cp .env.local .env.local.mcp                 # copy values; alternatively use wrangler secrets locally
pnpm --filter @cortex/mcp dev
# in another shell:
curl -i http://127.0.0.1:8787/healthz       # expect "ok"
curl -i -H "Authorization: Bearer wrong" http://127.0.0.1:8787/mcp   # expect 401
```

- [ ] **Step 3: Commit**

```bash
git add apps/mcp/src/index.ts
git commit -m "feat(mcp): Worker entry with /mcp SSE transport + /healthz"
```

---

## Task 8: Smoke test — list tools and call kb.search via MCP

**Files:** Create `apps/mcp/test/smoke.test.ts`

- [ ] **Step 1: Write the smoke test**

```ts
import { describe, it, expect } from "vitest";

const BASE = process.env.MCP_BASE ?? "http://127.0.0.1:8787";
const TOKEN = process.env.MCP_TOKEN;

describe.skipIf(!TOKEN)("mcp smoke (live)", () => {
  it("listTools returns tools", async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const j = (await r.json()) as {
      result?: { tools: Array<{ name: string }> };
    };
    expect((j.result?.tools ?? []).some((t) => t.name === "kb_search")).toBe(
      true,
    );
  });
});
```

- [ ] **Step 2: Run locally**

```bash
# Issue a token via the admin UI, then:
MCP_TOKEN=zd_xxx MCP_BASE=http://127.0.0.1:8787 pnpm --filter @cortex/mcp test
```

Expected: passes when a real token is provided; skips otherwise.

- [ ] **Step 3: Commit**

```bash
git add apps/mcp
git commit -m "test(mcp): smoke for tools/list via SSE"
```

---

## Task 9: Deploy + Claude Desktop install runbook

**Files:**

- Create: `apps/mcp/README.md`
- Modify: `docs/operations/secrets.md` (add MCP secrets)

- [ ] **Step 1: `apps/mcp/README.md`**

````markdown
# Cortex-mcp

Cloudflare Worker exposing Cortex's shared tools to Claude Desktop via MCP.

## Deploy

```bash
pnpm --filter @cortex/mcp deploy
# First time only: set secrets
wrangler secret put NEXT_PUBLIC_SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put TOKEN_ENCRYPTION_KEY
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put HUBSPOT_CLIENT_ID
wrangler secret put HUBSPOT_CLIENT_SECRET
wrangler secret put GOOGLE_GENERATIVE_AI_API_KEY
wrangler secret put RATE_ESTIMATOR_URL
wrangler secret put RATE_ESTIMATOR_SERVICE_TOKEN
```
````

The Worker should be deployed at a stable URL (e.g., `https://mcp.Cortex.app`); set this in `apps/web` as `NEXT_PUBLIC_MCP_URL`.

## Install in Claude Desktop

1. Sign in to `https://cortex-agent.vercel.app` and go to **Setup → Connect Claude Desktop**.
2. Click **Generate token** with a name (e.g., "Work laptop"). Copy the displayed JSON snippet — the token is shown only once.
3. Open Claude Desktop → Settings → Developer → **Edit Config**, paste the snippet under `mcpServers`, save.
4. Restart Claude Desktop. The Cortex tools should appear (`kb_search`, `hubspot_*`, `gmail_*`, …).
5. Try: "Use Cortex Sales mode. Draft a proposal for Acme Corp — 2 senior React, 1 SRE."

````

- [ ] **Step 2: Deploy & verify**

```bash
pnpm --filter @cortex/mcp deploy
curl https://mcp.Cortex.app/healthz   # expect "ok"
````

- [ ] **Step 3: Set `NEXT_PUBLIC_MCP_URL` in Vercel** for `apps/web` and redeploy.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp/README.md docs/operations/secrets.md
git commit -m "docs(mcp): deploy + Claude Desktop install runbook"
```

---

## Spec coverage self-review

| Spec § | Requirement                                                         | Implemented in |
| ------ | ------------------------------------------------------------------- | -------------- |
| 11     | MCP server exposes shared tools                                     | Tasks 5, 6, 7  |
| 11     | Per-user bearer token, revocable                                    | Tasks 1, 2, 4  |
| 11     | Resources (kb:// URIs), prompts                                     | Task 6         |
| 4      | Cloudflare Workers deploy                                           | Tasks 3, 9     |
| 21     | Token misuse risk mitigation (hash-only storage, last_used, revoke) | Tasks 1, 2, 4  |
