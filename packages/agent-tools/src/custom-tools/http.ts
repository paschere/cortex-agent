/**
 * The HTTP client custom tools go out through.
 *
 * WHY NOT `fetch`. Three things this has to do that global fetch will not:
 *
 *   1. CONNECT TO A VALIDATED ADDRESS. `guard.ts` resolves the hostname and
 *      approves a specific IP. Handing the hostname to fetch throws that away:
 *      the stack resolves again, and a DNS server under the attacker's control
 *      can answer publicly for our check and privately for our connect (DNS
 *      rebinding, a real technique with public tooling). `node:http`'s `lookup`
 *      option lets us pin the socket to the address we approved while TLS still
 *      verifies the certificate against the real hostname via `servername`.
 *   2. STOP READING. A response cap enforced after `await res.text()` is not a
 *      cap; the megabytes are already in our heap. Here the socket is destroyed
 *      the moment the body crosses the limit.
 *   3. NOT FOLLOW REDIRECTS. `redirect: 'manual'` exists, but redirect handling
 *      is where the destination check gets bypassed, so it belongs in code we
 *      own, next to the validator, rather than in a flag.
 *
 * This never throws for network reasons. Every failure comes back as
 * `{ ok: false, error }` with a short cause, because a customer's endpoint
 * being down is not an exception in our program.
 */

import type { ApprovedDestination, HostResolver } from './guard';
import { BlockedDestinationError, assertPublicUrl } from './guard';

export interface RawRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface RawResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  /** True when the body was cut off at `maxBytes`. */
  truncated: boolean;
}

export type HttpOutcome =
  | {
      ok: true;
      response: RawResponse /** Hops taken, first entry is the original URL. */;
      chain: string[];
    }
  | {
      ok: false;
      error: string;
      cause: 'blocked' | 'timeout' | 'network' | 'redirect' | 'unsupported-runtime';
      chain: string[];
    };

export interface SendOptions {
  timeoutMs: number;
  maxBytes: number;
  allowInsecureHttp: boolean;
  followRedirects: boolean;
  maxRedirects?: number;
  resolve?: HostResolver;
  signal?: AbortSignal;
}

const DEFAULT_MAX_REDIRECTS = 3;

/** Header names that carry a credential and must not survive a cross-origin hop. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

/**
 * Send one request, honouring redirects only when asked and re-validating every
 * hop when it is. Returns the FINAL response.
 */
export async function sendRequest(request: RawRequest, opts: SendOptions): Promise<HttpOutcome> {
  const maxRedirects = opts.followRedirects ? (opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS) : 0;
  const chain: string[] = [];
  const deadline = Date.now() + opts.timeoutMs;

  // Loaded up front, and its absence reported as its own cause rather than as a
  // network failure. Every surface that runs a custom tool declares
  // `runtime = 'nodejs'`; the edge/Workers surfaces borrow the same package and
  // deserve a message that says "not here" instead of one blaming the
  // customer's server for something that never left our process.
  let node: NodeModules;
  try {
    node = await loadNodeHttp();
  } catch {
    return {
      ok: false,
      error:
        'Custom tools need the Node runtime and this surface does not provide it. Ask from the Cortex web chat instead.',
      cause: 'unsupported-runtime',
      chain,
    };
  }

  let current: RawRequest = request;
  let origin: string | null = null;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let destination: ApprovedDestination;
    try {
      // Every hop, not just the first. This is the check a 302 exists to skip.
      destination = await assertPublicUrl(current.url, {
        allowInsecureHttp: opts.allowInsecureHttp,
        resolve: opts.resolve,
      });
    } catch (err) {
      const message =
        err instanceof BlockedDestinationError
          ? err.message
          : `Blocked destination: ${String(err)}`;
      return { ok: false, error: message, cause: 'blocked', chain };
    }

    chain.push(destination.url.toString());
    if (origin === null) origin = destination.url.origin;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, error: 'The request timed out.', cause: 'timeout', chain };
    }

    let response: RawResponse;
    try {
      response = await once(node, current, destination, {
        timeoutMs: remaining,
        maxBytes: opts.maxBytes,
        signal: opts.signal,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const timedOut =
        e?.name === 'AbortError' || e?.code === 'ETIMEDOUT' || e?.code === 'ECONNRESET';
      return {
        ok: false,
        error: e?.message ? String(e.message) : 'The request failed.',
        cause: timedOut ? 'timeout' : 'network',
        chain,
      };
    }

    const location = response.headers.location;
    const isRedirect = response.status >= 300 && response.status < 400 && !!location;
    if (!isRedirect) return { ok: true, response, chain };

    if (hop >= maxRedirects) {
      return {
        ok: false,
        error: opts.followRedirects
          ? `The endpoint redirected more than ${maxRedirects} times.`
          : `The endpoint answered ${response.status} and redirected to another address. This tool does not follow redirects; point it at the final URL, or enable redirects knowing every hop is re-checked.`,
        cause: 'redirect',
        chain,
      };
    }

    let next: URL;
    try {
      next = new URL(location, destination.url);
    } catch {
      return {
        ok: false,
        error: 'The endpoint sent an invalid redirect.',
        cause: 'redirect',
        chain,
      };
    }

    // A redirect to somebody else's host must not carry our customer's API key
    // with it — that is how a credential ends up in an attacker's access log.
    const headers =
      next.origin === origin
        ? current.headers
        : Object.fromEntries(
            Object.entries(current.headers).filter(
              ([k]) => !CREDENTIAL_HEADERS.has(k.toLowerCase()),
            ),
          );

    // 303, and 301/302 on POST in practice, become a GET without a body.
    const drops = response.status === 303 || response.status === 301 || response.status === 302;
    current = {
      method:
        drops && current.method !== 'GET' && current.method !== 'HEAD' ? 'GET' : current.method,
      url: next.toString(),
      headers,
      body: drops ? undefined : current.body,
    };
  }

  return { ok: false, error: 'Too many redirects.', cause: 'redirect', chain };
}

