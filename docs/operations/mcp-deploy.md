# MCP Connector Deploy Runbook

## Prerequisites

- Cloudflare account with Workers enabled
- `wrangler` CLI installed (`npm install -g wrangler`)
- Logged in: `wrangler login`

## First-time setup

Install dependencies:

```bash
pnpm --filter @zipdev/mcp install
```

Set secrets (each command prompts for the value):

```bash
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

## Deploy

**Production:**

```bash
pnpm --filter @zipdev/mcp deploy
```

**Local development:**

```bash
wrangler dev
```

## Custom domain

1. In the Cloudflare dashboard, go to **Workers & Pages → zipdev-mcp-prod → Settings → Triggers**.
2. Under **Custom Domains**, add `mcp.zipdev.com`.
3. Cloudflare handles DNS and TLS automatically for domains on your account.

Alternatively, configure a Worker Route in the dashboard: `mcp.zipdev.com/*` → `zipdev-mcp-prod`.

## Verify

```bash
curl https://mcp.zipdev.com/health
# Expected: {"ok":true}
```

## Rollback

Cloudflare retains deploy history. To revert to a previous version:

```bash
wrangler rollback
```

Or use the Cloudflare dashboard: **Workers & Pages → zipdev-mcp-prod → Deployments** → select a prior deployment → **Rollback**.
