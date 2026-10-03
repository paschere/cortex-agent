import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getOrgScopedClient } from '@/lib/supabase/service';
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
/** `single` (WHATSAPP_ORGANIZATION_ID set) or `multi`. Absent: a pre-0189 bridge. */
export const MODE_HEADER = 'x-cortex-bridge-mode';
/** The bridge process, for the per-workspace lease (0189). */
export const INSTANCE_HEADER = 'x-cortex-bridge-instance';

export type BridgeMode = 'single' | 'multi';

export interface BridgeCaller {
  organizationId: string;
  /**
   * `legacy` is a bridge from before 0189 that sends no mode: it is a
   * single-workspace bridge by construction and is treated as one.
   */
  mode: BridgeMode | 'legacy';
  instanceId: string | null;
}

const INSTANCE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

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

function tokenProblem(req: Request): string | null {
  const expected = process.env.WHATSAPP_BRIDGE_TOKEN ?? '';
  if (!expected) return 'WHATSAPP_BRIDGE_TOKEN is not set';
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented || !secretsMatch(presented, expected)) return 'bad or missing bearer token';
  return null;
}

function modeOf(req: Request): BridgeMode | 'legacy' {
  const mode = req.headers.get(MODE_HEADER)?.trim();
  return mode === 'single' || mode === 'multi' ? mode : 'legacy';
}

function instanceOf(req: Request): string | null {
  const id = req.headers.get(INSTANCE_HEADER)?.trim() ?? '';
  return INSTANCE_ID.test(id) ? id : null;
}

/**
 * Authenticate a request from the bridge and work out which workspace it is
 * acting for. The token and the header only — see `authorizeBridgeSession` for
 * the check every per-workspace route actually starts with.
 */
export function authenticateBridge(req: Request): BridgeAuth {
  const problem = tokenProblem(req);
  if (problem) return { ok: false, response: unauthorized(problem) };

  const organizationId = req.headers.get(ORGANIZATION_HEADER)?.trim() ?? '';
  if (!organizationId) {
    return { ok: false, response: unauthorized(`missing ${ORGANIZATION_HEADER}`) };
  }

  return { ok: true, caller: { organizationId, mode: modeOf(req), instanceId: instanceOf(req) } };
}

/**
 * The process-level door (0189): `/api/whatsapp/bridge/sessions`, which is
 * about every workspace and so names none. Token, mode and instance id only.
 */
export function authenticateBridgeControl(
  req: Request,
):
  | { ok: true; caller: { mode: BridgeMode; instanceId: string } }
  | { ok: false; response: NextResponse } {
  const problem = tokenProblem(req);
  if (problem) return { ok: false, response: unauthorized(problem) };
  const mode = modeOf(req);
  const instanceId = instanceOf(req);
  if (mode === 'legacy' || !instanceId) {
    return { ok: false, response: unauthorized('a control request without mode or instance') };
  }
  return { ok: true, caller: { mode, instanceId } };
}

/**
 * EVERY PER-WORKSPACE BRIDGE ROUTE STARTS HERE (0189).
 *
 * One process now serves many workspaces, so "the token is right" is no longer
 * enough on its own: a multi-mode bridge only ever has a socket for a workspace
 * that has a `whatsapp_sessions` row — created when an admin of THAT workspace
 * asked to pair — and that row's lease, when held, names this process. A
 * request for a workspace with no row, or one leased to another process, is a
 * bug or a split brain, and it is refused before it can write a credential or
 * archive a message.
 *
 * What this is NOT: protection against somebody holding the token. The token
 * is operator infrastructure (see the top of this file) and can name any
 * workspace; single and legacy bridges, which are pinned by the operator's own
 * environment variable and create their row on first report, skip the row
 * check exactly as before. The check is defence in depth for the multi path.
 */
export async function authorizeBridgeSession(req: Request): Promise<BridgeAuth> {
  const auth = authenticateBridge(req);
  if (!auth.ok || auth.caller.mode !== 'multi') return auth;

  const row = await getOrgScopedClient(auth.caller.organizationId)
    .from('whatsapp_sessions')
    .select('organization_id, owner_instance, lease_expires_at')
    .maybeSingle();
  if (row.error) {
    logger.error(`whatsapp-bridge: could not read the session row — ${row.error.message}`);
    return {
      ok: false,
      response: NextResponse.json({ error: 'Session lookup failed' }, { status: 503 }),
    };
  }
  if (!row.data) {
    logger.warn('whatsapp-bridge: refused a request for a workspace with no session row');
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'No WhatsApp session for this workspace' },
        { status: 404 },
      ),
    };
  }
  if (!leaseAllows(row.data, auth.caller.instanceId)) {
    logger.warn('whatsapp-bridge: refused a request from a process that does not hold the lease');
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'This workspace is held by another bridge process' },
        { status: 409 },
      ),
    };
  }
  return auth;
}

/**
 * Whether `instanceId` may act for a session row: nobody holds it, it holds
 * it, or the holder's lease has run out. Pure, for the tests.
 */
export function leaseAllows(
  row: { owner_instance?: unknown; lease_expires_at?: unknown },
  instanceId: string | null,
  now: Date = new Date(),
): boolean {
  const owner = typeof row.owner_instance === 'string' ? row.owner_instance : null;
  if (!owner) return true;
  if (instanceId && owner === instanceId) return true;
  const expires =
    typeof row.lease_expires_at === 'string' ? Date.parse(row.lease_expires_at) : Number.NaN;
  return !Number.isFinite(expires) || expires <= now.getTime();
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
