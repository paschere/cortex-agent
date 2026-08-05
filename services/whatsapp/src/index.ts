import { loadConfig } from './config';
import { logger } from './logger';
import { startServer } from './server';
import { WhatsappBridge } from './socket';

/**
 * The Cortex WhatsApp bridge.
 *
 * One process, one WhatsApp account, one Cortex workspace. It holds an
 * authenticated WebSocket open, forwards the groups an operator switched on,
 * and answers direct messages from numbers Cortex has linked to a person. It
 * owns no data: the session lives in Postgres (see `auth-state.ts`) and every
 * decision lives in Cortex.
 *
 * Read `docs/operations/whatsapp.md` before deploying this.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const bridge = new WhatsappBridge(config);
  const server = startServer(bridge, config);

  // Railway sends SIGTERM and then waits before killing the container. That
  // window is the only chance to push the messages heard in the last few
  // seconds, which exist nowhere but this process's memory — losing them would
  // leave a hole in the archive that nothing downstream would ever notice.
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down; flushing anything still buffered');
    await bridge.stop().catch(() => undefined);
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A rejected promise nobody caught must not take the socket down silently.
  // The connection is worth more than the request that failed.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: String(reason) }, 'unhandled rejection; the connection stays up');
  });

  await bridge.start();
}

void main().catch((err: unknown) => {
  logger.error({ err: (err as Error).message }, 'the bridge could not start');
  process.exit(1);
});
