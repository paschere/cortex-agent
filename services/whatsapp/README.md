# @cortex/whatsapp-bridge

The persistent half of Cortex's WhatsApp integration.

**Read [`docs/operations/whatsapp.md`](../../docs/operations/whatsapp.md) before
deploying this.** It covers the ban risk, the dedicated-number rule, pairing,
choosing groups, linking numbers and what to do when the session drops.

## Why it exists

WhatsApp publishes no API for reading a group you belong to. The only way in is
[Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial client that
holds an authenticated WebSocket open. Vercel structurally cannot host that — a
serverless invocation ends and takes the socket with it — so this runs on
Railway and posts everything it hears to Cortex over HTTPS.

## What it is not

It holds no database credentials and makes no product decisions. Which groups
are archived, where their documents land, whose number may talk to the agent —
all of that is decided and enforced in Cortex. This is a transport with a
socket.

## Layout

| File | What it is |
|---|---|
| `src/config.ts` | Everything it needs, read once and validated loudly |
| `src/auth-state.ts` | The session, in Postgres instead of on disk — the piece that stops re-pairing on every deploy |
| `src/socket.ts` | The connection: reconnect policy, group filtering, the DM path, and what the account will and will not do |
| `src/extract.ts` | A Baileys protobuf into the flat shape Cortex stores |
| `src/cortex.ts` | The only way it reaches anything that persists |
| `src/server.ts` | `GET /health` (open) and `GET /qr` (token) |

## Local development

```bash
export CORTEX_BASE_URL=http://localhost:3000
export WHATSAPP_BRIDGE_TOKEN=$(openssl rand -base64 32)   # same value in .env.local
export WHATSAPP_ORGANIZATION_ID=<ba_organization.id>
pnpm --filter @cortex/whatsapp-bridge dev
```

Pair against a **test number**, never a personal one, and never against the same
number a production bridge is using — two clients on one session fight over it.

## Operational rules

- **One replica. Always.** Two containers on one WhatsApp session get both
  dropped. `railway.json` pins `numReplicas: 1`; do not change it.
- **No volume.** The session is in Postgres on purpose. A volume would pin the
  service to one region and still lose the session on a rebuild.
- **Never log message content.** This process reads other people's
  conversations; a log drain is a copy of everything in it with different access
  rules. Log ids and counts.
