import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { middleware } from '../middleware';

const origin = 'https://app.test';
function request(path: string, extra: Record<string, string> = {}, method = 'GET') {
  return new NextRequest(`${origin}${path}`, {
    method,
    headers: {
      cookie: 'better-auth.session_token=test',
      referer: `${origin}/chat?workspace=company-a`,
      ...extra,
    },
  });
}
afterEach(() => vi.unstubAllGlobals());
describe('workspace navigation before rendering', () => {
  it('redirects Flight navigation before rendering the new layout', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const response = await middleware(request('/management?_rsc=old', { rsc: '1' }));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${origin}/management?workspace=company-a`);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves destination filters when pinning a normal navigation', async () => {
    const response = await middleware(request('/settings?tab=email'));
    expect(response.headers.get('location')).toBe(
      `${origin}/settings?tab=email&workspace=company-a`,
    );
  });
  it('does not loop, change explicit workspace, or redirect global and API requests', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ user: { id: 'u' } }) }),
    );
    for (const path of [
      '/management?workspace=company-b',
      '/management?workspace=',
      '/overview',
      '/chat/global',
      '/api/chat',
    ]) {
      const response = await middleware(request(path));
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('x-middleware-next')).toBe('1');
    }
  });
  it('does not redirect mutations or invent workspace from a foreign referrer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ user: { id: 'u' } }) }),
    );
    expect(
      (await middleware(request('/management', {}, 'POST'))).headers.get('location'),
    ).toBeNull();
    expect(
      (
        await middleware(request('/settings', { referer: 'https://evil.test/?workspace=other' }))
      ).headers.get('location'),
    ).toBeNull();
  });
  it('keeps signed-out navigation on the login path', async () => {
    const response = await middleware(request('/management', { cookie: '' }));
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/login');
  });
});
