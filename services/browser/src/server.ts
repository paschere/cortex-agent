import { createHash, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { type BrowserWorker, BusyError, UnknownSession } from './browser';
import type { Config } from './config';
import { HumanHasControl } from './control';
import { logger } from './logger';
import { signStreamToken, verifyStreamToken } from './stream-token';
import { ForbiddenTarget } from './target';
import type { ReplayRequest, Target } from './types';

/**
 * A small HTTP surface, in two families and no more.
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
 * And the live-tab family (browser v2) on the same sessions: /control (el
 * volante), /secret-request y /secret (un campo que llena una persona),
 * /stream-token + el upgrade de WebSocket en /stream (la pantalla en vivo,
 * autenticada con un boleto firmado de un minuto porque la abre el navegador
 * de una persona — ver stream-token.ts).
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

/**
 * 32MB, and the number is the upload ceiling rather than a round guess.
 *
 * It was 2MB while a request body was a step list and a password. A replay may
 * now carry the files an `upload` step attaches, base64-encoded: 10MB of PDF is
 * about 13.4MB on the wire, and a trámite that attaches two of them is a real
 * thing — a filing with the certificate and the RUT. 32MB leaves room for that
 * plus the steps, and still bounds what one unauthenticated curl can make this
 * container allocate, which is the reason the cap exists at all.
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

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

  /**
   * La pantalla en vivo entra por aquí y no por `handle`: un upgrade de
   * WebSocket no es una petición normal y Node lo entrega por otro evento.
   *
   * QUIÉN PUEDE PASAR. No el bearer de servicio — esto lo abre el navegador de
   * una persona, que jamás lo tiene — sino un boleto firmado que Cortex pidió
   * hace segundos con ese bearer (stream-token.ts cuenta el esquema completo).
   * El boleto viaja en la query porque un upgrade no lleva headers propios, y
   * vale un minuto por exactamente esa razón.
   */
  const streaming = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/session\/([A-Za-z0-9_]+)\/stream$/.exec(url.pathname);
    const token = url.searchParams.get('token') ?? '';
    if (!match?.[1] || !verifyStreamToken(token, match[1], config.serviceToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const sessionId = match[1];
    streaming.handleUpgrade(req, socket, head, (ws) => {
      worker.attachStream(sessionId, ws).catch((err: unknown) => {
        logger.warn({ sessionId, err: (err as Error).message }, 'live stream did not attach');
        ws.close(4004, 'session is gone');
      });
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
        files: body.files ?? {},
        timeoutMs: body.timeoutMs,
      });
      json(res, 200, result);
      return;
    }

    // A quién pertenece la sesión sobre la que se actúa. Cortex lo manda en
    // todas sus llamadas de navegación libre; las pantallas viejas de handoff
    // no, y para esas el chequeo simplemente no aplica (browser.ts, `owner`).
    const owner = String(req.headers['x-cortex-owner'] ?? '').slice(0, 80) || undefined;

    // El «Reset» del computador del tenant: borra su perfil Chromium
    // persistente — cookies, logins, todo — de forma IRREVERSIBLE. Cerrar
    // conserva el disco; esto no. Quién lo pidió y por qué queda en la
    // auditoría de Cortex, que es quien llama: este servicio no tiene base de
    // datos y no recuerda nada.
    if (req.method === 'DELETE' && path === '/profile') {
      if (!owner) {
        json(res, 400, { error: 'x-cortex-owner is required' });
        return;
      }
      await worker.resetProfile(owner);
      json(res, 200, { ok: true });
      return;
    }

    // Exportar el perfil persistente del tenant como tar.gz. El meet-bot lo
    // usa para heredar la sesión de Google que alguien logueó aquí a mano
    // (la pestaña interactiva), sin tener que loguearse desde una IP de
    // datacenter — Google bloquea eso. El flujo es: el operador loguea la
    // cuenta del bot en una sesión interactiva del browser service, y el
    // meet-bot importa ese perfil antes de entrar a Meet.
    if (req.method === 'GET' && path === '/profile/export') {
      if (!owner) {
        json(res, 400, { error: 'x-cortex-owner is required' });
        return;
      }
      const dir = await worker.exportProfile(owner);
      if (!dir) {
        json(res, 404, { error: 'No hay perfil para ese owner' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="profile.tar.gz"`,
      });
      const tar = spawn('tar', ['-czf', '-', '-C', dir, '.']);
      tar.stdout.pipe(res);
      tar.stderr.on('data', (d) => logger.error({ err: d.toString() }, 'tar export error'));
      tar.on('close', (code) => {
        if (code !== 0 && !res.writableEnded) {
          res.end();
        }
      });
      req.on('close', () => tar.kill('SIGTERM'));
      return;
    }

    if (req.method === 'POST' && path === '/session') {
      const body = (await readBody(req)) as { startUrl?: string; owner?: string };
      if (!body?.startUrl) {
        json(res, 400, { error: 'startUrl is required' });
        return;
      }
      json(res, 200, await worker.openSession(body.startUrl, body.owner ?? owner));
      return;
    }

    // -----------------------------------------------------------------------
    // El volante, los secretos y la pantalla en vivo (browser v2).
    // -----------------------------------------------------------------------

    const controlMatch = /^\/session\/([A-Za-z0-9_]+)\/control$/.exec(path);
    if (controlMatch?.[1]) {
      if (req.method === 'GET') {
        json(res, 200, await worker.controlState(controlMatch[1], owner));
        return;
      }
      if (req.method === 'POST') {
        const body = (await readBody(req)) as { op?: string; reason?: string };
        if (body.op === 'request') worker.requestHelp(controlMatch[1], body.reason ?? '', owner);
        else if (body.op === 'take') worker.takeControl(controlMatch[1], owner);
        else if (body.op === 'release') worker.releaseControl(controlMatch[1], owner);
        else {
          json(res, 400, { error: 'op must be request, take or release' });
          return;
        }
        json(res, 200, await worker.controlState(controlMatch[1], owner));
        return;
      }
    }

    const secretRequestMatch = /^\/session\/([A-Za-z0-9_]+)\/secret-request$/.exec(path);
    if (req.method === 'POST' && secretRequestMatch?.[1]) {
      const body = (await readBody(req)) as { target?: Target; label?: string };
      if (!body?.target || !body?.label) {
        json(res, 400, { error: 'target and label are required' });
        return;
      }
      worker.requestSecret(secretRequestMatch[1], body.target, body.label, owner);
      json(res, 200, { ok: true });
      return;
    }

    const secretMatch = /^\/session\/([A-Za-z0-9_]+)\/secret$/.exec(path);
    if (req.method === 'POST' && secretMatch?.[1]) {
      const body = (await readBody(req)) as { value?: string };
      if (typeof body?.value !== 'string' || body.value.length === 0) {
        json(res, 400, { error: 'value is required' });
        return;
      }
      // Del cuerpo de esta petición al campo de la página. El body no se
      // loguea (la nota del catch de abajo ya lo dice para todos), y la
      // respuesta lleva la longitud, nunca el valor.
      json(res, 200, await worker.supplySecret(secretMatch[1], body.value.slice(0, 500), owner));
      return;
    }

    const streamTokenMatch = /^\/session\/([A-Za-z0-9_]+)\/stream-token$/.exec(path);
    if (req.method === 'POST' && streamTokenMatch?.[1]) {
      // Solo comprueba que la sesión exista y sea de quien pregunta; el boleto
      // resultante es lo que el navegador de la persona usará en el upgrade.
      await worker.controlState(streamTokenMatch[1], owner);
      json(res, 200, { token: signStreamToken(streamTokenMatch[1], config.serviceToken) });
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

    // -----------------------------------------------------------------------
    // Driving a tab that was handed over at a bot check. See `runReplay`.
    // -----------------------------------------------------------------------

    const viewMatch = /^\/session\/([A-Za-z0-9_]+)\/view$/.exec(path);
    if (req.method === 'GET' && viewMatch?.[1]) {
      json(res, 200, await worker.viewSession(viewMatch[1], owner));
      return;
    }

    const inputMatch = /^\/session\/([A-Za-z0-9_]+)\/input$/.exec(path);
    if (req.method === 'POST' && inputMatch?.[1]) {
      const body = (await readBody(req)) as {
        kind?: 'click' | 'type' | 'key' | 'scroll';
        x?: number;
        y?: number;
        text?: string;
      };
      if (!body?.kind) {
        json(res, 400, { error: 'kind is required' });
        return;
      }
      // Coordinates are clamped to the viewport rather than trusted. They
      // arrive from a picture in a browser, and a click at (0, 900000) is a
      // rounding bug on the way here, not an instruction.
      const clamp = (v: number | undefined, max: number) =>
        Math.max(0, Math.min(Math.round(v ?? 0), max));
      await worker.sendInput(
        inputMatch[1],
        {
          kind: body.kind,
          x: clamp(body.x, config.viewportWidth),
          y:
            body.kind === 'scroll' ? Math.round(body.y ?? 0) : clamp(body.y, config.viewportHeight),
          text: (body.text ?? '').slice(0, 200),
        },
        owner,
      );
      json(res, 200, { ok: true });
      return;
    }

    const continueMatch = /^\/session\/([A-Za-z0-9_]+)\/continue$/.exec(path);
    if (req.method === 'POST' && continueMatch?.[1]) {
      const body = (await readBody(req)) as {
        fromIndex?: number;
        inputs?: Record<string, unknown>;
      };
      const from = Number.isInteger(body?.fromIndex) ? Number(body?.fromIndex) : 0;
      // Only strings, only a handful, and capped. This is the one place a value
      // enters a run after it started, and what arrives is whatever a person
      // typed into a box — so it is narrowed here rather than trusted to have
      // been narrowed by whoever called.
      const inputs: Record<string, string> = {};
      for (const [key, value] of Object.entries(body?.inputs ?? {}).slice(0, 8)) {
        if (typeof value === 'string') inputs[key.slice(0, 40)] = value.slice(0, 300);
      }
      json(res, 200, await worker.continueSession(continueMatch[1], Math.max(0, from), inputs));
      return;
    }

    const sessionMatch = /^\/session\/([A-Za-z0-9_]+)$/.exec(path);
    if (sessionMatch?.[1]) {
      if (req.method === 'GET') {
        json(res, 200, await worker.readSession(sessionMatch[1], owner));
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
    if (err instanceof ForbiddenTarget) {
      // 400 con la frase: quien pidió (el modelo, o una pantalla) puede leerla
      // y no reintentar. El código deja que el transporte la distinga.
      json(res, 400, { error: err.message, code: 'forbidden-target' });
      return;
    }
    if (err instanceof HumanHasControl) {
      // 409 con nombre: el que llama es un modelo, y «una persona está
      // conduciendo; espera» es una instrucción que sabe seguir. Un 500 no.
      json(res, 409, { error: err.message, code: 'human-has-control' });
      return;
    }
    // The body can carry a decrypted credential, so only the path and the
    // message travel into the log -- never the payload.
    logger.error({ path, err: (err as Error).message }, 'the request failed');
    json(res, 500, { error: (err as Error).message });
  }
}
