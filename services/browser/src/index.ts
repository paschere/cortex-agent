import { BrowserWorker } from './browser';
import { loadConfig } from './config';
import { logger } from './logger';
import { startServer } from './server';

/**
 * The Cortex browser service.
 *
 * One process, one Chromium, one context per errand. It executes flows Cortex
 * sends it and reports what happened. It owns no data: it has no database
 * credentials, it keeps nothing between runs, and it does not know what a
 * workspace is -- every decision about who may run what, and every row that
 * results, lives in Cortex.
 *
 * Read `docs/operations/browser.md` before deploying this.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const worker = new BrowserWorker(config);
  const server = startServer(worker, config);

  // Railway sends SIGTERM and then waits before killing the container. Closing
  // Chromium in that window matters less than it does for the WhatsApp bridge
  // -- nothing here is buffered and nothing is lost -- but a browser left
  // running keeps file handles and a downloads directory alive, and the tidy
  // exit is what makes a redeploy predictable.
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down; closing the browser');
    await worker.stop().catch(() => undefined);
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A rejected promise nobody caught must not take the service down. A single
  // errand failing is a 500 to one caller; the process dying is every errand
  // failing until Railway notices.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: String(reason) }, 'unhandled rejection; the service stays up');
  });

  await worker.start();
}

void main().catch((err: unknown) => {
  logger.error({ err: (err as Error).message }, 'the browser service could not start');
  process.exit(1);
});
