# Cortex Desktop

Tauri 2.x desktop app wrapping the Cortex web UI.

## Prerequisites

### Rust toolchain

Install via [rustup](https://rustup.rs/):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# or on Windows: winget install Rustlang.Rustup
```

Verify:

```bash
cargo --version   # >= 1.77
rustc --version
```

### Node / pnpm

Node >= 20 and pnpm 9.x (matches repo root `packageManager`).

### System dependencies (Linux only — deferred to Task 6)

`libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, etc.

## Dev workflow

1. Start the Next.js dev server:

   ```bash
   pnpm --filter @cortex/web dev
   # → http://localhost:3000
   ```

2. In a second terminal, start Tauri dev:

   ```bash
   pnpm --filter @cortex/desktop dev
   # Tauri opens a native window pointed at http://localhost:3000/chat
   ```

   The `devUrl` in `src-tauri/tauri.conf.json` controls the target URL for dev mode.

## Build workflow

```bash
pnpm --filter @cortex/desktop build
```

Produces platform-specific bundles in `src-tauri/target/release/bundle/`.

> **Note:** Cross-compilation (Mac universal binary, Windows from Mac/Linux) is
> deferred to Task 6 (CI/CD pipeline). For now, build on the target platform.

## Configuration

| Setting | Location | Notes |
|---|---|---|
| Dev URL | `src-tauri/tauri.conf.json` → `build.devUrl` | Points at Next.js dev server |
| Prod URL | `src-tauri/tauri.conf.json` → `build.frontendDist` | Vercel deployment URL |
| Deep-link scheme | `src-tauri/tauri.conf.json` → `plugins.deep-link` | `cortex-agent://` |
| Updater public key | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` | Replace at Task 6 |

## Environment

Set `CORTEX_WEB_URL` to point the desktop app at a Cortex web instance:
- Local dev: `http://localhost:3000` (default)
- Production: your deployment's public origin, e.g. `https://app.example.com`

The URL is baked in at build time via Vite. To change it, rebuild.

```bash
CORTEX_WEB_URL=https://app.example.com pnpm --filter @cortex/desktop build
```

## Plugins bundled

- `tauri-plugin-shell` — open external URLs
- `tauri-plugin-deep-link` — `cortex-agent://` URI scheme
- `tauri-plugin-notification` — desktop notifications
- `tauri-plugin-store` — persistent key-value store
- `tauri-plugin-global-shortcut` — system-wide hotkeys
- `tauri-plugin-updater` — auto-update (endpoint + key configured at Task 6)
- `tauri-plugin-single-instance` — focus existing window on second launch
