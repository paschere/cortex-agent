import { IntegrationError } from '@cortex/core';
import type { ToolContext } from '../types';

/**
 * The one door to Microsoft Graph.
 *
 * `gmail/client.ts` and `gcal/client.ts` are two files because Google puts mail
 * and calendar on two different hosts. Microsoft puts everything behind one
 * host and one token, so mail and calendar share this module and the `outlook.*`
 * / `mscal.*` families are thin layers over it — the same shape as their Google
 * counterparts, one fewer copy of the fetch.
 *
 * EVERYTHING HERE IS DELEGATED. `/me` is not a convenience, it is the security
 * posture: every call is made with a token one specific person granted for
 * their own mailbox, and the URL cannot address anybody else's. There is no
 * `/users/{id}` in this file and there should never be one — see
 * docs/operations/microsoft.md.
 */

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * The delegated permissions Cortex asks for, and nothing more.
 *
 * Stored SHORT (`Mail.Read`), never resource-qualified. Microsoft hands scopes
 * back from the token endpoint as full URIs — `https://graph.microsoft.com/Mail.Read`
 * — and `openid`/`profile`/`offline_access` come back unqualified in the same
 * string. If both spellings were allowed to reach the `integrations.scopes`
 * column, `hasScopes` would compare `Mail.Read` against
 * `https://graph.microsoft.com/Mail.Read` and refuse a tool the user has in
 * fact authorised. `normalizeGraphScopes` is what stops that, and it runs on
 * BOTH write paths (the callback and the refresher).
 */
export const GRAPH_SCOPES = {
  /** Read the signed-in user's own mailbox. Search, list, read a thread. */
  MAIL_READ: 'Mail.Read',
  /** Create and update drafts in the signed-in user's own mailbox. */
  MAIL_READ_WRITE: 'Mail.ReadWrite',
  /** Send a message the user already approved. Separate from creating it. */
  MAIL_SEND: 'Mail.Send',
  /** Read the signed-in user's own calendar. */
  CALENDARS_READ: 'Calendars.Read',
  /** Create events on the signed-in user's own calendar. */
  CALENDARS_READ_WRITE: 'Calendars.ReadWrite',
} as const;

/** Scopes that are part of the handshake rather than a capability. */
export const GRAPH_PROTOCOL_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const;

/**
 * Turn whatever Microsoft returned into the short names stored on the row.
 *
 * Idempotent: a short name passes through untouched, so the callback and the
 * refresher can both run it over a mixed list without producing duplicates.
 */
export function normalizeGraphScopes(scope: string | null | undefined): string[] {
  if (!scope) return [];
  const out = new Set<string>();
  for (const raw of scope.split(/\s+/)) {
    const s = raw.trim();
    if (!s) continue;
    // "https://graph.microsoft.com/Mail.Read" → "Mail.Read".
    const slash = s.lastIndexOf('/');
    out.add(slash === -1 ? s : s.slice(slash + 1));
  }
  return [...out];
}

/**
 * The tenant segment of every Microsoft OAuth URL.
 *
 * `common` — the default — means "any work or school account". A customer that
 * wants Cortex usable only from its own directory sets MICROSOFT_TENANT_ID to
 * its tenant GUID, and Microsoft then refuses an outside account at sign-in,
 * which is a much better place to refuse it than inside our code.
 */
export function microsoftTenant(): string {
  return process.env.MICROSOFT_TENANT_ID?.trim() || 'common';
}

export function microsoftAuthorizeUrl(): string {
  return `https://login.microsoftonline.com/${microsoftTenant()}/oauth2/v2.0/authorize`;
}

export function microsoftTokenUrl(): string {
  return `https://login.microsoftonline.com/${microsoftTenant()}/oauth2/v2.0/token`;
}

/**
 * What a person should DO about a Graph failure.
 *
 * "Microsoft Graph 401" tells a warehouse lead nothing and tells the model even
 * less — it will apologise and try the same call again. Every branch below ends
 * in an instruction, because the four things that actually go wrong here have
 * four different fixes and only one of them is "try later":
 *
 *   401  the grant is gone (password change, admin revoke, MFA policy) →
 *        reconnect the account. Retrying is pointless.
 *   403  the token is valid but this permission was never consented →
 *        somebody has to approve it; naming the permission is the whole point.
 *   429  throttled → Graph says how long in Retry-After, so we say it too.
 *   5xx  Microsoft is having a moment → this one really is "try later".
 */
