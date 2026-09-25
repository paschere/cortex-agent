/** A URL carries tab context; it never grants membership. The session checks that. */
export const WORKSPACE_HEADER = 'x-cortex-workspace';
export const WORKSPACE_QUERY = 'workspace';
const GLOBAL_PATHS = new Set([
  '/overview',
  '/chat/global',
  '/notifications',
  '/api/organizations',
  '/api/organizations/active',
  '/api/chat/global',
  '/api/chat/global/actions',
  '/api/chat/global/realtime',
  '/api/chat/global/attachments',
  '/api/company-groups',
]);

/**
 * Prefijos globales: la consola del fundador (/overview/people,
 * /overview/companies/[id]) actúa sobre varias empresas a la vez y revalida la
 * propiedad de CADA una en el servidor, así que no hereda —ni debe heredar— la
 * empresa de la pestaña. `/api/founder/` queda reservado para sus APIs.
 */
const GLOBAL_PREFIXES = ['/overview/', '/api/founder/'];

export function isGlobalPath(pathname: string): boolean {
  return (
    GLOBAL_PATHS.has(pathname) || GLOBAL_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

export function workspaceHref(workspaceId: string, href: string): string {
  if (!href.startsWith('/') || href.startsWith('//')) throw new Error('Expected an internal path');
  const url = new URL(href, 'https://cortex.invalid');
  if (url.origin !== 'https://cortex.invalid') throw new Error('Expected an internal path');
  url.searchParams.set(WORKSPACE_QUERY, workspaceId);
  url.searchParams.delete('_rsc');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function requestWorkspaceId(headers: Pick<Headers, 'get'>): string | null {
  // Empty or malformed explicit contexts must fail membership resolution, never
  // fall back to another company. Middleware preserves their presence.
  return headers.get(WORKSPACE_HEADER);
}

export function canonicalWorkspaceLocation(
  headers: Pick<Headers, 'get'>,
  workspaceId: string,
): string | null {
  if (headers.get('x-cortex-page') !== '1') return null;
  const path = headers.get('x-cortex-request-path');
  if (!path || !path.startsWith('/') || path.startsWith('//')) return null;
  const url = new URL(path, 'https://cortex.invalid');
  if (isGlobalPath(url.pathname)) return null;
  if (url.searchParams.has(WORKSPACE_QUERY)) return null;
  return workspaceHref(workspaceId, path);
}

/** Explicit URL wins; a same-origin referrer retains context for Next/API requests. */
export function workspaceRequestHeaders(url: URL, input: Headers): Headers {
  const result = new Headers(input);
  const global = isGlobalPath(url.pathname);
  let workspace: string | null = url.searchParams.get(WORKSPACE_QUERY);
  if (workspace === null) workspace = input.get(WORKSPACE_HEADER);
  if (workspace === null) {
    try {
      const referrer = new URL(input.get('referer') ?? '');
      if (referrer.origin === url.origin) workspace = referrer.searchParams.get(WORKSPACE_QUERY);
    } catch {
      /* No usable referrer: resolve the account's default workspace. */
    }
  }
  result.delete(WORKSPACE_HEADER);
  // Global discovery remains reachable after removal from a company. Its own
  // repositories revalidate memberships and never use this default as a grant.
  if (!global && workspace !== null) result.set(WORKSPACE_HEADER, workspace);
  result.set('x-cortex-request-path', `${url.pathname}${url.search}`);
  // Root is the public landing/auth dispatcher, whose optional-session helper
  // catches redirects. It sends authenticated users to the canonical overview.
  const page =
    url.pathname !== '/' &&
    !url.pathname.startsWith('/api/') &&
    !url.pathname.startsWith('/_next/');
  result.set('x-cortex-page', page ? '1' : '0');
  return result;
}
