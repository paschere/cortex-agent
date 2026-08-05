import { createHash, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { Config } from './config';
import { logger } from './logger';
import type { WhatsappBridge } from './socket';

/**
 * A very small HTTP surface, for two jobs and no others.
 *
 *   GET /health  Unauthenticated, on purpose. Railway polls it to decide
 *                whether the container is alive, and a health check that needs
 *                a credential is one more thing that can be wrong at 3am. It
 *                answers with the connection state and a couple of counters —
 *                nothing about any conversation, so there is nothing here worth
 *                protecting.
 *
 *   GET /qr      The pairing code as a PNG, behind the shared token. The Cortex
 *                screen normally shows this without anyone touching the
 *                service, and it is also printed in the logs; this exists for
 *                the case where Cortex cannot be reached and somebody still
 *                needs to pair the number.
 *
 * Everything else is 404. This process is not an API — it holds a socket open.
 */

function secretsMatch(presented: string, expected: string): boolean {
  // Hashed first so both sides are always 32 bytes: `timingSafeEqual` throws on
  // a length mismatch, and returning early on that throw leaks the length.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function authorized(req: IncomingMessage, config: Config): boolean {
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? '';
  const presented = bearer || query;
  return presented.length > 0 && secretsMatch(presented, config.bridgeToken);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function startServer(bridge: WhatsappBridge, config: Config): Server {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (req.method === 'GET' && path === '/health') {
      const snapshot = bridge.snapshot();
      // 200 even when WhatsApp is disconnected. The container IS healthy — it
      // is reconnecting, which is its job. Failing the check here would have
      // Railway restart the process mid-backoff and reset the very backoff that
      // is protecting the number.
      json(res, 200, { ok: true, ...snapshot });
      return;
    }

    if (req.method === 'GET' && path === '/qr') {
      if (!authorized(req, config)) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }
      const qr = bridge.currentQr();
      if (!qr) {
        json(res, 404, {
          error: 'There is no pairing code right now.',
          status: bridge.snapshot().status,
        });
        return;
      }
      // Rendered as a page rather than raw base64: whoever opens this is about
      // to point a phone camera at it.
      const html = `<!doctype html><meta charset="utf-8"><title>Vincular WhatsApp · Cortex</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9"><div style="text-align:center"><img src="${qr}" alt="Código QR" style="width:320px;height:320px;border-radius:14px;background:#fff;padding:12px"><p style="max-width:320px;color:#556;font-size:14px;line-height:1.5">Abre WhatsApp en el teléfono dedicado → Dispositivos vinculados → Vincular un dispositivo. El código cambia cada pocos segundos; recarga si se vence.</p></div></body>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    json(res, 404, { error: 'Not found' });
  });

  server.listen(config.port, () => {
    logger.info({ port: config.port }, 'health endpoint listening');
  });
  return server;
}
