import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { logger } from '@cortex/core';
import { NextResponse } from 'next/server';

/**
 * The door the WhatsApp bridge comes through.
 *
 * WHY THERE IS A BRIDGE AT ALL. WhatsApp publishes no API for reading a group
 * you are a member of. The only way in is a client that speaks the protocol —
 * `@whiskeysockets/baileys` — which holds an authenticated WebSocket open for
 * as long as it is connected. Vercel cannot do that: a serverless invocation
 * ends, and with it the socket, the session and any hope of receiving anything.
 * So the socket lives in `services/whatsapp` on Railway, and everything it
 * hears it POSTs here. Cortex remains the only thing that touches the database.
 *
 * WHAT AUTHENTICATES IT. One shared secret, `WHATSAPP_BRIDGE_TOKEN`, compared
 * in constant time. Not a signature scheme, because there is no third party
 * here whose key we do not control — both ends are ours, and a symmetric secret
 * over TLS between two services we deploy is the honest shape.
 *
 * WHAT THE TOKEN IS WORTH, STATED PLAINLY. It names the workspace it is acting
 * for in a header, and nothing stops a holder from naming a different one. That
 * is not an oversight to be papered over with a comment: it means the token has
 * the blast radius of operator infrastructure, like `SUPABASE_SERVICE_ROLE_KEY`
 * or `INNGEST_SIGNING_KEY`, and it belongs in exactly one place — the bridge's
 * Railway environment. It is never issued to a customer, never rendered in the
 * UI, and never sent to a browser. A deployment that needs per-workspace
 * bridges gets per-workspace tokens; the shape below (resolve the workspace,
 * then scope everything to it) does not change when it does.
 *
 * WITHOUT THE TOKEN SET, THE SURFACE DOES NOT EXIST. Every bridge route
 * refuses. That is the right default for a feature whose whole job is to
 * receive other people's conversations.
 */

/** Header the bridge names its workspace in. */
export const ORGANIZATION_HEADER = 'x-cortex-organization';

export interface BridgeCaller {
  organizationId: string;
}

export type BridgeAuth = { ok: true; caller: BridgeCaller } | { ok: false; response: NextResponse };

function unauthorized(reason: string): NextResponse {
  // The reason goes to the log, never to the caller: an unauthenticated client
  // learns "no" and nothing about why.
  logger.warn(`whatsapp-bridge: rejected a request — ${reason}`);
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * Constant-time equality for two secrets of unrelated length.
 *
 * `timingSafeEqual` throws on a length mismatch, and returning early on that
 * throw leaks the length of the expected token. Hashing both sides first makes
 * every comparison the same 32 bytes, so the only thing measurable is that a
 * comparison happened.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Authenticate a request from the bridge and work out which workspace it is
 * acting for. Every bridge route starts with this and nothing else.
 */
export function authenticateBridge(req: Request): BridgeAuth {
  const expected = process.env.WHATSAPP_BRIDGE_TOKEN ?? '';
  if (!expected) {
    return { ok: false, response: unauthorized('WHATSAPP_BRIDGE_TOKEN is not set') };
  }

  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented || !secretsMatch(presented, expected)) {
    return { ok: false, response: unauthorized('bad or missing bearer token') };
  }

  const organizationId = req.headers.get(ORGANIZATION_HEADER)?.trim() ?? '';
  if (!organizationId) {
    return { ok: false, response: unauthorized(`missing ${ORGANIZATION_HEADER}`) };
  }

  return { ok: true, caller: { organizationId } };
}

/** Base64 back to bytes, refusing anything that is not base64. */
export function decodeBase64(value: string, limitBytes: number): Uint8Array | null {
  try {
    const buffer = Buffer.from(value, 'base64');
    if (buffer.byteLength === 0 || buffer.byteLength > limitBytes) return null;
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}
