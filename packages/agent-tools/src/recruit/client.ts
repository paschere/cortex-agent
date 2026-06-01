const BASE = () => process.env.ZIPDEV_MATCHER_URL ?? 'http://localhost:3100';

export async function matcherFetch(path: string, init?: RequestInit): Promise<any> {
  const token = process.env.ZIPDEV_MATCHER_TOKEN;
  const res = await fetch(BASE() + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('zipdev-matcher ' + res.status + ' ' + path + ': ' + body.slice(0, 300));
  }
  return res.json();
}
