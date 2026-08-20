import { loadConfig } from './config';
import { startServer } from './server';

/**
 * El bot de reuniones de Cortex.
 *
 * Un proceso, un Chrome autenticado por reunión, escuchando la sala y
 * mandando el transcript en vivo a Cortex. Owns nothing: la lógica de quién
 * puede meter a Cortex a una reunión, y a dónde va el transcript al terminar,
 * vive en Cortex. Read services/meet-bot/README.md before deploying.
 */
const config = loadConfig();
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
