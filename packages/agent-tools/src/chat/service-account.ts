import { createSign } from 'node:crypto';
import { logger } from '@zipdev/core';
import { CHAT_TEXT_LIMIT } from './webhook';

/**
 * Outbound Google Chat as the ZIPPY CHAT APP — service-account credentials, no
 * webhook anywhere.
 *
 * Two Google Chat paths exist side by side and must not be confused:
 *
 *  - `./webhook.ts` + `./send-message.ts` (`chat.send_message`) post through an
 *    INCOMING WEBHOOK the person pastes into a space they own. One space, no
 *    app install, no admin approval.
 *  - THIS file posts as the Chat app itself, authenticated with a service
 *    account (`GOOGLE_CHAT_SERVICE_ACCOUNT_JSON`, scope `chat.bot`). It can DM
 *    anyone who has ever messaged the app — see `./send-dm.ts`.
 *
 * ── DELIBERATE DUPLICATION ────────────────────────────────────────────────
 * `apps/web/lib/google-chat.ts` is this module's web-side twin: same JWT →
 * token → POST flow, same fail-soft contract. It is NOT imported here and this
 * is NOT imported there, because `packages/**` must never depend on
 * `apps/web/**` (the tools package is consumed by the MCP server and the
 * scheduler, neither of which has a Next.js runtime). The web twin additionally
 * owns the INBOUND side (`/api/chat-app/google`) and its own Supabase client;
 * this copy takes the caller's `ToolContext.db` instead. Keep the two in sync
 * when the auth flow or Chat's limits change.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Everything here FAILS SOFT. A Chat outage must never break a digest run, a
 * schedule or a chat turn: callers get `{ sent: false, reason }`, never a throw.
 *
 * Env:
 *   GOOGLE_CHAT_SERVICE_ACCOUNT_JSON  service-account key, raw JSON or base64
 *   APP_BASE_URL                      link used by the truncation tail
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CHAT_API_BASE = 'https://chat.googleapis.com/v1';
const CHAT_BOT_SCOPE = 'https://www.googleapis.com/auth/chat.bot';

export interface ChatAppSendResult {
  sent: boolean;
  /** Short, machine-ish reason when `sent` is false. Safe to log and to show. */
  reason?: string;
  /** `spaces/X/messages/Y` when the post succeeded. */
  messageName?: string;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

/**
 * Accepts the raw service-account JSON or a base64 blob of it. Hosting envs
 * mangle multi-line PEMs, so both spellings have to work.
 */
