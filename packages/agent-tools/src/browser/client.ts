import type { Logger } from '@cortex/core';
import type { PageSnapshot, ReplayResponse, Step, Target } from './types';

/**
 * Transport to the browser service.
 *
 * Same shape and the same reasoning as `vehicles/client.ts`: a portal that is
 * down, a captcha that will not solve and a plate that does not exist are
 * ordinary operating conditions rather than bugs, so nothing here throws. A
 * thrown error would abort the whole Cortex turn; a returned failure lets the
 * caller say a plain sentence about what happened.
 *
 * WHY IT IS AN INTERFACE AND NOT JUST A FUNCTION. Every test in this module
 * substitutes a fake -- which is how "a replay never calls the model" can be
 * asserted rather than hoped for, and how a broken portal can be simulated
 * without one. The HTTP implementation below is one line of `fetch`; the
 * interface is the part with a reason.
 */

export interface ReplayCall {
  runId: string;
  startUrl: string;
  steps: Step[];
  inputs: Record<string, string>;
  /** Decrypted for exactly this call. Never logged, never persisted. */
  secrets: Record<string, string>;
  timeoutMs?: number;
}

export interface ActCall {
  sessionId: string;
  action: string;
  target?: Target | null;
  text?: string;
  url?: string;
}

export interface ActResult {
  ok: boolean;
  error?: string;
  matchedTarget: string | null;
  snapshot: PageSnapshot;
}

export interface BrowserTransport {
  configured(): boolean;
  replay(call: ReplayCall): Promise<TransportResult<ReplayResponse>>;
  openSession(
    startUrl: string,
  ): Promise<TransportResult<{ sessionId: string; snapshot: PageSnapshot }>>;
  act(call: ActCall): Promise<TransportResult<ActResult>>;
  closeSession(sessionId: string): Promise<void>;
}

export type TransportResult<T> = { ok: true; data: T } | TransportFailure;

/** Never thrown, always returned. `reason` is user-facing prose. */
export interface TransportFailure {
  ok: false;
  configured: boolean;
  reason: string;
}

export const NOT_CONFIGURED_REASON =
  'El servicio de navegador no está conectado en este espacio de trabajo, así que no puedo hacer trámites en sitios web todavía. Alguien de operaciones tiene que apuntarlo primero.';

export function browserServiceConfigured(): boolean {
  return Boolean(process.env.BROWSER_SERVICE_URL && process.env.BROWSER_SERVICE_TOKEN);
}

/**
 * The caller's cancellation and our own deadline both have to abort the fetch.
 * `AbortSignal.any` landed in Node 20.3; on anything older the caller's signal
 * alone is honoured rather than losing cancellation to gain a timeout.
 */
function combineSignals(signal: AbortSignal | undefined, ms: number): AbortSignal | undefined {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal;
}

function describeStatus(status: number): string {
  if (status === 401 || status === 403) {
    return 'El servicio de navegador rechazó nuestra clave. Lo más probable es que la hayan rotado; operaciones tiene que actualizarla.';
  }
  if (status === 429) {
    return 'El servicio de navegador está ocupado con otros trámites en este momento. En un minuto se puede reintentar.';
  }
  if (status === 404) {
    return 'Esa sesión de navegador ya no existe. Hay que empezar de nuevo.';
  }
  if (status >= 500) {
    return 'El servicio de navegador falló al ejecutar el trámite. Suele recuperarse solo en unos minutos.';
  }
  return `El servicio de navegador rechazó la petición (${status}).`;
}

export function createHttpTransport(logger: Logger, signal?: AbortSignal): BrowserTransport {
  async function call<T>(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body: unknown,
    timeoutMs: number,
  ): Promise<TransportResult<T>> {
    const base = process.env.BROWSER_SERVICE_URL;
    const token = process.env.BROWSER_SERVICE_TOKEN;
    if (!base || !token) return { ok: false, configured: false, reason: NOT_CONFIGURED_REASON };

    let response: Response;
    try {
      response = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combineSignals(signal, timeoutMs),
      });
    } catch (err) {
      // The body carries decrypted credentials, so only the path travels into
      // the log -- never the payload and never the token.
      logger.warn({ err, path }, 'browser service request failed');
      return {
        ok: false,
        configured: true,
        reason: 'No pude comunicarme con el servicio de navegador. Puede estar reiniciándose.',
      };
    }

    if (!response.ok) {
      logger.error({ path, status: response.status }, 'browser service refused a request');
      return { ok: false, configured: true, reason: describeStatus(response.status) };
    }
    return { ok: true, data: (await response.json()) as T };
  }

  return {
    configured: browserServiceConfigured,
    // Generous: a real errand on a government portal is a dozen navigations,
    // several of them slow. The ceiling still has to exist so a hung site
    // cannot hold a chat turn open forever.
    replay: (c) => call<ReplayResponse>('/replay', 'POST', c, 200_000),
    openSession: (startUrl) =>
      call<{ sessionId: string; snapshot: PageSnapshot }>('/session', 'POST', { startUrl }, 60_000),
    act: (c) =>
      call<ActResult>(
        `/session/${encodeURIComponent(c.sessionId)}/act`,
        'POST',
        { action: c.action, target: c.target ?? null, text: c.text ?? '', url: c.url ?? '' },
        60_000,
      ),
    closeSession: async (sessionId) => {
      await call(`/session/${encodeURIComponent(sessionId)}`, 'DELETE', undefined, 15_000);
    },
  };
}
