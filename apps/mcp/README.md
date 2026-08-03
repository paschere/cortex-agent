# @cortex/mcp

Cloudflare Worker exposing cortex-agent tools via MCP (Model Context Protocol).

## Deploy

```bash
pnpm --filter @cortex/mcp deploy
```

## Local dev

```bash
pnpm --filter @cortex/mcp dev
```

Requires a Cloudflare account and `wrangler login`.

## Secrets

Set secrets via Wrangler before deploying:

```bash
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
