/**
 * INICIAR SESIÓN UNA VEZ, EN EL PERFIL QUE EL BOT REUSA.
 *
 * F0 demostró que el invitado anónimo no pasa: Meet corre un chequeo anti-bot
 * al «Solicitar unirse» y lo reprueba. Un usuario AUTENTICADO de Google no
 * pasa por ese filtro — por eso el plan eligió la cuenta real, y por eso este
 * paso existe.
 *
 * Abre el mismo perfil persistente que usa el spike, en Chrome visible, en la
 * pantalla de acceso de Google. La persona inicia sesión con la cuenta que va
 * a ser el bot (idealmente una cuenta dedicada, cortex@…), y al terminar la
 * sesión queda escrita en el perfil de disco. El spike, que reusa ese mismo
 * PROFILE_DIR, entra a las reuniones ya logueado.
 *
 * En producción esto NO es un humano frente a una pantalla: es el flujo de
 * secretos del navegador (browser v2) escribiendo la contraseña directo en la
 * página de Google sin que el modelo la vea. Aquí, para el spike, la persona
 * lo hace a mano una vez.
 *
 *     PROFILE_DIR=/tmp/cortex-meet-profile node services/meet-bot/dist/login.js
 */

import { chromium } from 'playwright';

const PROFILE_DIR = process.env.PROFILE_DIR || '/tmp/cortex-meet-profile';

async function main(): Promise<void> {
  console.log(`[login] abriendo Chrome en el perfil ${PROFILE_DIR}`);
  console.log('[login] inicia sesión en la cuenta de Google que será el bot.');
  console.log(
    '[login] cuando termines y veas tu bandeja/cuenta, cierra la ventana o pulsa Ctrl+C aquí.',
  );

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
      '--start-maximized',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  `);

  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded' });

  // Se queda abierto hasta que la persona cierre la ventana. Detectar el cierre
  // del contexto es la señal de «terminé».
  await new Promise<void>((resolve) => {
    context.on('close', () => resolve());
    process.on('SIGINT', () => {
      void context.close().then(() => resolve());
    });
  });

  console.log('[login] sesión guardada en el perfil. El spike ya puede entrar autenticado.');
  process.exit(0);
}

void main().catch((err) => {
  console.error('[login] falló:', (err as Error).message);
  process.exit(1);
});