function decodeServiceAccount(raw: string): ServiceAccountKey | null {
  const trimmed = raw.trim();
  let json = trimmed;
  if (!trimmed.startsWith('{')) {
    try {
      json = Buffer.from(trimmed, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  try {
    const parsed = JSON.parse(json) as Partial<ServiceAccountKey>;
    if (!parsed.client_email || !parsed.private_key) return null;
    return {
      client_email: parsed.client_email,
      // Env values commonly carry the PEM with literal "\n" sequences.
      private_key: parsed.private_key.replace(/\\n/g, '\n'),
      ...(parsed.private_key_id ? { private_key_id: parsed.private_key_id } : {}),
    };
  } catch {
    return null;
  }
}

// `undefined` = not read yet, `null` = read and unavailable.
let serviceAccountCache: ServiceAccountKey | null | undefined;

function serviceAccount(): ServiceAccountKey | null {
  if (serviceAccountCache !== undefined) return serviceAccountCache;
  const raw = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON;
  serviceAccountCache = raw ? decodeServiceAccount(raw) : null;
  if (raw && !serviceAccountCache) {
    logger.error('chat-app: GOOGLE_CHAT_SERVICE_ACCOUNT_JSON is set but unparseable');
  }
  return serviceAccountCache;
}

/** True when the Chat app has credentials to post proactively. No network. */
export function isChatAppConfigured(): boolean {
  return serviceAccount() !== null;
}

/** Drop the credential and token caches. Tests only. */
export function resetChatAppCredentials(): void {
  serviceAccountCache = undefined;
  tokenCache = null;
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

// Access tokens live an hour; cache and refresh a minute early.
let tokenCache: { token: string; expiresAt: number } | null = null;

/**
 * Self-signed JWT → OAuth2 access token (the two-legged service-account flow).
 * No user consent involved: the Chat app's own identity is what posts.
 */
async function getAccessToken(signal?: AbortSignal): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const key = serviceAccount();
  if (!key) return null;

  const now = Math.floor(Date.now() / 1000);
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (key.private_key_id) header.kid = key.private_key_id;
  const claims = {
    iss: key.client_email,
    scope: CHAT_BOT_SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  };

  let assertion: string;
  try {
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    assertion = `${signingInput}.${signer.sign(key.private_key, 'base64url')}`;
  } catch (err) {
    logger.error('chat-app: could not sign the service-account assertion', {
      error: (err as Error).message,
    });
    return null;
  }

  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error('chat-app: token exchange failed', {
        status: res.status,
        body: body.slice(0, 300),
      });
      return null;
    }
    const parsed = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) return null;
    tokenCache = {
      token: parsed.access_token,
      expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    };
    return tokenCache.token;
  } catch (err) {
    logger.error('chat-app: token exchange threw', { error: (err as Error).message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Accepts `spaces/AAAA` or a bare `AAAA`; rejects anything else. */
export function normalizeChatSpace(space: string): string | null {
  const trimmed = (space ?? '').trim().replace(/^\/+/, '');
  if (!trimmed) return null;
  const name = trimmed.startsWith('spaces/') ? trimmed : `spaces/${trimmed}`;
  return /^spaces\/[A-Za-z0-9_-]+$/.test(name) ? name : null;
}

/**
 * Trim to Chat's ceiling on a line boundary and say where the rest lives,
 * instead of swallowing the tail silently. A digest routinely exceeds 4096
 * characters, and a message that just stops mid-sentence reads like a bug.
 */
export function capForChat(text: string, limit = CHAT_TEXT_LIMIT, moreUrl?: string): string {
  if (text.length <= limit) return text;
  const base = (moreUrl ?? process.env.APP_BASE_URL ?? '').replace(/\/+$/, '');
  const tail = base
    ? `\n…\n<${base}|See the full report in Zipdev OS>`
    : '\n…\n(See the full report in Zipdev OS.)';
  const room = Math.max(0, limit - tail.length);
  const cut = text.slice(0, room);
  const lastBreak = cut.lastIndexOf('\n');
  return `${(lastBreak > room * 0.5 ? cut.slice(0, lastBreak) : cut).trimEnd()}${tail}`;
}

/**
 * Post into a space as the Chat app.
 *
 * `threadKey` is an arbitrary string of ours used to group related proactive
 * messages (all of one person's digests in one thread, say). It rides with
 * REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD so a stale thread never drops the
 * message on the floor.
 */
export async function postChatAppMessage(opts: {
  space: string;
  text: string;
  threadKey?: string;
  signal?: AbortSignal;
}): Promise<ChatAppSendResult> {
  const text = opts.text?.trim() ?? '';
  if (!text) return { sent: false, reason: 'empty message' };

  const space = normalizeChatSpace(opts.space ?? '');
  if (!space) return { sent: false, reason: 'invalid space' };

  if (!isChatAppConfigured()) return { sent: false, reason: 'chat app not configured' };

  const token = await getAccessToken(opts.signal);
  if (!token) return { sent: false, reason: 'chat app not configured' };

  const url = new URL(`${CHAT_API_BASE}/${space}/messages`);
  const body: Record<string, unknown> = { text: text.slice(0, CHAT_TEXT_LIMIT) };
  if (opts.threadKey) {
    body.thread = { threadKey: opts.threadKey };
    url.searchParams.set('threadKey', opts.threadKey);
    url.searchParams.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
  }

  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.error('chat-app: message post failed', {
        space,
        status: res.status,
        body: errBody.slice(0, 300),
      });
      return { sent: false, reason: `chat ${res.status}` };
    }
    const created = (await res.json().catch(() => ({}))) as { name?: string };
    return created.name ? { sent: true, messageName: created.name } : { sent: true };
  } catch (err) {
    logger.error('chat-app: message post threw', { space, error: (err as Error).message });
    return { sent: false, reason: 'network error' };
  }
}
