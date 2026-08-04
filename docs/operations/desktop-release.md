# Desktop Release Runbook

How to cut a new release of the Cortex Agent desktop app.

## Prerequisites

### First-time setup: generate Tauri updater signing key

Run this once on a developer machine (not in CI):

```bash
pnpm --filter @cortex/desktop tauri signer generate -w ~/.tauri/cortex-agent.key
```

The command prints a **public key** — paste it into
`apps/desktop/src-tauri/tauri.conf.json` at `plugins.updater.pubkey`
(replaces the `"REPLACE_AT_TASK_6"` placeholder).

Save the private key file as the GitHub secret
`TAURI_SIGNING_PRIVATE_KEY` (base64-encode it first:
`base64 -i ~/.tauri/cortex-agent.key`) and the passphrase as
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

> **Note**: `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
> are the correct Tauri v2 secret names. (Earlier docs sometimes show
> `TAURI_PRIVATE_KEY` — that name is NOT read by tauri-action v0 + Tauri 2.)

### Optional secrets (code signing)

Without these, builds succeed but users see OS security warnings:

| Secret                         | Purpose                                              |
| ------------------------------ | ---------------------------------------------------- |
| `APPLE_CERTIFICATE`            | Base64 `.p12` for macOS code signing                 |
| `APPLE_CERTIFICATE_PASSWORD`   | Password for the `.p12`                              |
| `APPLE_SIGNING_IDENTITY`       | e.g. `Developer ID Application: Cortex (XXXXXXXXXX)` |
| `APPLE_ID`                     | Apple ID email used for notarization                 |
| `APPLE_PASSWORD`               | App-specific password for that Apple ID              |
| `APPLE_TEAM_ID`                | 10-character Apple Developer team ID                 |
| `WINDOWS_CERTIFICATE`          | Base64 `.pfx` for Windows Authenticode signing       |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for the `.pfx`                              |

### Icon assets

`apps/desktop/src-tauri/icons/` currently contains only a `.gitkeep`.
**`tauri build` will fail** until real icons are placed there:

- `128x128.png`
- `icon.icns` (macOS)
- `icon.ico` (Windows)

Use `tauri icon` (or commission assets) to generate the full set.

---

## Releasing a new version

### 1. Bump version numbers

Edit both files to the new version (e.g. `0.2.0`):

```
apps/desktop/src-tauri/tauri.conf.json  →  "version": "0.2.0"
apps/desktop/package.json               →  "version": "0.2.0"
```

### 2. Commit and push

```bash
git add apps/desktop/src-tauri/tauri.conf.json apps/desktop/package.json
git commit -m "chore(desktop): bump version to 0.2.0"
git push
```

### 3. Create a GitHub release

Go to **Releases → Draft a new release** (or use `gh`):

```bash
gh release create desktop-v0.2.0 \
  --title "Cortex Agent 0.2.0" \
  --notes "Release notes here."
```

The tag convention is `desktop-v<semver>` (e.g. `desktop-v0.2.0`).

Publishing the release triggers the
`.github/workflows/desktop-release.yml` workflow automatically.

### 4. Monitor the workflow

Navigate to **Actions → Desktop release** and watch the three jobs:

- `aarch64-apple-darwin` (macOS Apple Silicon)
- `x86_64-apple-darwin` (macOS Intel)
- `x86_64-pc-windows-msvc` (Windows)

Each job uploads its artifacts and attaches them to the GitHub release.
On success the release will have:

- `Cortex.Agent_0.2.0_aarch64.dmg` (or `.app.tar.gz`)
- `Cortex.Agent_0.2.0_x64.dmg`
- `Cortex.Agent_0.2.0_x64_en-US.msi` (and/or `.exe` NSIS installer)
- `latest.json` (used by the Tauri updater)

### 5. Update the updater endpoint (first release only)

Once the first release exists, verify the updater endpoint in
`tauri.conf.json` resolves correctly:

```
https://github.com/Cortex/cortex-agent/releases/latest/download/latest.json
```

If the GitHub org/repo path differs, update
`apps/desktop/src-tauri/tauri.conf.json#plugins.updater.endpoints`.

---

## Troubleshooting

| Symptom                                    | Cause                             | Fix                                                                                        |
| ------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------ |
| Build fails: missing icons                 | Icon files not committed          | Add real icon assets to `apps/desktop/src-tauri/icons/`                                    |
| macOS: "app is damaged" / Gatekeeper block | Unsigned build + quarantine       | Add Apple signing secrets, or user runs `xattr -dr com.apple.quarantine Cortex\ Agent.app` |
| Windows SmartScreen warning                | No Authenticode signature         | Add `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD` secrets                         |
| Updater silently skips update              | Wrong pubkey in `tauri.conf.json` | Re-run `tauri signer generate`, update `pubkey` field                                      |
| `tauri-action` can't find project          | Wrong `projectPath`               | Verify `apps/desktop/src-tauri/tauri.conf.json` exists                                     |
