import { IntegrationError } from '@cortex/core';

/**
 * Workable SPI v3 client — workspace-wide service token (WORKABLE_API_TOKEN),
 * same "service account" model as the HubSpot private app. Per-user
 * attribution stays in our audit_events.
 */
const SUBDOMAIN = () => process.env.WORKABLE_SUBDOMAIN?.trim() ?? '';

export async function workableFetch<T>(
  path: string,
  init?: RequestInit & { signal?: AbortSignal },
): Promise<T> {
  const token = process.env.WORKABLE_API_TOKEN;
  if (!token) {
    throw new IntegrationError('WORKABLE_API_TOKEN not configured', 'workable');
  }
  // The account is per-deployment, so there is nothing to fall back to: without
  // it every request would go to a host that is not anybody's Workable.
  const subdomain = SUBDOMAIN();
  if (!subdomain) {
    throw new IntegrationError('WORKABLE_SUBDOMAIN not configured', 'workable');
  }
  const res = await fetch(`https://${subdomain}.workable.com/spi/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new IntegrationError(`Workable ${res.status} ${path}: ${body.slice(0, 300)}`, 'workable');
  }
  // 204 No Content on some writes
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}
