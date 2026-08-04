# Plan 3 — Desktop App (Tauri) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **Depends on Plan 1.** The desktop app is a thin Tauri shell that loads the chat UI from `apps/web` and talks to the same backend.

**Goal:** Ship a native desktop app (macOS + Windows) that wraps the existing chat UI in a Tauri window, adds a system tray, a global hotkey to open chat, native notifications (groundwork for v2 alerts), and a clean Google SSO flow with deep-link callback.

**Architecture:** Tauri 2.x. The webview points at the deployed `apps/web` chat surface (or `localhost:3000` in dev). All chat/agent logic stays in `apps/web`; the desktop adds OS integrations only.

**Tech Stack:** Tauri 2, Rust (minimal — mostly stock plugins), Tauri plugins: `tauri-plugin-deep-link`, `tauri-plugin-notification`, `tauri-plugin-shell`, `tauri-plugin-store`, `tauri-plugin-global-shortcut`, `tauri-plugin-updater`, `tauri-plugin-single-instance`. GitHub Actions for cross-platform builds + code-signing.

---

## File structure (additions to Plan 1's monorepo)

```
apps/desktop/
├── package.json
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── icons/
│   │   ├── icon.icns
│   │   ├── icon.ico
│   │   └── 128x128.png
│   ├── capabilities/
│   │   └── default.json
│   └── src/
│       ├── main.rs
│       ├── tray.rs
│       ├── hotkey.rs
│       └── auth.rs
├── README.md
└── .gitignore
```

---

## Task 1: Tauri scaffolding

**Files:**

- Create: `apps/desktop/package.json`, `apps/desktop/src-tauri/{Cargo.toml,tauri.conf.json,build.rs,src/main.rs}`
- Create: `apps/desktop/src-tauri/capabilities/default.json`
- Create: `apps/desktop/src-tauri/icons/` (placeholders for now; real assets in Task 6)

- [ ] **Step 1: `apps/desktop/package.json`**

```json
{
  "name": "@cortex/desktop",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "tauri": "tauri",
    "dev": "tauri dev",
    "build": "tauri build"
  },
  "devDependencies": {
    "@tauri-apps/cli": "2.1.0"
  }
}
```

- [ ] **Step 2: `apps/desktop/src-tauri/Cargo.toml`**

```toml
[package]
name = "cortex-agent-desktop"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-deep-link = "2"
tauri-plugin-notification = "2"
tauri-plugin-shell = "2"
tauri-plugin-store = "2"
tauri-plugin-global-shortcut = "2"
tauri-plugin-updater = "2"
tauri-plugin-single-instance = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 3: `apps/desktop/src-tauri/build.rs`**

```rust
fn main() { tauri_build::build() }
```

- [ ] **Step 4: `apps/desktop/src-tauri/tauri.conf.json`**

```json
{
  "$schema": "../node_modules/@tauri-apps/cli/schema.json",
  "productName": "Cortex Agent",
  "version": "0.1.0",
  "identifier": "com.Cortex.agent",
  "build": {
    "beforeDevCommand": "",
    "beforeBuildCommand": "",
    "devUrl": "http://localhost:3000/chat",
    "frontendDist": "https://cortex-agent.vercel.app/chat"
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "Cortex Agent",
        "width": 920,
        "height": 720,
        "minWidth": 480,
        "minHeight": 360,
        "decorations": true,
        "resizable": true,
        "fullscreen": false,
        "transparent": false,
        "visible": true,
        "url": "/chat"
      }
    ],
    "security": {
      "csp": null
    }
  },
  "plugins": {
    "updater": {
      "active": true,
      "endpoints": [
        "https://github.com/Cortex/cortex-agent/releases/latest/download/latest.json"
      ],
      "pubkey": "REPLACE_AT_TASK_6"
    },
    "deep-link": {
      "desktop": {
        "schemes": ["cortex-agent"]
      }
    }
  },
  "bundle": {
    "active": true,
    "category": "Productivity",
    "targets": ["dmg", "app", "msi", "nsis", "appimage", "deb"],
    "icon": ["icons/128x128.png", "icons/icon.icns", "icons/icon.ico"]
  }
}
```

(`frontendDist` is a placeholder — Tauri uses the URL for prod builds; we override per-environment in Task 5.)

- [ ] **Step 5: `apps/desktop/src-tauri/capabilities/default.json`**

```json
{
  "identifier": "default",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "shell:allow-open",
    "notification:default",
    "global-shortcut:default",
    "deep-link:default",
    "store:default",
    "updater:default",
    "core:event:default"
  ]
}
```

- [ ] **Step 6: Skeleton `apps/desktop/src-tauri/src/main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod tray;
mod hotkey;
mod auth;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Focus existing window on second launch
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            tray::setup(app)?;
            hotkey::setup(app.handle())?;
            auth::setup_deep_link(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 7: Verify the project compiles (empty modules below)**

Create empty `apps/desktop/src-tauri/src/tray.rs`, `hotkey.rs`, `auth.rs` each containing one no-op pub function per `main.rs`:

```rust
// tray.rs
pub fn setup<R: tauri::Runtime>(_app: &tauri::App<R>) -> tauri::Result<()> { Ok(()) }
```

```rust
// hotkey.rs
pub fn setup<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> tauri::Result<()> { Ok(()) }
```

```rust
// auth.rs
pub fn setup_deep_link<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> tauri::Result<()> { Ok(()) }
```

Run: `pnpm --filter @cortex/desktop tauri info`
Expected: prints toolchain info.

Run: `pnpm --filter @cortex/desktop dev`
Expected: opens a window pointing at `http://localhost:3000/chat` (run `pnpm --filter @cortex/web dev` first).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop
git commit -m "chore(desktop): Tauri 2 scaffold + plugins + capabilities"
```

---

## Task 2: System tray

**Files:** Modify `apps/desktop/src-tauri/src/tray.rs`

- [ ] **Step 1: Write the tray module**

```rust
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent, MouseButton},
    Manager,
};

