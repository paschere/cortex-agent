import type { BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import { getJoinBrowserArgs, resolveBotUiLocale } from './join/browser-args';

/**
 * Chrome launch for Meet — same contract as Vexa's remote-browser brick:
 * playwright-extra + launchPersistentContext, headed, viewport null, no
 * --enable-automation, UI locale pinned.
 *
 * Cortex extras that Vexa does not need in a one-bot-per-pod world:
 * proxy + WebRTC-through-proxy (Railway IPs get kicked), DISPLAY/TZ, and
 * --disable-dev-shm-usage for Docker. --incognito is stripped: it wipes the
 * profile that authenticated joins depend on (Vexa's own remote-browser notes).
 */

export interface StealthLaunchInput {
  proxyServer?: string | null;
  proxyUsername?: string | null;
  proxyPassword?: string | null;
  locale?: string;
  timezone?: string;
  display?: string;
}

export function chromeLaunchOptions(
  input: StealthLaunchInput = {},
): Parameters<typeof chromium.launchPersistentContext>[1] {
  const locale = input.locale || resolveBotUiLocale();
  const timezoneId = input.timezone || 'America/Bogota';
  const args = [
    ...getJoinBrowserArgs().filter((a) => a !== '--incognito'),
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--start-maximized',
    '--password-store=basic',
  ];
  if (input.proxyServer) {
    args.push(
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    );
  }

  const proxy = input.proxyServer
    ? {
        server: input.proxyServer,
        ...(input.proxyUsername ? { username: input.proxyUsername } : {}),
        ...(input.proxyPassword ? { password: input.proxyPassword } : {}),
      }
    : undefined;

  return {
    // Real Chrome: Meet rejects codec-less Chromium with "you can't join".
    channel: 'chrome',
    headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
    args,
    viewport: null,
    locale,
    timezoneId,
    colorScheme: 'light',
    permissions: ['microphone', 'camera'],
    ...(proxy ? { proxy } : {}),
    env: {
      ...process.env,
      TZ: timezoneId,
      ...(input.display ? { DISPLAY: input.display } : {}),
    },
  };
}

export async function launchPersistentBrowser(
  profileDir: string,
  input: StealthLaunchInput = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(profileDir, chromeLaunchOptions(input));
  const page = context.pages()[0] || (await context.newPage());
  return { context, page };
}

/** Pausa irregular, como una persona leyendo la pre-sala. */
export function humanPause(minMs = 400, maxMs = 1_200): Promise<void> {
  const span = Math.max(0, maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, minMs + Math.random() * span));
}

/**
 * WARM-UP: que el perfil no parezca un bot que solo abre Meet.
 */
export async function warmUpProfile(page: Page): Promise<void> {
  await page
    .goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 15_000 })
    .catch(() => undefined);
  await humanPause(800, 2_000);

  const searchBox = page.locator('input[name="q"], textarea[name="q"]').first();
  if (await searchBox.isVisible().catch(() => false)) {
    await searchBox.click().catch(() => undefined);
    await searchBox
      .pressSequentially('noticias del día', { delay: 60 + Math.random() * 60 })
      .catch(() => undefined);
    await humanPause(300, 800);
    await page.keyboard.press('Enter').catch(() => undefined);
    await humanPause(1_500, 3_000);
  }
}
