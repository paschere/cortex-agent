# Google OAuth setup

There are TWO Google OAuth clients in play:

1. **Supabase SSO client** — for user sign-in via `@Cortex.com`. Created in Supabase dashboard → Auth → Providers → Google. Use a separate client in Google Cloud Console with redirect `https://<project>.supabase.co/auth/v1/callback`. Restrict consent to internal users in your Workspace.

2. **Per-user integrations client** — for Gmail/Drive/Calendar/Sheets. Create a second OAuth client in Google Cloud Console with redirect `${APP_BASE_URL}/api/integrations/google/callback`. Add scopes via the OAuth consent screen ("Edit app" → "Scopes" → add Gmail/Drive/Calendar/Sheets scopes).

Set in Vercel env:

- `GOOGLE_SSO_CLIENT_ID`, `GOOGLE_SSO_CLIENT_SECRET` (Supabase SSO client; only used by the Supabase auth backend)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (integrations client)