pub fn setup<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let icon = Image::from_bytes(include_bytes!("../icons/128x128.png"))?;

    let open = MenuItem::with_id(app, "open", "Open Cortex Agent", true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, "new_chat", "New chat", true, Some("CmdOrCtrl+Shift+Z"))?;
    let sep = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &new_chat, &sep, &quit])?;

    let _tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => focus_main(app),
            "new_chat" => {
                focus_main(app);
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval("window.location.href = '/chat'");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                focus_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn focus_main<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
```

- [ ] **Step 2: Run and verify**

```bash
pnpm --filter @cortex/desktop dev
```

Expected: tray icon appears (status bar on macOS, system tray on Windows). Clicking shows the window. "Quit" exits. "New chat" navigates to `/chat`.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/tray.rs
git commit -m "feat(desktop): system tray with Open / New chat / Quit"
```

---

## Task 3: Global hotkey

**Files:** Modify `apps/desktop/src-tauri/src/hotkey.rs`

- [ ] **Step 1: Write the hotkey module**

```rust
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub fn setup<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    // Cmd+Shift+Z on macOS, Ctrl+Shift+Z on Windows/Linux
    #[cfg(target_os = "macos")]
    let modifiers = Modifiers::SUPER | Modifiers::SHIFT;
    #[cfg(not(target_os = "macos"))]
    let modifiers = Modifiers::CONTROL | Modifiers::SHIFT;
    let shortcut = Shortcut::new(Some(modifiers), Code::KeyZ);

    let app_handle = app.clone();
    app.global_shortcut().on_shortcut(shortcut, move |_app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            if let Some(w) = app_handle.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
                let _ = w.eval("window.location.href = '/chat'");
            }
        }
    })?;
    Ok(())
}
```

- [ ] **Step 2: Run and verify**

```bash
pnpm --filter @cortex/desktop dev
```

With the app running but window not focused: press `Ctrl+Shift+Z` (or `Cmd+Shift+Z`). The window should focus and navigate to `/chat`.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/hotkey.rs
git commit -m "feat(desktop): global hotkey Cmd/Ctrl+Shift+Z opens chat"
```

---

## Task 4: Google SSO via deep-link callback

The desktop app needs to authenticate against the same Supabase backend. Approach: open the browser to the web app's login page with a `?desktop=1` query, which after successful SSO redirects to a `cortex-agent://` deep link carrying a one-shot session token. The desktop app receives the deep link, sets cookies via a webview eval, and navigates to chat.

**Files:**

- Modify: `apps/desktop/src-tauri/src/auth.rs`
- Modify: `apps/web/app/api/auth/callback/route.ts` (already exists from Plan 1 — extend for `desktop=1`)
- Create: `apps/web/app/api/auth/desktop-session/route.ts`

- [ ] **Step 1: `apps/web/app/api/auth/desktop-session/route.ts`** — issue a short-lived cookie token for the desktop deep link

```ts
import { NextResponse } from "next/server";
import { randomBytes, createHash } from "node:crypto";
import { requireSession } from "@/lib/session";
import { getSupabaseServiceClient } from "@/lib/supabase/service";

// Reuses mcp_tokens but with a different prefix to distinguish desktop.
export async function POST() {
  const user = await requireSession();
  const raw = `zdk_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const db = getSupabaseServiceClient();
  await db
    .from("mcp_tokens")
    .insert({
      user_id: user.id,
      name: "Desktop one-shot",
      token_hash: hash,
      prefix: raw.slice(0, 12),
    });
  // The desktop redeems this token via /api/auth/desktop-redeem to get a real Supabase session cookie.
  return NextResponse.json({ token: raw }, { status: 201 });
}
```

Create `apps/web/app/api/auth/desktop-redeem/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { getSupabaseServiceClient } from "@/lib/supabase/service";

