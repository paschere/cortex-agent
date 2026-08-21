import { loadConfig } from './config';
import { startServer } from './server';

/**
 * El bot de reuniones de Cortex.
 *
 * Un proceso, un Chrome por reunión (Playwright 1.56 + join de Vexa: humanized
 * X11, selectores y admisión). El transcript y la voz siguen siendo de Cortex.
 */
const config = loadConfig();
if (!process.env.BOT_UI_LOCALE) process.env.BOT_UI_LOCALE = config.locale;
console.log(
  `[cortex-meet] modo=${config.mode} locale=${config.locale} tz=${config.timezone} ui=${config.uiInteractionMode} proxy=${config.proxyServer ? 'sí' : 'NO'}`,
);
if (!config.proxyServer) {
  console.warn(
    '[cortex-meet] AVISO: sin MEET_PROXY_SERVER Google ve la IP del contenedor (Railway) y suele expulsar al bot. Un proxy residencial sticky (idealmente SOCKS5) es lo que falta en producción.',
  );
}
const server = startServer(config);

const shutdown = (signal: string): void => {
  console.log(`[cortex-meet] ${signal}: cerrando`);
  server.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (r) =>
  console.error('[cortex-meet] unhandledRejection', String(r)),
);