interface OnceOptions {
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

/**
 * One request/response, pinned to `destination.address`.
 *
 * `lookup` is handed a function that ignores the hostname entirely and returns
 * the address the guard approved. TLS still validates against the hostname
 * because `servername` carries it, so this is pinning without weakening
 * certificate checking — the combination that makes rebinding a non-issue.
 */
interface NodeModules {
  http: typeof import('node:http');
  https: typeof import('node:https');
}

async function loadNodeHttp(): Promise<NodeModules> {
  const [httpNs, httpsNs] = await Promise.all([import('node:http'), import('node:https')]);
  // `.default` FIRST, and this is not style. For a CommonJS builtin the ESM
  // namespace object is a snapshot taken when the module was instantiated,
  // while `.default` is the live `module.exports` object. Anything that patches
  // the module afterwards — msw's request interceptor in our own test suite,
  // and every APM agent in production — mutates the live object, so reading the
  // namespace copy silently bypasses all of it. That failure looks like
  // "requests are not intercepted" and takes an afternoon to find.
  const http = ((httpNs as { default?: typeof import('node:http') }).default ??
    httpNs) as typeof import('node:http');
  const https = ((httpsNs as { default?: typeof import('node:https') }).default ??
    httpsNs) as typeof import('node:https');
  if (typeof http.request !== 'function' || typeof https.request !== 'function') {
    throw new Error('node:http is not usable in this runtime');
  }
  return { http, https };
}

async function once(
  { http, https }: NodeModules,
  request: RawRequest,
  destination: ApprovedDestination,
  opts: OnceOptions,
): Promise<RawResponse> {
  const url = destination.url;
  const secure = url.protocol === 'https:';
  const mod = secure ? https : http;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  return await new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const req = mod.request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port ? Number(url.port) : secure ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: { ...request.headers, host: url.host },
        ...(secure ? { servername: hostname } : {}),
        // `dns.lookup`'s two calling conventions, both of which Node uses: with
        // `all: true` (what `autoSelectFamily` asks for, and the default since
        // Node 20) it wants an ARRAY of records; otherwise a single address.
        // Answering the wrong one fails with "Invalid IP address: undefined",
        // which is a confusing way to learn this.
        lookup: (_host: string, options: { all?: boolean } | undefined, cb: unknown) => {
          const done = cb as (
            err: Error | null,
            address: string | { address: string; family: number }[],
            family?: number,
          ) => void;
          if (options?.all) {
            done(null, [{ address: destination.address, family: destination.family }]);
            return;
          }
          done(null, destination.address, destination.family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;

        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          const room = opts.maxBytes - size;
          if (chunk.length >= room) {
            chunks.push(chunk.subarray(0, Math.max(room, 0)));
            truncated = true;
            size = opts.maxBytes;
            // Stop paying for bytes we have already decided to throw away.
            res.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });

        const done = () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : (v ?? '');
          }
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? '',
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
              truncated,
            }),
          );
        };

        res.on('end', done);
        // `res.destroy()` above emits 'close' rather than 'end'; a truncated
        // body is still a body, so it resolves the same way.
        res.on('close', done);
        res.on('error', (err) => finish(() => reject(err)));
      },
    );

    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error('The request timed out.'), { name: 'AbortError' }));
    }, opts.timeoutMs);
    // Never hold the process open for a hung third party.
    if (typeof timer.unref === 'function') timer.unref();

    const onAbort = () => req.destroy(Object.assign(new Error('Aborted.'), { name: 'AbortError' }));
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    req.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      finish(() => reject(err));
    });
    req.on('close', () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}
