# Deploy runbook

## Prerequisites

All environment variables listed in `secrets.md` must be set in Vercel before deploying.

## Deploy to Vercel

```bash
vercel --prod
```

Or push to `main` — Vercel auto-deploys on every push to main.

## Database migrations

Apply pending Supabase migrations to the linked project:

```bash
pnpm db:push
```

Requires `supabase link --project-ref <ref>` to have been run once.

## Inngest functions

TBD — Inngest deployment lands in Task 14. Functions are automatically discovered and registered on first request to `/api/inngest` after deploy.

## Rollback

- **App rollback:** Vercel dashboard → Deployments → select a prior deployment → "Promote to Production".
- **Database rollback:** Supabase does not auto-rollback migrations. Write a compensating migration and apply via `pnpm db:push`.

## Staging vs Production

- Staging: Vercel preview deployments (auto-created on PRs).
- Production: `main` branch or `vercel --prod`.
- Use separate Supabase projects and separate OAuth client credentials for staging vs production.
- `TOKEN_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` must never be shared between environments.

## MCP Connector (Cloudflare Worker)

See [mcp-deploy.md](./mcp-deploy.md).
