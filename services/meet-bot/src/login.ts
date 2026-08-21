/**
 * INICIAR SESIÓN UNA VEZ, EN EL PERFIL QUE EL BOT REUSA (modo account).
 *
 * El default de producción es invitado anónimo. Este script queda para el
 * camino MEET_MODE=account: abre Chrome visible en el perfil persistente y la
 * persona inicia sesión con la cuenta dedicada del bot. La sesión queda en
 * disco; el bot la reusa.
 *
 *     PROFILE_DIR=/tmp/cortex-meet-profile pnpm --filter @cortex/meet-bot login
 */

import { launchPersistentBrowser } from './stealth';

const PROFILE_DIR = process.env.PROFILE_DIR || '/tmp/cortex-meet-profile';

async function main(): Promise<void> {
  console.log(`[login] abriendo Chrome en el perfil ${PROFILE_DIR}`);
  console.log('[login] inicia sesión en la cuenta de Google que será el bot.');
  console.log(
    '[login] cuando termines y veas tu bandeja/cuenta, cierra la ventana o pulsa Ctrl+C aquí.',
  );

  const { context, page } = await launchPersistentBrowser(PROFILE_DIR);
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
