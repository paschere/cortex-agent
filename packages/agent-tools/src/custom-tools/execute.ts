/**
 * Running one custom tool: definition + arguments → a request, a response, and
 * a sentence when it goes wrong.
 *
 * TWO RULES GOVERN THIS FILE.
 *
 * 1. IT NEVER THROWS. A 401 from a customer's ERP, a certificate that expired
 *    last night, a gateway timeout at 4pm — these are the ordinary operating
 *    conditions of somebody else's system, not faults in ours. A thrown error
 *    aborts the whole agent turn and the person gets a red box; a returned
 *    `{ ok: false, message }` lets the agent say "el ERP respondió 401, la
 *    llave parece vencida" and carry on. Same contract the vehicles client
 *    holds, for the same reason.
 *
 * 2. THE SECRET NEVER COMES BACK OUT. It is decrypted here, put into exactly
 *    one header, and every other path — the tester's request preview, the error
 *    messages, the response body — goes through `redact()` first. The audit
 *    trail is safe by construction rather than by scrubbing: `runTool` hashes
 *    the tool INPUT, which is the model's arguments, and the secret is not one
 *    of them.
 */

import { decryptToken, logger } from '@cortex/core';
import type { HostResolver } from './guard';
import { type RawRequest, type RawResponse, sendRequest } from './http';
import { selectResponse } from './response';
import { renderBody, renderHeaders, renderUrl, sanitizeHeaderValue } from './template';
import type { CustomToolResult, CustomToolRow } from './types';

/** What replaces a secret anywhere a human or a model might read it. */
export const REDACTED = '••••••••';

/**
 * Remove every literal occurrence of the secret from a piece of text.
 *
 * Belt and braces: nothing is supposed to echo the secret back, but an endpoint
 * that helpfully replies `{"error":"invalid key sk_live_…"}` would otherwise
 * put it straight into the chat transcript and the tester's screen.
 */
export function redact(text: string, secret: string | null): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join(REDACTED);
}

export interface BuiltRequest {
  request: RawRequest;
  /** Same request with the credential replaced. This is what may be displayed. */
  preview: RawRequest;
  secret: string | null;
}

/**
 * Assemble the outgoing request. Pure apart from decrypting the stored secret;
 * no network. Split out so the tester can show what WOULD be sent even when the
 * destination check refuses it.
 */
export function buildRequest(row: CustomToolRow, input: Record<string, unknown>): BuiltRequest {
  const url = renderUrl(row.url_template, input);
  const headers = renderHeaders((row.headers ?? {}) as Record<string, string>, input);

  const { body, contentType } = renderBody(row.body_encoding, row.body_template, input);
  if (contentType && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = contentType;
  }
  // Politeness, and a useful line in a customer's access log when they ask us
  // what has been hitting their API.
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = 'Cortex/1.0 (custom tool)';
  }
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) {
    headers.Accept = 'application/json, text/plain;q=0.9, */*;q=0.8';
  }

  let secret: string | null = null;
  if (row.auth_type !== 'none' && row.auth_secret_encrypted) {
    try {
      secret = decryptToken(row.auth_secret_encrypted);
    } catch (err) {
      // A key rotation that left a row behind. Better to send the request
      // unauthenticated and let the endpoint say 401 than to fail opaquely.
      logger.warn({ err, toolId: row.id }, 'custom tool: stored secret could not be decrypted');
      secret = null;
    }
  }

  const authHeader = authHeaderFor(row, secret);
  const request: RawRequest = { method: row.http_method, url, headers: { ...headers }, body };
  const preview: RawRequest = { method: row.http_method, url, headers: { ...headers }, body };

  if (authHeader) {
    request.headers[authHeader.name] = authHeader.value;
    preview.headers[authHeader.name] = authHeader.preview;
  }

  return { request, preview, secret };
}

function authHeaderFor(
  row: CustomToolRow,
  secret: string | null,
): { name: string; value: string; preview: string } | null {
  if (row.auth_type === 'none' || !secret) return null;
  const clean = sanitizeHeaderValue(secret);
  if (row.auth_type === 'bearer') {
    return { name: 'Authorization', value: `Bearer ${clean}`, preview: `Bearer ${REDACTED}` };
  }
  if (row.auth_type === 'basic') {
    const user = sanitizeHeaderValue(row.auth_username ?? '');
    const encoded = Buffer.from(`${user}:${clean}`, 'utf8').toString('base64');
    return { name: 'Authorization', value: `Basic ${encoded}`, preview: `Basic ${REDACTED}` };
  }
  // 'header'
  const name = row.auth_header_name?.trim() || 'X-API-Key';
  return { name, value: clean, preview: REDACTED };
}

/** Response bytes we are willing to pull down before deciding it is too much. */
function byteBudget(row: CustomToolRow): number {
  // Generous relative to response_max_chars: the SLICE is what the model sees,
  // and the slice usually lives inside a larger document. Hard ceiling so a
  // misconfigured tool cannot stream a gigabyte into memory.
  return Math.min(2_000_000, Math.max(64_000, row.response_max_chars * 20));
}

