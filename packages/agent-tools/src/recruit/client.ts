const BASE = () => process.env.ZIPDEV_MATCHER_URL ?? 'http://localhost:3100';

const RETRIES = 2;
const BACKOFF_MS = [600, 1800];

/**
 * Fetch against zipdev-matcher with small retries: its /api/jobs proxies a
 * separate backend service that cold-starts (first hit after idle returns
 * 502), and unattended scheduled runs hit exactly that window. Two retries
 * with backoff ride out the wake-up instead of failing the whole job.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function matcherFetch(path: string, init?: RequestInit): Promise<any> {
  const token = process.env.ZIPDEV_MATCHER_TOKEN;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1] ?? 2000));
    }
    try {
      const res = await fetch(BASE() + path, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(init?.headers ?? {}),
        },
      });
      if (res.ok) return res.json();

      const body = await res.text().catch(() => '');
      lastError = new Error('zipdev-matcher ' + res.status + ' ' + path + ': ' + body.slice(0, 300));
      // Retry only transient upstream failures; 4xx are real answers.
      if (res.status < 500) throw lastError;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Network-level failures (ECONNREFUSED, DNS, abort) fall through to retry;
      // deliberate throws for 4xx above also land here — rethrow those now.
      if (lastError.message.includes('zipdev-matcher') && !/zipdev-matcher 5\d\d/.test(lastError.message)) {
        throw lastError;
      }
    }
  }
  throw lastError ?? new Error('zipdev-matcher request failed');
}
