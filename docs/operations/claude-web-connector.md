# claude.ai MCP Connector Runbook

This is the in-app remote MCP connector served by the Next.js web app
(`apps/web`). It lets a user add the Zipdev Agent as a custom connector inside
claude.ai and call the agent's tools directly from a Claude conversation.

The web app is both the **OAuth 2.1 authorization server** and the **MCP
resource server**. There is no separate worker to deploy — the connector lives
at the app's own origin.

## Connector URL to paste into claude.ai

In claude.ai go to **Settings → Connectors → Add custom connector** and paste the
MCP endpoint URL, which is `<issuer>/api/mcp`:

```
https://cortex-zipdev.vercel.app/api/mcp
```

(Replace `app.zipdev.com` with whatever public origin `BETTER_AUTH_URL` /
`APP_BASE_URL` resolve to in the target environment.)

That is the only URL you paste. Everything else is auto-discovered.

## Claude Code

The repo ships a project-scoped `.mcp.json` pointing at
`https://cortex-zipdev.vercel.app/mcp`, so anyone opening this repo in Claude Code gets
the Zipdev tools after approving the server (Claude Code runs the same OAuth
flow in the browser). To use it in any other project or globally:

```bash
claude mcp add --transport http zipdev https://cortex-zipdev.vercel.app/mcp
```

## What happens after you paste the URL

1. claude.ai calls `GET <issuer>/api/mcp` with no token and gets a `401` whose
   `WWW-Authenticate` header points at the Protected Resource Metadata document.
2. claude.ai fetches `GET <issuer>/.well-known/oauth-protected-resource`
   (RFC 9728), which advertises this app as the authorization server.
3. claude.ai fetches `GET <issuer>/.well-known/oauth-authorization-server`
   (RFC 8414) to learn the authorize / token / registration endpoints.
4. claude.ai dynamically registers itself via `POST <issuer>/api/oauth/register`
   (RFC 7591 Dynamic Client Registration) as a public PKCE client.
5. claude.ai opens `<issuer>/api/oauth/authorize`. The app requires a logged-in
   `@zipdev.com` user (Google SSO via better-auth), then shows a consent screen.
6. After consent, the app mints a PKCE-bound authorization code and redirects
   back to claude.ai, which exchanges it at `<issuer>/api/oauth/token` for an
   access token (+ refresh token).
7. claude.ai re-calls `/api/mcp` with `Authorization: Bearer <token>`; the agent
   tools are now available in the conversation.

The end user only ever sees: paste URL → Google SSO → "Authorize" → done.

## Endpoints (all served by `apps/web`)

| Path | Purpose |
| --- | --- |
| `/api/mcp` | MCP Streamable HTTP endpoint (the connector URL). |
| `/.well-known/oauth-protected-resource` | RFC 9728 resource metadata. |
| `/.well-known/oauth-protected-resource/mcp` | Resource metadata (path-scoped variant). |
| `/.well-known/oauth-authorization-server` | RFC 8414 AS metadata. |
| `/api/oauth/register` | RFC 7591 Dynamic Client Registration. |
| `/api/oauth/authorize` | Authorization endpoint + consent screen. |
| `/api/oauth/token` | Token endpoint (authorization_code + refresh_token). |

## Production requirements

- **`BETTER_AUTH_URL` must be the public https origin** (e.g.
  `https://cortex-zipdev.vercel.app`), never `localhost`. The OAuth issuer advertised in
  the `/.well-known` metadata derives from this origin, and the `issuer` string
  must be byte-identical to the origin claude.ai used to fetch the metadata, or
  claude.ai rejects the connector. Keep `APP_BASE_URL` aligned to the same
  public https origin.
- **Migration applied**: `infra/supabase/migrations/0025_oauth_mcp.sql` must be
  applied to the production database. It creates the `oauth_clients`,
  `oauth_authorization_codes`, `oauth_access_tokens`, and `oauth_refresh_tokens`
  tables that back the authorization server.
- **`BETTER_AUTH_SECRET`** must be set (a real secret, not the build-time
  placeholder).
- Google SSO must be configured (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`)
  and the SSO callback registered for the public origin.

## Local testing

1. Start the local Supabase stack and apply migrations (the local DB listens on
   `127.0.0.1:54322`).
2. Run the web app (`pnpm --filter @cortex/web dev`) on `http://localhost:3000`.
3. The local connector URL is:

   ```
   http://localhost:3000/api/mcp
   ```

   Note: claude.ai (the hosted product) cannot reach `localhost`. For an
   end-to-end test against claude.ai, expose the app over a public https tunnel
   and set `BETTER_AUTH_URL` / `APP_BASE_URL` to that tunnel origin so the issuer
   matches. For purely local verification, exercise the endpoints with `curl`:

   ```bash
   curl -i http://localhost:3000/api/mcp                       # expect 401 + WWW-Authenticate
   curl -s http://localhost:3000/.well-known/oauth-protected-resource
   curl -s http://localhost:3000/.well-known/oauth-authorization-server
   ```

## Troubleshooting

- **claude.ai rejects the connector after metadata fetch**: the `issuer` in the
  metadata does not match the origin claude.ai used. Fix `BETTER_AUTH_URL` /
  `APP_BASE_URL` to the exact public https origin.
- **Authorize step loops or 500s**: confirm the user is signed in with a
  `@zipdev.com` Google account and that migration 0025 is applied.
- **Tokens rejected on `/api/mcp`**: tokens are bound to the canonical resource
  audience (`<issuer>/mcp`); a mismatched issuer between authorize-time and
  call-time invalidates them. Re-check the origin config.