export interface ExecuteOptions {
  signal?: AbortSignal;
  resolve?: HostResolver;
}

export interface ExecuteDetail {
  /** The request as it may be shown — credential already replaced. */
  preview: RawRequest;
  /** Every URL actually contacted, redirects included. */
  chain: string[];
  /** The raw response, redacted and capped. Only populated by the tester. */
  response?: RawResponse;
}

/**
 * Run a tool and return both the model-facing result and, separately, the raw
 * detail the tester needs. Callers that are not the tester ignore `detail`.
 */
export async function executeCustomTool(
  row: CustomToolRow,
  input: Record<string, unknown>,
  opts: ExecuteOptions = {},
): Promise<{ result: CustomToolResult; detail: ExecuteDetail }> {
  let built: BuiltRequest;
  try {
    built = buildRequest(row, input);
  } catch (err) {
    // Rendering is pure and should not fail, but "should not" is not a contract
    // we get to rely on when a customer wrote the template.
    return {
      result: {
        ok: false,
        status: null,
        message: `The tool "${row.name}" could not build its request: ${err instanceof Error ? err.message : String(err)}. Its configuration needs fixing.`,
      },
      detail: {
        preview: { method: row.http_method, url: row.url_template, headers: {} },
        chain: [],
      },
    };
  }

  const { request, preview, secret } = built;

  const outcome = await sendRequest(request, {
    timeoutMs: row.timeout_ms,
    maxBytes: byteBudget(row),
    allowInsecureHttp: row.allow_insecure_http,
    followRedirects: row.follow_redirects,
    resolve: opts.resolve,
    signal: opts.signal,
  });

  if (!outcome.ok) {
    return {
      result: {
        ok: false,
        status: null,
        message: describeTransportFailure(row, outcome.cause, redact(outcome.error, secret)),
      },
      detail: { preview, chain: outcome.chain },
    };
  }

  const response = outcome.response;
  const safeBody = redact(response.body, secret);
  const redactedResponse: RawResponse = { ...response, body: safeBody };

  if (response.status >= 400) {
    return {
      result: {
        ok: false,
        status: response.status,
        message: describeHttpError(row, response.status, safeBody),
      },
      detail: { preview, chain: outcome.chain, response: redactedResponse },
    };
  }

  const selected = selectResponse(safeBody, row.response_path, row.response_max_chars);
  return {
    result: {
      ok: true,
      status: response.status,
      data: selected.data,
      ...(selected.truncated ? { truncated: true } : {}),
      ...(selected.pathMissed
        ? {
            message: `Warning: the configured response path "${row.response_path}" matched nothing, so this is the whole response body.`,
          }
        : {}),
    },
    detail: { preview, chain: outcome.chain, response: redactedResponse },
  };
}

/**
 * Model-facing prose for a request that never produced a response.
 *
 * Written in English like the rest of the tool layer (vehicles, the MCP proxy):
 * these strings are read by the model, which then explains the situation to the
 * person in Spanish. Each one says what happened AND what would fix it,
 * because the model is the only thing standing between the user and a blank
 * "no pude".
 */
function describeTransportFailure(row: CustomToolRow, cause: string, detail: string): string {
  if (cause === 'unsupported-runtime') {
    return `The tool "${row.name}" cannot run on this surface: ${detail}`;
  }
  if (cause === 'blocked') {
    return `The tool "${row.name}" was not allowed to contact its endpoint: ${detail} Custom tools may only reach public internet addresses — never internal networks or cloud metadata endpoints. An organization admin needs to correct the URL.`;
  }
  if (cause === 'redirect') {
    return `The endpoint behind "${row.name}" answered with a redirect: ${detail}`;
  }
  if (cause === 'timeout') {
    return `The endpoint behind "${row.name}" did not answer within ${Math.round(row.timeout_ms / 1000)} seconds. It is probably slow or down right now; trying again shortly usually works.`;
  }
  return `The endpoint behind "${row.name}" could not be reached: ${detail} That is a problem on the other end (network, DNS or TLS), not with the request itself.`;
}

function describeHttpError(row: CustomToolRow, status: number, body: string): string {
  const excerpt = body.trim().slice(0, 400);
  const tail = excerpt ? ` It replied: ${excerpt}` : '';
  if (status === 401 || status === 403) {
    return `The endpoint behind "${row.name}" rejected the credentials (HTTP ${status}). The stored key is probably expired or lacks permission; an organization admin has to update it in the tool's configuration.${tail}`;
  }
  if (status === 404) {
    return `The endpoint behind "${row.name}" has no record at that address (HTTP 404). Usually that means the value looked up does not exist, or the URL template points somewhere slightly wrong.${tail}`;
  }
  if (status === 429) {
    return `The endpoint behind "${row.name}" is rate limiting us (HTTP 429). Waiting a moment and trying again is the fix.${tail}`;
  }
  if (status >= 500) {
    return `The endpoint behind "${row.name}" failed on its own side (HTTP ${status}). Nothing about the request was wrong; their service is having trouble.${tail}`;
  }
  return `The endpoint behind "${row.name}" refused the request (HTTP ${status}).${tail}`;
}
