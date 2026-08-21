import { type Browser, type BrowserContext, type Page, chromium } from 'patchright';
import { type ChildProcess, spawn } from 'node:child_process';
import { createConnection } from 'node:net';

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

/**
 * Rechazo en la SALA DE ESPERA: el host lo negó, o Google lo clasificó en la
 * «additional review queue» (2025) cuyo default es denegar automáticamente.
 * Esto NO es un rechazo de IP: el bot ya pasó la pre-sala y pidió unirse, pero
 * no lo admitieron. Reintentar puede funcionar — a veces el primer intento se
 * auto-deniega y el segundo pasa a la cola estándar.
 */
const DENIED_IN_LOBBY =
  /denied|rechazad|no (fue|se).?admitid|not admitted|someone (denied|rejected)|no te permit|has been denied|your request (was|to join) (denied|rejected)|solicitud (denegada|rechazada)|knocked (out|back)/i;

const KICKED =
  /no puedes unirte|can'?t join|couldn'?t join|unable to join|no (es posible|pudo) unirse|removed from the meeting|you'?ve been removed|you'?re no longer|ya no est[aá]s|te (han )?expulsad|te quitaron|this browser (isn'?t|is not) supported|este navegador no/i;

export function looksKicked(visibleText: string): boolean {
  return KICKED.test(visibleText);
}

/** ¿Lo negaron en la sala de espera (no es un rechazo de IP)? */
export function looksDeniedInLobby(visibleText: string): boolean {
  return DENIED_IN_LOBBY.test(visibleText);
}

/**
 * CONNECT-OVER-CDP: el Chrome más limpio que se puede manejar con Playwright.
 *
 * Patchright parchea en la fase de launch (Runtime.enable, init scripts). Pero
 * si lanzamos Chrome a mano y conectamos por CDP, no hay __pwInitScripts, no
 * hay playwright__binding, no hay Runtime.enable — nada que Meet pueda leer.
 * Es la técnica que las guías de anti-detección 2026 recomiendan cuando
 * Patchright puro no basta: el navegador arranca como un Chrome de verdad y
 * Playwright solo observa, no inyecta.
 *
 * MEET_CDP_CONNECT=true la activa; sin eso, launchPersistentContext (Patchright
 * puro) sigue siendo el camino.
 */

/** Flags de Chrome para lanzarlo a mano (sin Playwright). */
export function chromeCliArgs(
  input: StealthLaunchInput,
  profileDir: string,
  debugPort: number,
): string[] {
  const args = [
    ...DOCKER_ARGS,
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    // Permisos de cámara/mic sin diálogo: con CDP no tenemos la API de
    // permissions de Playwright, así que Chrome los acepta solo.
    '--use-fake-ui-for-media-stream',
  ];
  if (input.proxyServer) {
    args.push(
      `--proxy-server=${input.proxyServer}`,
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    );
  }
  return args;
}

function waitForCDPPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = () => {
      const sock = createConnection({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Chrome CDP puerto ${port} no abrió en ${timeoutMs}ms`));
        } else {
          setTimeout(tryConnect, 200);
        }
      });
    };
    tryConnect();
  });
}

/** Lanza Chrome como proceso y espera a que el puerto de CDP abra. */
export async function launchChrome(
  input: StealthLaunchInput,
  profileDir: string,
): Promise<{ process: ChildProcess; port: number }> {
  // Patchright 1.62 no tipa executablePath con options, pero en runtime lo soporta
  // (es Playwright por debajo). Cast a any para no pelear con los tipos.
  const chromePath = (chromium as unknown as { executablePath: (opts?: { channel?: string }) => string }).executablePath({ channel: 'chrome' });
  if (!chromePath) throw new Error('No se encontró Chrome (¿falta patchright install chrome?)');
  const port = 9300 + Math.floor(Math.random() * 700);
  const args = chromeCliArgs(input, profileDir, port);
  const env = { ...process.env, TZ: input.timezone || 'America/Bogota' };

  console.log(`[cortex-meet] Chrome a mano: CDP puerto ${port}`);
  const proc = spawn(chromePath, args, {
    env,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[cortex-meet] Chrome salió con código ${code}`);
    }
  });
  await waitForCDPPort(port, 30_000);
  return { process: proc, port };
}

/** Conecta a Chrome por CDP y configura la auth del proxy si hace falta. */
export async function connectOverCDP(
  port: number,
  proxyUsername?: string | null,
  proxyPassword?: string | null,
): Promise<{ context: BrowserContext; browser: Browser }> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error('CDP: no había contexto default');

  // Auth del proxy: Chrome no soporta user:pass en --proxy-server. Si hay
  // credenciales, se intercepta el 407 por CDP y se responde.
  if (proxyUsername && proxyPassword) {
    const page = context.pages()[0] ?? (await context.newPage());
    const client = await context.newCDPSession(page);
    await client.send('Fetch.enable', {
      handleAuthRequests: true,
      patterns: [{ urlPattern: '*' }],
    });
    client.on('Fetch.authRequired', async (event: { requestId: string }) => {
      await client
        .send('Fetch.continueWithAuth', {
          requestId: event.requestId,
          authChallengeResponse: {
            response: 'ProvideCredentials',
            username: proxyUsername,
            password: proxyPassword,
          },
        })
        .catch(() => undefined);
    });
    client.on('Fetch.requestPaused', async (event: { requestId: string }) => {
      await client.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => undefined);
    });
  }

  return { context, browser };
}

/**
 * WARM-UP: que el perfil no parezca un bot que solo abre Meet.
 *
 * Visitamos Google y hacemos una búsqueda inocente antes de ir a Meet. Al
 * perfil le queda historial, cookies, un patrón de navegación que un bot
 * estéril no tiene. Meet (y Google en el login) ven un navegador "vivido".
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

/** Mueve el mouse con una curva suave (ease-in-out), no un teleport. */
export async function humanMove(page: Page, targetX: number, targetY: number): Promise<void> {
  const startX = targetX + (Math.random() - 0.5) * 300;
  const startY = targetY + (Math.random() - 0.5) * 200;
  const steps = 5 + Math.floor(Math.random() * 6);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const x = startX + (targetX - startX) * ease + (Math.random() - 0.5) * 4;
    const y = startY + (targetY - startY) * ease + (Math.random() - 0.5) * 4;
    await page.mouse.move(x, y);
    await page.waitForTimeout(15 + Math.random() * 35);
  }
}

/** Click humano: mueve el mouse al elemento y hace click con offset aleatorio. */
export async function humanClick(page: Page, selector: string, timeout = 8_000): Promise<boolean> {
  const el = page.locator(selector).first();
  const visible = await el
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
  if (!visible) return false;
  const box = await el.boundingBox();
  if (!box) return false;
  const x = box.x + box.width / 2 + (Math.random() - 0.5) * box.width * 0.3;
  const y = box.y + box.height / 2 + (Math.random() - 0.5) * box.height * 0.3;
  await humanMove(page, x, y);
  await humanPause(100, 300);
  await page.mouse.click(x, y);
  return true;
}
