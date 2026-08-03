# Claude Desktop Install Runbook

Connect the zipdev MCP server to Claude Desktop so Claude can use zipdev tools directly.

## Step 1: Generate a token

1. Sign in at **https://app.zipdev.com**.
2. Go to **MCP tokens** in the sidebar.
3. Click **Issue new token**, name it (e.g., "My Claude Desktop").
4. Copy the plaintext token — it is shown only once.

## Step 2: Locate the Claude Desktop config file

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

If the file does not exist, create it.

## Step 3: Add the zipdev MCP server entry

Open the config file and add the `cortex-agent` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "cortex-agent": {
      "url": "https://mcp.zipdev.com/sse",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_HERE"
      }
    }
  }
}
```

Replace `YOUR_TOKEN_HERE` with the token copied in Step 1.

## Step 4: Restart Claude Desktop

Fully quit and reopen Claude Desktop for the config to take effect.

## Step 5: Verify

In a new Claude conversation, ask: **"What zipdev tools do you have?"**

Claude should list tools including `hubspot.search_companies`, `rate.estimate`, `kb.search`, and others.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401 Unauthorized` errors | Token was revoked or expired — issue a new one (Step 1) |
| "Tool not found" | Claude Desktop caches tool lists — fully quit and reopen |
| Network errors | Check `https://mcp.zipdev.com/health` directly; contact ops if it returns non-200 |

## Revoking a token

1. Sign in at **https://app.zipdev.com**.
2. Go to **MCP tokens** in the sidebar.
3. Click **Revoke** next to the token.

Revocation is immediate — the next MCP call using that token will be rejected with `401`.
