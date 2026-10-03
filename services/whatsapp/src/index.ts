import { loadConfig } from './config';
import { CortexClient, CortexControl } from './cortex';
import { logger } from './logger';
import { SessionManager } from './manager';
import { startServer } from './server';
import { WhatsappSession } from './socket';

/**
 * The Cortex WhatsApp bridge.
 *
 * One process, many workspaces, one WhatsApp account per workspace (0189). For
 * each workspace Cortex leases to it, it holds an authenticated WebSocket open,
 * forwards the groups an operator switched on, and answers direct messages from
 * numbers Cortex has linked to a person. It owns no data: every session lives
 * in Postgres (see `auth-state.ts`) and every decision lives in Cortex.
 *
 * With WHATSAPP_ORGANIZATION_ID set it is the old single-workspace bridge,
 * unchanged in behaviour (see `manager.ts`).
 *
 * Read `docs/operations/whatsapp.md` before deploying this.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const manager = new SessionManager(config, {
    control: new CortexControl(config),
    createSession: (organizationId) =>
      new WhatsappSession(config, organizationId, new CortexClient(config, organizationId)),
  });
  const server = startServer(manager, config);

  // Railway sends SIGTERM and then waits before killing the container. That
  // window is the only chance to push the messages heard in the last few
  // seconds, which exist nowhere but this process's memory — losing them would
  // leave a hole in the archive that nothing downstream would ever notice.
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down; flushing anything still buffered');
    await manager.stop().catch(() => undefined);
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

  await manager.start();
}

void main().catch((err: unknown) => {
  logger.error({ err: (err as Error).message }, 'the bridge could not start');
  process.exit(1);
});
