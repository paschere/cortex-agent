import type { Page, chromium } from 'patchright';

/**
 * Chrome «de persona», no de bot.
 *
 * El plugin stealth de puppeteer-extra (navigator.plugins = [1,2,3,4,5],
 * getters inventados sobre webdriver) ES una huella: Meet la lee y expulsa.
 * Patchright parchea Playwright a nivel CDP (el leak de Runtime.enable que
 * Google sí usa) y pide Chrome real, headed, viewport nulo y SIN inyectar
 * user-agent ni headers. Eso es lo que hay aquí.
 *
 * Lo único que sí fijamos: locale/timezone (un contenedor sale en UTC, y
 * UTC+IP de Railway es un datacenter) y los flags que Docker o el proxy
 * obligan. Nada más.
 */

export interface StealthLaunchInput {
  proxyServer?: string | null;
  proxyUsername?: string | null;
  proxyPassword?: string | null;
  locale?: string;
  timezone?: string;
}

const DOCKER_ARGS = [
  // Obligatorio dentro del contenedor; sin esto Chrome no arranca como pwuser.
  '--no-sandbox',
  '--disable-dev-shm-usage',
  // El tap de audio necesita que Meet reproduzca sin un click humano.
  '--autoplay-policy=no-user-gesture-required',
  '--no-first-run',
  '--start-maximized',
];

export function chromeLaunchOptions(
  input: StealthLaunchInput = {},
): Parameters<typeof chromium.launchPersistentContext>[1] {
  const locale = input.locale || 'es-CO';
  const timezoneId = input.timezone || 'America/Bogota';
  const args = [...DOCKER_ARGS];
  // Con proxy, WebRTC por UDP se iría DIRECTO (IP de Railway) y Meet echa
  // al participante a los pocos segundos. Forzar todo el media por el proxy
  // (TURN/TCP si el proxy es HTTP). Sin proxy no se pone: cortaría el audio.
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
    channel: 'chrome',
    headless: false,
    // Patchright: viewport emulado es huella. null = el tamaño real (Xvfb o la
    // ventana). No userAgent, no extraHTTPHeaders.
    viewport: null,
    locale,
    timezoneId,
    colorScheme: 'light',
    permissions: ['microphone', 'camera'],
    ignoreDefaultArgs: ['--enable-automation'],
    args,
    ...(proxy ? { proxy } : {}),
  };
}

/** Pausa irregular, como una persona leyendo la pre-sala. */
export function humanPause(minMs = 400, maxMs = 1_200): Promise<void> {
  const span = Math.max(0, maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, minMs + Math.random() * span));
}

/**
 * Patchright corre evaluate en un mundo aislado por defecto (para no triggear
 * Runtime.enable en el JS de Meet). El tap de audio tiene que ver los
 * <audio>/<video> de Meet y el binding, así que a veces hay que pedir el
 * mundo principal — y solo DESPUÉS de estar dentro, nunca en el join.
 */
export async function evaluateInMain(page: Page, script: string): Promise<unknown> {
  return page.evaluate(script, undefined, undefined, false);
}

const KICKED =
  /no puedes unirte|can'?t join|couldn'?t join|unable to join|no (es posible|pudo) unirse|removed from the meeting|you'?ve been removed|you'?re no longer|ya no est[aá]s|te (han )?expulsad|te quitaron|this browser (isn'?t|is not) supported|este navegador no/i;

export function looksKicked(visibleText: string): boolean {
  return KICKED.test(visibleText);
}
