import { createHash, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { type BrowserWorker, BusyError, UnknownSession } from './browser';
import type { Config } from './config';
import { logger } from './logger';
import type { ReplayRequest } from './types';

/**
 * A small HTTP surface, for four jobs and no others.
 *
 *   GET    /health              Unauthenticated, on purpose. Railway polls it
 *                               to decide whether the container is alive, and a
 *                               health check that needs a credential is one
 *                               more thing that can be wrong at 3am. It reports
 *                               counters and whether Chromium is up -- nothing
 *                               about any errand, so there is nothing here
 *                               worth protecting.
 *
 *   POST   /replay              Run a learned flow. The normal path.
 *   POST   /session             Open an interactive page.
 *   POST   /session/:id/act     Act on it.
 *   DELETE /session/:id         Close it.
 *
 * Everything else is 404.
 *
 * WHAT AUTHENTICATES IT. One shared secret, `BROWSER_SERVICE_TOKEN`, compared
 * in constant time -- the same shape and the same reasoning as the WhatsApp
 * bridge (apps/web/lib/whatsapp/bridge.ts). Both ends are ours, so a symmetric
 * secret over TLS is the honest mechanism and a signature scheme would be
 * ceremony.
 *
 * WHAT THE TOKEN IS WORTH, STATED PLAINLY: everything this service can do,
 * which includes being handed a decrypted credential in a request body. It has
 * the blast radius of operator infrastructure, it belongs in exactly two
 * places -- this Railway service and Vercel -- and it is never issued to a
 * customer, never rendered in the UI and never sent to a browser. Unlike the
 * WhatsApp bridge there is NO `?token=` query fallback here: nothing about this
 * surface is ever opened in a browser address bar, and a secret in a query
 * string is a secret in somebody's access log.
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function secretsMatch(presented: string, expected: string): boolean {
  // Hashed first so both sides are always 32 bytes: `timingSafeEqual` throws on
  // a length mismatch, and returning early on that throw leaks the length.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function authorized(req: IncomingMessage, config: Config): boolean {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return presented.length > 0 && secretsMatch(presented, config.serviceToken);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Bounded: a request body arrives before anything has authenticated it in
    // full, and an unbounded reader is a way to fill the container's memory
    // with one curl.
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function startServer(worker: BrowserWorker, config: Config): Server {
  const server = createServer((req, res) => {
    void handle(req, res, worker, config).catch((err: unknown) => {
      logger.error({ err: (err as Error).message }, 'request handler threw');
      if (!res.headersSent) json(res, 500, { error: 'Internal error' });
    });
  });

  // Longer than the default 2 minutes: one errand may legitimately take three,
  // and a socket closed underneath a run wastes the whole thing.
  server.requestTimeout = config.runTimeoutMs + 30_000;
  server.headersTimeout = 60_000;

  server.listen(config.port, () => {
    logger.info({ port: config.port }, 'browser service listening');
  });
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  worker: BrowserWorker,
  config: Config,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    // 200 even when Chromium is down. The container IS healthy -- it relaunches
    // the browser on demand, and failing the check here would have Railway
    // restart the process in the middle of doing exactly that.
    json(res, 200, { ok: true, ...worker.snapshot() });
    return;
  }

  if (!authorized(req, config)) {
    // The reason goes to the log, never to the caller.
    logger.warn({ path }, 'rejected a request with a bad or missing bearer token');
    json(res, 401, { error: 'Unauthorized' });
    return;
  }

  try {
    if (req.method === 'POST' && path === '/replay') {
      const body = (await readBody(req)) as ReplayRequest;
      if (!body?.startUrl || !Array.isArray(body.steps)) {
        json(res, 400, { error: 'startUrl and steps are required' });
        return;
      }
      const result = await worker.runReplay({
        runId: body.runId ?? 'anon',
        startUrl: body.startUrl,
        steps: body.steps,
        inputs: body.inputs ?? {},
        secrets: body.secrets ?? {},
        timeoutMs: body.timeoutMs,
      });
      json(res, 200, result);
      return;
    }

    if (req.method === 'POST' && path === '/session') {
      const body = (await readBody(req)) as { startUrl?: string };
      if (!body?.startUrl) {
        json(res, 400, { error: 'startUrl is required' });
        return;
      }
      json(res, 200, await worker.openSession(body.startUrl));
      return;
    }

    const actMatch = /^\/session\/([A-Za-z0-9_]+)\/act$/.exec(path);
    if (req.method === 'POST' && actMatch?.[1]) {
      const body = (await readBody(req)) as {
        action?: string;
        target?: ReplayRequest['steps'][number]['targets'][number] | null;
        text?: string;
        url?: string;
      };
      json(
        res,
        200,
        await worker.act(
          actMatch[1],
          body.action ?? '',
          body.target ?? null,
          body.text ?? '',
          body.url ?? '',
        ),
      );
      return;
    }

    const sessionMatch = /^\/session\/([A-Za-z0-9_]+)$/.exec(path);
    if (sessionMatch?.[1]) {
      if (req.method === 'GET') {
        json(res, 200, await worker.readSession(sessionMatch[1]));
        return;
      }
      if (req.method === 'DELETE') {
        await worker.closeSession(sessionMatch[1]);
        json(res, 200, { ok: true });
        return;
      }
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof BusyError) {
      json(res, 429, { error: err.message });
      return;
    }
    if (err instanceof UnknownSession) {
      json(res, 404, { error: err.message });
      return;
    }
    // The body can carry a decrypted credential, so only the path and the
    // message travel into the log -- never the payload.
    logger.error({ path, err: (err as Error).message }, 'the request failed');
    json(res, 500, { error: (err as Error).message });
  }
}