export function explainGraphFailure(
  status: number,
  body: string,
  retryAfter: string | null,
): string {
  const detail = graphErrorMessage(body);
  if (status === 401) {
    return `Microsoft rejected the saved credentials for this account. That happens when the password changed, an administrator revoked the app, or a conditional-access policy now requires a fresh sign-in. Reconnect Microsoft 365 from the Integrations screen; nothing else will fix it.${detail ? ` Microsoft said: ${detail}` : ''}`;
  }
  if (status === 403) {
    return `Microsoft accepted the account but refused this operation: the permission behind it was never consented to. Ask an administrator to approve Cortex's delegated permissions (docs/operations/microsoft.md lists them), then reconnect.${detail ? ` Microsoft said: ${detail}` : ''}`;
  }
  if (status === 404) {
    return `Microsoft has no such item in this mailbox — it was moved, deleted, or belongs to somebody else's account.${detail ? ` Microsoft said: ${detail}` : ''}`;
  }
  if (status === 429) {
    return `Microsoft is throttling this mailbox. Wait ${retryAfter ? `${retryAfter} seconds` : 'a minute'} and run it again; nothing is broken and nothing was lost.`;
  }
  if (status >= 500) {
    return `Microsoft Graph is failing on its own side (${status}). Nothing to fix here — run it again in a few minutes.`;
  }
  return `Microsoft Graph refused the request (${status}).${detail ? ` ${detail}` : ''}`;
}

/** Graph wraps its real message in `{ error: { code, message } }`. */
function graphErrorMessage(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
    const message = parsed.error?.message?.trim();
    const code = parsed.error?.code?.trim();
    if (message && code) return `${code} — ${message}`;
    return message || code || '';
  } catch {
    return body.slice(0, 300);
  }
}

export interface GraphFetchOptions extends RequestInit {
  /**
   * Extra `Prefer` values. Mail read paths ask for
   * `outlook.body-content-type="text"` so Graph returns plain text instead of
   * the HTML soup Outlook stores, which is the same thing Gmail's reader does
   * by walking to the text/plain part.
   */
  prefer?: string[];
}

/**
 * One Graph call, with the token, the error contract and the empty-body case
 * handled once.
 *
 * `POST /me/messages/{id}/send` answers 204 with no body, so `r.json()` would
 * throw on the one call whose success matters most. Hence the explicit
 * empty-body branch rather than an unconditional parse.
 */
export async function graphFetch<T>(
  ctx: Pick<ToolContext, 'integrations' | 'signal'>,
  path: string,
  init: GraphFetchOptions = {},
): Promise<T> {
  const { prefer, ...rest } = init;
  const { token } = await ctx.integrations.getAccessToken('microsoft');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...((rest.headers as Record<string, string> | undefined) ?? {}),
  };
  if (prefer && prefer.length > 0) headers.Prefer = prefer.join(', ');

  const r = await fetch(`${GRAPH_BASE}${path}`, {
    ...rest,
    headers,
    signal: ctx.signal,
  });

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new IntegrationError(
      explainGraphFailure(r.status, body, r.headers.get('retry-after')),
      'microsoft',
    );
  }

  if (r.status === 204) return undefined as T;
  const text = await r.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Shapes shared by the mail tools
// ---------------------------------------------------------------------------

export interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

export interface GraphMessage {
  id: string;
  /** Si trae algo colgando. Es lo que evita una llamada por mensaje (0124). */
  hasAttachments?: boolean;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string | null;
  bodyPreview?: string | null;
  body?: { contentType?: string; content?: string };
  receivedDateTime?: string;
  sentDateTime?: string;
  webLink?: string;
  isDraft?: boolean;
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
}

/** `"Ana Ruiz <ana@acme.com>"`, or just the address, or null. */
export function formatRecipient(r: GraphRecipient | undefined | null): string | null {
  const address = r?.emailAddress?.address?.trim();
  const name = r?.emailAddress?.name?.trim();
  if (!address) return name || null;
  return name && name.toLowerCase() !== address.toLowerCase() ? `${name} <${address}>` : address;
}

export function formatRecipients(list: GraphRecipient[] | undefined | null): string | null {
  const parts = (list ?? []).map(formatRecipient).filter((v): v is string => Boolean(v));
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Bare addresses, lowercased — what domain matching and the internal test need. */
export function addressesOf(
  ...lists: Array<GraphRecipient[] | GraphRecipient | undefined>
): string[] {
  const out: string[] = [];
  for (const entry of lists) {
    if (!entry) continue;
    for (const r of Array.isArray(entry) ? entry : [entry]) {
      const a = r?.emailAddress?.address?.trim().toLowerCase();
      if (a) out.push(a);
    }
  }
  return out;
}

/** Graph escapes single quotes in OData string literals by doubling them. */
export function odataQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * KQL string for `$search`. Graph rejects an unbalanced double quote outright,
 * so the quotes a person typed are stripped rather than passed through.
 */
export function searchTerm(value: string): string {
  return value.replace(/"/g, ' ').trim();
}

/** The `$select` every mail read uses. Narrow on purpose: less over the wire. */
export const MESSAGE_SELECT =
  'id,conversationId,internetMessageId,subject,bodyPreview,receivedDateTime,sentDateTime,webLink,isDraft,hasAttachments,from,toRecipients,ccRecipients';
