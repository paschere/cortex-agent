# Secrets

Generate `TOKEN_ENCRYPTION_KEY`:

```bash
openssl rand -base64 32
```

Store in Vercel + Supabase Vault — never in the repo. Never share between staging and prod.

Generate `BETTER_AUTH_SECRET`:

```bash
openssl rand -base64 32
```

## Full list of required secrets

| Variable | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel env | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel env | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env (sensitive) | Never expose client-side |
| `SUPABASE_DB_URL` | Vercel env (sensitive) | Direct DB connection string |
| `BETTER_AUTH_SECRET` | Vercel env (sensitive) | 32-byte base64, regenerate per env |
| `GOOGLE_CLIENT_ID` | Vercel env | Integrations OAuth client |
| `GOOGLE_CLIENT_SECRET` | Vercel env (sensitive) | Integrations OAuth client |
| `GOOGLE_REDIRECT_URI` | Vercel env | `${APP_BASE_URL}/api/integrations/google/callback` |
| `HUBSPOT_CLIENT_ID` | Vercel env | HubSpot app client ID |
| `HUBSPOT_CLIENT_SECRET` | Vercel env (sensitive) | HubSpot app client secret |
| `HUBSPOT_REDIRECT_URI` | Vercel env | `${APP_BASE_URL}/api/integrations/hubspot/callback` |
| `VOYAGE_API_KEY` | Vercel env (sensitive) | Voyage AI key — Knowledge Base embeddings (voyage-3-large, 1024 dims). Optional: without it the KB stores documents and searches keywords, but nothing is findable by meaning. |
| `RATE_ESTIMATOR_URL` | Vercel env | Internal rate estimator service URL |
| `RATE_ESTIMATOR_SERVICE_TOKEN` | Vercel env (sensitive) | Service-to-service auth token |
| `INNGEST_EVENT_KEY` | Vercel env (sensitive) | Inngest event key |
| `INNGEST_SIGNING_KEY` | Vercel env (sensitive) | Inngest signing key |
| `TOKEN_ENCRYPTION_KEY` | Vercel env (sensitive) | 32-byte base64, regenerate per env |
| `SENTRY_DSN` | Vercel env | Sentry project DSN |
| `SENTRY_AUTH_TOKEN` | Vercel env (sensitive) | For source map uploads |