export async function POST(req: NextRequest) {
  const { token } = (await req.json()) as { token?: string };
  if (!token)
    return NextResponse.json({ error: "token required" }, { status: 400 });
  const hash = createHash("sha256").update(token).digest("hex");
  const db = getSupabaseServiceClient();
  const { data: row } = await db
    .from("mcp_tokens")
    .select("id, user_id, revoked_at")
    .eq("token_hash", hash)
    .maybeSingle();
  if (!row || row.revoked_at)
    return NextResponse.json({ error: "invalid" }, { status: 401 });

  // Mark this one-shot token as revoked
  await db
    .from("mcp_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", row.id as string);

  // Issue a fresh Supabase session for this user using auth.admin (magic link short-lived approach)
  const { data: link } = await db.auth.admin.generateLink({
    type: "magiclink",
    email: "",
    options: { redirectTo: "about:blank" },
  }); // placeholder; see note below
  // The cleanest path: redirect the desktop webview to a magic link URL the admin SDK generates for the user.
  return NextResponse.json({
    magicLink: link?.properties?.action_link ?? null,
  });
}
```

(For MVP, the simplest reliable approach is: the web app's login completes normally; once a session exists, the desktop opens `https://cortex-agent.vercel.app/chat` in its webview and the Supabase cookie set during login persists in the webview's cookie jar. The deep link approach is needed only if the SSO must happen in the user's default browser. Choose during implementation: if the simpler in-webview SSO works for `@Cortex.com` accounts, drop the deep-link redemption and ship.)

- [ ] **Step 2: `apps/desktop/src-tauri/src/auth.rs`** — handle the deep link if used

```rust
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

pub fn setup_deep_link<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let app_handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            // cortex-agent://auth?token=zdk_...
            if url.scheme() == "cortex-agent" && url.host_str() == Some("auth") {
                if let Some((_, token)) = url.query_pairs().find(|(k, _)| k == "token") {
                    if let Some(w) = app_handle.get_webview_window("main") {
                        let js = format!(
                            "fetch('/api/auth/desktop-redeem', {{ method: 'POST', headers: {{ 'Content-Type': 'application/json' }}, body: JSON.stringify({{ token: '{}' }}) }}).then(r => r.json()).then(j => {{ if (j.magicLink) window.location.href = j.magicLink; else window.location.href = '/'; }})",
                            token
                        );
                        let _ = w.eval(&js);
                    }
                }
            }
        }
    });
    Ok(())
}
```

- [ ] **Step 3: Manual test (in-webview SSO path)**

Run `pnpm --filter @cortex/web dev` and `pnpm --filter @cortex/desktop dev`. The Tauri window loads `localhost:3000/chat` → redirects to `/login` → click "Continue with Google" → completes Google flow → returns to chat. Verify session cookie persists across launches.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop apps/web
git commit -m "feat(desktop): auth flow via webview SSO; deep-link redemption fallback"
```

---

## Task 5: Per-environment URL via env vars

**Files:** Modify `apps/desktop/src-tauri/tauri.conf.json` for production URL; document dev override.

- [ ] **Step 1: Update `apps/desktop/README.md`**

````markdown
# cortex-agent-desktop

Tauri shell around the Cortex Agent chat UI.

## Dev

In two terminals:

```bash
pnpm --filter @cortex/web dev          # http://localhost:3000
pnpm --filter @cortex/desktop dev      # opens window to /chat
```
````

## Build

```bash
pnpm --filter @cortex/desktop build
```

Set `TAURI_ENV` env var to switch URLs (handled at build time by reading `tauri.conf.json` and Vercel env). For a custom staging URL, edit `src-tauri/tauri.conf.json#build.frontendDist` or pass `--config` overrides.

