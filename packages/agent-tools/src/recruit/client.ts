export const BASE = () =>
  process.env.Cortex_MATCHER_URL ?? "http://localhost:3100";

const RETRIES = 2;
const BACKOFF_MS = [600, 1800];

function authHeaders(): Record<string, string> {
  const token = process.env.Cortex_MATCHER_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Fetch against Cortex-matcher with small retries: its /api/jobs proxies a
 * separate backend service that cold-starts (first hit after idle returns
 * 502), and unattended scheduled runs hit exactly that window. Two retries
 * with backoff ride out the wake-up instead of failing the whole job.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function matcherFetch(
  path: string,
  init?: RequestInit,
): Promise<any> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1] ?? 2000));
    }
    try {
      const res = await fetch(BASE() + path, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
          ...(init?.headers ?? {}),
        },
      });
      if (res.ok) return res.json();

      const body = await res.text().catch(() => "");
      lastError = new Error(
        `Cortex-matcher ${res.status} ${path}: ${body.slice(0, 300)}`,
      );
      // Retry only transient upstream failures; 4xx are real answers.
      if (res.status < 500) throw lastError;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Network-level failures (ECONNREFUSED, DNS, abort) fall through to retry;
      // deliberate throws for 4xx above also land here — rethrow those now.
      if (
        lastError.message.includes("Cortex-matcher") &&
        !/Cortex-matcher 5\d\d/.test(lastError.message)
      ) {
        throw lastError;
      }
    }
  }
  throw lastError ?? new Error("Cortex-matcher request failed");
}

/**
 * Result of calling one of the matcher's lean `/api/internal/recruit/*`
 * endpoints. Those endpoints are service-token gated and may not be deployed
 * on every environment yet, so callers get an explicit "not available here"
 * instead of an exception, and fall back to the older public endpoints.
 */
export type InternalResult<T> =
  | { available: true; data: T }
  | { available: false; reason: string };

/**
 * GET a lean internal endpoint.
 *
 * Unavailable (→ caller falls back) means: no/rejected service token
 * (401/403), the route isn't deployed (404 answered with Next's HTML page
 * rather than JSON), or the endpoint kept failing after retries. A JSON 404 is
 * a REAL answer ("job not found") and is thrown, never swallowed — falling
 * back there would quietly turn "this requisition doesn't exist" into a slow,
 * wrong success.
 */
export async function internalFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<InternalResult<T>> {
  let lastReason = "unknown error";

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0)
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1] ?? 2000));
    let res: Response;
    try {
      res = await fetch(BASE() + path, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
          ...(init?.headers ?? {}),
        },
      });
    } catch (err) {
      lastReason = `network error: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }

    if (res.ok) return { available: true, data: (await res.json()) as T };

    const body = await res.text().catch(() => "");
    const isJson = body.trimStart().startsWith("{");

    if (res.status === 401 || res.status === 403) {
      return {
        available: false,
        reason: "Cortex_MATCHER_TOKEN is not set, or the matcher rejected it",
      };
    }
    if (res.status === 404 && !isJson) {
      return {
        available: false,
        reason: "lean internal endpoint is not deployed on this matcher",
      };
    }
    if (res.status < 500) {
      throw new Error(
        `Cortex-matcher ${res.status} ${path}: ${body.slice(0, 300)}`,
      );
    }
    lastReason = `matcher ${res.status}: ${body.slice(0, 200)}`;
  }

  return { available: false, reason: lastReason };
}

/** Build a query string, dropping undefined/null/empty values. */
export function qs(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
