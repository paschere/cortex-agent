# Zipdev Agent Desktop

Tauri 2.x desktop app wrapping the Zipdev Agent web UI.

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
   pnpm --filter @zipdev/web dev
   # → http://localhost:3000
   ```

2. In a second terminal, start Tauri dev:

   ```bash
   pnpm --filter @zipdev/desktop dev
   # Tauri opens a native window pointed at http://localhost:3000/chat
   ```

   The `devUrl` in `src-tauri/tauri.conf.json` controls the target URL for dev mode.

## Build workflow

```bash
pnpm --filter @zipdev/desktop build
```

Produces platform-specific bundles in `src-tauri/target/release/bundle/`.

> **Note:** Cross-compilation (Mac universal binary, Windows from Mac/Linux) is
> deferred to Task 6 (CI/CD pipeline). For now, build on the target platform.

## Configuration

| Setting | Location | Notes |
|---|---|---|
| Dev URL | `src-tauri/tauri.conf.json` → `build.devUrl` | Points at Next.js dev server |
| Prod URL | `src-tauri/tauri.conf.json` → `build.frontendDist` | Vercel deployment URL |
| Deep-link scheme | `src-tauri/tauri.conf.json` → `plugins.deep-link` | `zipdev-agent://` |
| Updater public key | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` | Replace at Task 6 |

## Plugins bundled

- `tauri-plugin-shell` — open external URLs
- `tauri-plugin-deep-link` — `zipdev-agent://` URI scheme
- `tauri-plugin-notification` — desktop notifications
- `tauri-plugin-store` — persistent key-value store
- `tauri-plugin-global-shortcut` — system-wide hotkeys
- `tauri-plugin-updater` — auto-update (endpoint + key configured at Task 6)
- `tauri-plugin-single-instance` — focus existing window on second launch
