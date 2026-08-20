import { loadConfig } from './config';
import { startServer } from './server';

/**
 * El bot de reuniones de Cortex.
 *
 * Un proceso, un Chrome por reunión (invitado anónimo por default), escuchando
 * la sala y mandando el transcript en vivo a Cortex. Owns nothing: la lógica
 * de quién puede meter a Cortex a una reunión, y a dónde va el transcript al
 * terminar, vive en Cortex.
 */
const config = loadConfig();
console.log(
  `[cortex-meet] modo=${config.mode} locale=${config.locale} tz=${config.timezone} proxy=${config.proxyServer ? 'sí' : 'NO'}`,
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
