import { describe, expect, it } from 'vitest';
import {
  canonicalWorkspaceLocation,
  requestWorkspaceId,
  workspaceHref,
  workspaceRequestHeaders,
} from './workspace-context';

describe('workspace request context', () => {
  it('lets a revoked tab return to global discovery without inheriting its rejected company', () => {
    const input = new Headers({ referer: 'https://app.test/chat?workspace=removed' });
    for (const path of ['/overview', '/api/organizations', '/chat/global']) {
      const headers = workspaceRequestHeaders(new URL(path, 'https://app.test'), input);
      expect(requestWorkspaceId(headers)).toBeNull();
      expect(canonicalWorkspaceLocation(headers, 'personal')).toBeNull();
    }
  });
  it('keeps two tabs pinned despite a different account default', () => {
    for (const id of ['company-a', 'company-b']) {
      const headers = workspaceRequestHeaders(
        new URL('https://app.test/api/chat'),
        new Headers({ referer: `https://app.test/chat?workspace=${id}` }),
      );
      expect(requestWorkspaceId(headers)).toBe(id);
      expect(canonicalWorkspaceLocation(headers, id)).toBeNull();
    }
  });
  it('does not infer a company from an external referrer', () => {
    expect(
      requestWorkspaceId(
        workspaceRequestHeaders(
          new URL('https://app.test/api/chat'),
          new Headers({ referer: 'https://evil.test/?workspace=other' }),
        ),
      ),
    ).toBeNull();
  });
  it('explicit selection wins over old tab context, including invalid empty selection', () => {
    const headers = new Headers({
      'x-cortex-workspace': 'old',
      referer: 'https://app.test/chat?workspace=old',
    });
    expect(
      requestWorkspaceId(
        workspaceRequestHeaders(new URL('https://app.test/chat?workspace=new'), headers),
      ),
    ).toBe('new');
    expect(
      requestWorkspaceId(
        workspaceRequestHeaders(new URL('https://app.test/chat?workspace='), headers),
      ),
    ).toBe('');
  });
  it('pins server navigations without losing their query or anchor', () => {
    expect(workspaceHref('a&b', '/chat?prompt=hola#last')).toBe(
      '/chat?prompt=hola&workspace=a%26b#last',
    );
    const headers = workspaceRequestHeaders(
      new URL('https://app.test/settings?_rsc=cache'),
      new Headers(),
    );
    expect(canonicalWorkspaceLocation(headers, 'a')).toBe('/settings?workspace=a');
  });
  it('does not redirect already pinned pages or public root', () => {
    for (const path of ['/', '/chat?workspace=a']) {
      const headers = workspaceRequestHeaders(new URL(path, 'https://app.test'), new Headers());
      expect(canonicalWorkspaceLocation(headers, 'a')).toBeNull();
    }
  });
  it('rejects external and protocol-relative notification destinations', () => {
    for (const path of ['https://evil.test', '//evil.test', '/\\evil.test'])
      expect(() => workspaceHref('a', path)).toThrow();
  });
});
