import type { ToolContext } from '../types';

/**
 * Apollo.io REST API v1 transport — workspace-wide API key (APOLLO_API_KEY),
 * the same "service account" model as Workable and the HubSpot private app.
 * Per-user attribution stays in our audit_events.
 *
 * Unlike every other client in this package, this one NEVER THROWS. Apollo is
 * a metered third party: a missing key, an exhausted credit balance and a 429
 * are ordinary operating conditions, not bugs. A thrown error would abort the
 * whole Zippy turn and the user would see nothing useful; a soft failure lets
 * each tool return `{ configured, reason }` and lets Zippy say a plain sentence
 * about what happened and what to do next.
 */

export const APOLLO_BASE = 'https://api.apollo.io/api/v1';

/** Soft failure: never thrown, always returned. `reason` is user-facing prose. */
export interface ApolloFailure {
  ok: false;
  configured: boolean;
  reason: string;
}

export type ApolloResult<T> = { ok: true; data: T } | ApolloFailure;

export const NOT_CONFIGURED_REASON =
  'Apollo is not connected yet — this workspace has no Apollo key, so I cannot look anyone up in their contact database. Someone on the ops team needs to add it first.';

/**
 * Apollo takes its filters as repeated query parameters (`person_titles[]=a&
 * person_titles[]=b`) even on the POST endpoints, so params are serialised into
 * the URL rather than a JSON body. `body` exists only for bulk enrichment,
 * whose `details` array genuinely is a JSON body.
 */
export type QueryValue = string | number | boolean | undefined | null | string[];

function toSearchParams(params: Record<string, QueryValue>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item) sp.append(`${key}[]`, item);
    } else {
      sp.append(key, String(value));
    }
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

// Apollo signals an exhausted plan through several shapes depending on the
// endpoint and the plan, so the body is inspected as well as the status code.
const QUOTA_RE = /credit|quota|insufficient|upgrade your plan|limit reached/i;

function describeHttpFailure(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return 'Apollo rejected our key. It has most likely been rotated or lost access — ops needs to refresh it before I can search there again.';
  }
  if (status === 402 || (status < 500 && QUOTA_RE.test(body))) {
    return "Apollo's credit balance for this account is used up, so it will not hand over contact details until someone tops it up.";
  }
  if (status === 429) {
    return 'Apollo is rate-limiting us right now — too many lookups in a short window. Give it a minute and I can try again.';
  }
  if (status === 400 || status === 422) {
    return 'Apollo turned that search down as invalid. It should work with fewer or broader filters.';
  }
  if (status >= 500) {
    return 'Apollo is having trouble on their side and did not answer. That usually clears on its own within a few minutes.';
  }
  return `Apollo could not complete that request (it answered ${status}).`;
}

export async function apolloFetch<T>(
  ctx: ToolContext,
  method: 'GET' | 'POST',
  path: string,
  opts: { params?: Record<string, QueryValue>; body?: unknown } = {},
): Promise<ApolloResult<T>> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return { ok: false, configured: false, reason: NOT_CONFIGURED_REASON };

  const url = `${APOLLO_BASE}${path}${toSearchParams(opts.params ?? {})}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'x-api-key': key,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctx.signal,
    });
  } catch (err) {
    ctx.logger.warn({ err, path }, 'apollo request failed');
    return {
      ok: false,
      configured: true,
      reason:
        'I could not reach Apollo at all just now. It may be a network blip — worth another try in a moment.',
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // The response body can carry the person being looked up, so only the
    // status and the path are logged.
    ctx.logger.warn({ status: res.status, path }, 'apollo returned an error');
    return { ok: false, configured: true, reason: describeHttpFailure(res.status, body) };
  }

  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return {
      ok: false,
      configured: true,
      reason: 'Apollo answered with something I could not read. Worth trying again in a moment.',
    };
  }
}
