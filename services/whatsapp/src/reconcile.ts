/**
 * Which WhatsApp sockets this process should hold, as pure functions.
 *
 * ── THE SHAPE ───────────────────────────────────────────────────────────────
 *
 * One process, many workspaces, one socket per workspace that needs one.
 * Cortex is the source of truth for "needs one": a workspace whose stored
 * session is paired (it has to stay connected to receive anything), or one
 * where an admin is pairing right now. Everybody else — never linked, a
 * request that lapsed, unlinked — gets NO socket. That keeps the rule this
 * service was built on: an unpaired number does not talk to WhatsApp unless a
 * person is standing there with the phone.
 *
 * Every `reconcileMs` the manager asks Cortex for that list. Cortex answers
 * with the workspaces it has LEASED to this process (migration 0189): a claim
 * with an expiry, renewed by that same call. Two processes never get the same
 * workspace while a lease is alive, so a deploy that overlaps the old container
 * with the new one does not put two clients on one WhatsApp session — which
 * WhatsApp punishes by dropping both.
 *
 * ── LOSING CORTEX ───────────────────────────────────────────────────────────
 *
 * If Cortex cannot be reached the sockets stay up — dropping every number
 * because Vercel hiccuped would be far worse than the hiccup — but only while
 * the last lease is still certainly alive. Past that, another process may
 * already hold those workspaces, so this one lets go of everything and waits.
 * Single mode never lets go: it is the pre-0189 behaviour, one number pinned
 * by an environment variable, and nobody else is supposed to be serving it.
 */

/** One workspace Cortex wants a socket for, in priority order. */
export interface DesiredSession {
  organizationId: string;
  /** The stored session is a device WhatsApp accepted. */
  paired: boolean;
  /** An admin is pairing right now. */
  pairingRequested: boolean;
}

/** What `/api/whatsapp/bridge/sessions` answers to a claim. */
export interface ClaimReply {
  /** The workspaces leased to this process, highest priority first. */
  sessions: DesiredSession[];
  /** Wanted somewhere but not given to this process (leased elsewhere, or over the cap). */
  waiting?: number;
  leaseMs?: number;
}

export interface ReconcilePlan {
  start: string[];
  stop: string[];
}

/**
 * Desired versus running → what to start and what to stop.
 *
 * - Anything running that Cortex no longer lists is stopped — unless it is
 *   `protected` (started moments ago: a pairing that just succeeded may not
 *   have its credentials stored yet, and stopping it then would lose them).
 * - Anything listed and not running is started, in the order given, while
 *   there is room under `maxSessions`. A session still stopping counts against
 *   the room: its socket and memory are not gone yet.
 * - If the cap went down, the lowest-priority running sessions are stopped.
 */
export function planReconcile(input: {
  desired: DesiredSession[];
  running: string[];
  stopping?: string[];
  protected?: string[];
  maxSessions: number;
}): ReconcilePlan {
  const max = Math.max(0, Math.floor(input.maxSessions));
  const stopping = new Set(input.stopping ?? []);
  const shielded = new Set(input.protected ?? []);
  const running = new Set(input.running);
  const order: string[] = [];
  const seen = new Set<string>();
  for (const d of input.desired) {
    if (!d?.organizationId || seen.has(d.organizationId)) continue;
    seen.add(d.organizationId);
    order.push(d.organizationId);
  }

  const stop = new Set<string>();
  for (const org of running) {
    if (!seen.has(org) && !shielded.has(org)) stop.add(org);
  }

  // Over the cap (it was lowered, or protected sessions pushed it over): let go
  // of the lowest-priority ones Cortex still lists.
  const kept = [...running].filter((org) => !stop.has(org));
  if (kept.length > max) {
    const byPriority = kept.sort((a, b) => rank(order, a) - rank(order, b));
    for (const org of byPriority.slice(max)) {
      if (!shielded.has(org)) stop.add(org);
    }
  }

  const holding = [...running].filter((org) => !stop.has(org)).length + stopping.size;
  let room = max - holding;
  const start: string[] = [];
  for (const org of order) {
    if (room <= 0) break;
    if (running.has(org) || stopping.has(org)) continue;
    start.push(org);
    room -= 1;
  }

  return { start, stop: [...stop].sort() };
}

function rank(order: string[], org: string): number {
  const i = order.indexOf(org);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

/**
 * Whether the last renewed lease is still certainly ours.
 *
 * `marginMs` is taken off the end: the clock that matters is Cortex's, the
 * renewal took time to travel, and "certainly" is the whole point.
 */
export function leaseAlive(
  lastRenewedAt: number | null,
  now: number,
  leaseMs: number,
  marginMs: number,
): boolean {
  if (lastRenewedAt === null) return false;
  return now - lastRenewedAt < leaseMs - Math.max(0, marginMs);
}

export type ClaimDecision =
  /** Reconcile towards this list. */
  | { kind: 'apply'; desired: DesiredSession[] }
  /** No answer, but the lease still holds: keep what is running, start nothing. */
  | { kind: 'hold' }
  /** No answer and the lease may have lapsed: let go of every socket. */
  | { kind: 'release_all' };

/** A claim round-trip finished (or failed). What now? */
export function decideOnClaim(input: {
  mode: 'single' | 'multi';
  reply: ClaimReply | null;
  /** When the last successful claim came back; null if none ever did. */
  lastRenewedAt: number | null;
  now: number;
  leaseMs: number;
  marginMs: number;
  /** Single mode's one workspace. */
  organizationId?: string | null;
}): ClaimDecision {
  if (input.mode === 'single') {
    // As before multi-tenancy: the one session runs whatever Cortex says, and
    // its own pairing state machine decides when it talks to WhatsApp. The
    // claim is only there so a multi-mode process leaves this workspace alone.
    if (!input.organizationId) return { kind: 'hold' };
    return {
      kind: 'apply',
      desired: [{ organizationId: input.organizationId, paired: false, pairingRequested: false }],
    };
  }

  if (input.reply && Array.isArray(input.reply.sessions)) {
    return { kind: 'apply', desired: sanitizeDesired(input.reply.sessions) };
  }

  return leaseAlive(input.lastRenewedAt, input.now, input.leaseMs, input.marginMs)
    ? { kind: 'hold' }
    : { kind: 'release_all' };
}

const ORG_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** What came over the wire, reduced to what this process will act on. */
export function sanitizeDesired(raw: unknown): DesiredSession[] {
  if (!Array.isArray(raw)) return [];
  const out: DesiredSession[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { organizationId, paired, pairingRequested } = item as Record<string, unknown>;
    if (typeof organizationId !== 'string' || !ORG_ID.test(organizationId)) continue;
    if (seen.has(organizationId)) continue;
    seen.add(organizationId);
    out.push({
      organizationId,
      paired: paired === true,
      pairingRequested: pairingRequested === true,
    });
  }
  return out;
}