````

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/README.md
git commit -m "docs(desktop): dev + build instructions"
````

---

## Task 6: Build, sign, release pipeline

**Files:**

- Create: `.github/workflows/desktop-release.yml`
- Replace placeholders: real icons, Tauri updater pubkey

- [ ] **Step 1: Generate Tauri signing key (once, off-CI; store private key as secret)**

```bash
pnpm --filter @cortex/desktop tauri signer generate -w ~/.tauri/cortex-agent.key
```

This prints a public key — paste it into `tauri.conf.json#plugins.updater.pubkey`. Save the private key as a GitHub secret `TAURI_SIGNING_PRIVATE_KEY` and the passphrase as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

- [ ] **Step 2: `.github/workflows/desktop-release.yml`**

```yaml
name: Desktop release
on:
  push:
    tags: ['desktop-v*']
  workflow_dispatch: {}

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: macos-14,    target: 'aarch64-apple-darwin' }
          - { os: macos-14,    target: 'x86_64-apple-darwin' }
          - { os: windows-2022, target: 'x86_64-pc-windows-msvc' }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'pnpm' }
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - run: pnpm install --frozen-lockfile
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: ${{ matrix.target }} }
      - uses: tauri-apps/tauri-action@v0
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          # macOS code-signing & notarization secrets (optional for MVP; required for users to install without warnings):
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          # Windows code-signing
          WINDOWS_CERTIFICATE: ${{ secrets.WINDOWS_CERTIFICATE }}
          WINDOWS_CERTIFICATE_PASSWORD: ${{ secrets.WINDOWS_CERTIFICATE_PASSWORD }}
        with:
          projectPath: apps/desktop
          tauriScript: pnpm tauri
          tagName: ${{ github.ref_name }}
          releaseName: 'Cortex Agent ${{ github.ref_name }}'
          releaseDraft: false
          prerelease: false
          args: --target ${{ matrix.target }}
```

(For initial pilot, the macOS/Windows signing certs may be deferred — users will see "unsigned app" warnings; document the gotcha. The Tauri signing key for updates is the must-have.)

- [ ] **Step 3: Update `apps/desktop/src-tauri/tauri.conf.json#plugins.updater.endpoints`** with the actual GitHub Releases URL once the first release tag is published.

- [ ] **Step 4: First release**

```bash
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
```

Watch the GH Action; verify `.dmg` (mac) and `.msi`/`.exe` (windows) appear on the release, plus a `latest.json` for the updater.

- [ ] **Step 5: Replace placeholder icons** (`128x128.png`, `icon.icns`, `icon.ico`). Use `tauricon` or commission real assets.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/desktop-release.yml apps/desktop/src-tauri
git commit -m "ci(desktop): cross-platform release + updater signing"
```

---

## Task 7: Smoke test on real OSes

- [ ] **Step 1: macOS install**

Download the `.dmg` from the GitHub release, drag to Applications. Open Cortex Agent. Verify:

- Window opens to chat (after Google SSO if first launch).
- Tray icon appears in menu bar.
- `Cmd+Shift+Z` works from anywhere to focus the window.
- Right-click tray → "Quit" closes the app cleanly.

- [ ] **Step 2: Windows install**

Download the `.msi`. Install. Verify the same items as above using `Ctrl+Shift+Z`.

- [ ] **Step 3: Updater smoke**

Bump version in `tauri.conf.json` to `0.1.1`, tag `desktop-v0.1.1`, push, wait for the release. Launch the older installed app → should show an update prompt and update successfully.

- [ ] **Step 4: Document any issues**

Open issues for any rough edges (signing prompts, hotkey conflicts on a given OS); decide which block the pilot vs. ship later.

---

## Spec coverage self-review

| Spec § | Requirement                                                                        | Implemented in                                                         |
| ------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 12     | Tauri shell wrapping chat UI                                                       | Tasks 1, 5                                                             |
| 12     | System tray                                                                        | Task 2                                                                 |
| 12     | Global hotkey                                                                      | Task 3                                                                 |
| 12     | Native auth flow                                                                   | Task 4                                                                 |
| 12     | Auto-update via Tauri updater + signed builds                                      | Task 6                                                                 |
| 17     | Desktop builds via GitHub Releases                                                 | Task 6                                                                 |
| (v2)   | Native notifications — plugin registered but not wired beyond confirmation prompts | Task 1 plugin registration; full proactive alert wiring is v2 per spec |
