import { createHash, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { Config } from './config';
import type { Transcript } from './deepgram';
import { MeetSession, type MeetStatus } from './session';

/**
 * La cara HTTP del bot de reuniones. Pequeña, y con dueño en cada llamada.
 *
 *   GET  /health                  sin auth; Railway lo consulta.
 *   POST /join                    {owner, meetUrl, botName} → {sessionId}
 *   GET  /session/:id/stream      SSE: transcript + estado en vivo (para el chat)
 *   GET  /session/:id             el transcript acumulado + estado (poll/import)
 *   POST /session/:id/leave       el bot cuelga
 *
 * Autenticado con MEET_SERVICE_TOKEN, la misma forma que el browser service:
 * ambos extremos son nuestros, secreto simétrico sobre TLS. El SSE del
 * transcript también exige el token — lo consume Cortex (server-side), no el
 * navegador de una persona, así que aquí no hay boleto de corta vida.
 */

interface LiveMeeting {
  session: MeetSession;
  owner: string;
  meetUrl: string;
  transcript: Transcript[];
  status: MeetStatus;
  detail: string | null;
  /** Suscriptores SSE, para empujarles cada línea nueva. */
  subscribers: Set<ServerResponse>;
}

export function startServer(config: Config): Server {
  const meetings = new Map<string, LiveMeeting>();

  function secretsMatch(presented: string): boolean {
    const a = createHash('sha256').update(presented).digest();
    const b = createHash('sha256').update(config.serviceToken).digest();
    return timingSafeEqual(a, b);
  }
  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    return token.length > 0 && secretsMatch(token);
  }

  function push(m: LiveMeeting, event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of m.subscribers) res.write(payload);
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 1_000_000) throw new Error('body too large');
      chunks.push(c as Buffer);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    const s = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(s),
    });
    res.end(s);
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
      json(res, 200, { ok: true, live: meetings.size, maxConcurrent: config.maxConcurrent });
      return;
    }
    if (!authorized(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }

    // Importar un perfil de Chrome ya autenticado a /profiles/<owner>. Se usa
    // UNA vez por tenant para sembrar la sesión de Google sin pelear con el
    // login headless (que Google bloquea desde un datacenter). Recibe un
    // tar.gz por el cuerpo; lo extrae al directorio del owner.
    if (req.method === 'POST' && path === '/profile/import') {
      const owner = String(url.searchParams.get('owner') ?? '');
      if (!owner) {
        json(res, 400, { error: 'owner es obligatorio' });
        return;
      }
      const safe = owner.replace(/[^A-Za-z0-9_-]/g, '_');
      const dir = `${config.profilesDir}/${safe}`;
      try {
        const { mkdirSync, rmSync } = await import('node:fs');
        const { spawn } = await import('node:child_process');
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        // tar lee el gzip del stdin y extrae en dir. El cuerpo es el tar.gz.
        const tar = spawn('tar', ['-xzf', '-', '-C', dir]);
        req.pipe(tar.stdin);
        await new Promise<void>((resolve, reject) => {
          tar.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`tar salió ${code}`)),
          );
          tar.on('error', reject);
        });
        json(res, 200, { ok: true, dir });
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
      return;
    }

    if (req.method === 'POST' && path === '/join') {
      const body = await readBody(req);
      const owner = String(body.owner ?? '');
      const meetUrl = String(body.meetUrl ?? '');
      const botName = String(body.botName ?? 'Cortex');
      const voiceEnabled = body.voiceEnabled === true;
      if (!owner || !/^https:\/\/meet\.google\.com\//.test(meetUrl)) {
        json(res, 400, { error: 'owner y un meetUrl de meet.google.com son obligatorios' });
        return;
      }
      if (meetings.size >= config.maxConcurrent) {
        json(res, 429, { error: 'El bot está en el máximo de reuniones a la vez.' });
        return;
      }
      const id = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const m: LiveMeeting = {
        session: undefined as unknown as MeetSession,
        owner,
        meetUrl,
        transcript: [],
        status: 'joining',
        detail: null,
        subscribers: new Set(),
      };
      m.session = new MeetSession(
        id,
        owner,
        meetUrl,
        botName,
        config,
        {
          onTranscript: (t) => {
            // Solo los finales se guardan; los parciales viajan al vivo y se
            // reemplazan. Así el transcript acumulado (el que se importa) no
            // repite media frase tres veces.
            if (t.isFinal) m.transcript.push(t);
            push(m, 'transcript', t);
          },
          onStatus: (status, detail) => {
            m.status = status;
            m.detail = detail ?? null;
            push(m, 'status', { status, detail: detail ?? null });
            if (status === 'ended' || status === 'failed') {
              // Dar un momento a que los suscriptores reciban el último evento.
              setTimeout(() => meetings.delete(id), 30_000);
            }
          },
        },
        voiceEnabled,
      );
      meetings.set(id, m);
      // Unirse en segundo plano: /join responde ya con el id, y el estado viaja
      // por el stream. Un join tarda (admisión humana) y no debe colgar el POST.
      void m.session.join().catch((err) => {
        m.status = 'failed';
        m.detail = (err as Error).message;
        push(m, 'status', { status: 'failed', detail: m.detail });
      });
      json(res, 200, { sessionId: id });
      return;
    }

    if (req.method === 'GET' && path === '/live') {
      const owner = url.searchParams.get('owner') ?? '';
      const mine = [...meetings.entries()]
        .filter(([, m]) => m.owner === owner)
        .map(([id, m]) => ({ sessionId: id, status: m.status, transcript: m.transcript }));
      json(res, 200, { meetings: mine });
      return;
    }

    const voiceMatch = /^\/session\/([A-Za-z0-9_]+)\/voice$/.exec(path);
    if (req.method === 'POST' && voiceMatch) {
      const m = meetings.get(voiceMatch[1] ?? '');
      if (!m) {
        json(res, 404, { error: 'sesión no encontrada' });
        return;
      }
      const body = await readBody(req);
      m.session.setVoiceMuted(body.muted === true);
      json(res, 200, { ok: true, muted: body.muted === true });
      return;
    }

    const streamMatch = /^\/session\/([A-Za-z0-9_]+)\/stream$/.exec(path);
    if (req.method === 'GET' && streamMatch) {
      const m = meetings.get(streamMatch[1] ?? '');
      if (!m) {
        json(res, 404, { error: 'sesión no encontrada' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // Al conectar, mandar el estado y lo dicho hasta ahora, para que un chat
      // que abre a mitad de reunión no arranque en blanco.
      res.write(
        `event: status\ndata: ${JSON.stringify({ status: m.status, detail: m.detail })}\n\n`,
      );
      for (const t of m.transcript) res.write(`event: transcript\ndata: ${JSON.stringify(t)}\n\n`);
      m.subscribers.add(res);
      const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15_000);
      req.on('close', () => {
        clearInterval(keepalive);
        m.subscribers.delete(res);
      });
      return;
    }

    const idMatch = /^\/session\/([A-Za-z0-9_]+)$/.exec(path);
    if (req.method === 'GET' && idMatch) {
      const m = meetings.get(idMatch[1] ?? '');
      if (!m) {
        json(res, 404, { error: 'sesión no encontrada' });
        return;
      }
      json(res, 200, {
        status: m.status,
        detail: m.detail,
        meetUrl: m.meetUrl,
        transcript: m.transcript,
      });
      return;
    }

    const leaveMatch = /^\/session\/([A-Za-z0-9_]+)\/leave$/.exec(path);
    if (req.method === 'POST' && leaveMatch) {
      const m = meetings.get(leaveMatch[1] ?? '');
      if (m) await m.session.leave().catch(() => undefined);
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { error: 'Not found' });
  }

  server.listen(config.port, () => {
    console.log(`[cortex-meet] escuchando en :${config.port}`);
  });
  return server;
}
