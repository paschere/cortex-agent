/**
 * When to talk to WhatsApp, as pure functions.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The first version of this bridge treated "no session yet" like any other
 * disconnect: open a socket, show six QR codes of twenty seconds each, get
 * "QR refs attempts ended", back off exponentially, repeat. Nobody was looking.
 * In production it reached attempt ~16 000 with five minutes between windows, so
 * the person who finally opened Cortex → WhatsApp almost never found a live code
 * — and a registration attempt every few minutes, forever, is exactly the kind
 * of machine-shaped traffic this whole service is arranged to avoid.
 *
 * So an UNPAIRED bridge is idle by default. It heartbeats to Cortex and does
 * nothing else until Cortex says somebody wants to pair (an admin pressed a
 * button and the screen is still open). Then, and only then, it opens a socket
 * and keeps a fresh code coming for as long as the request is alive. When the
 * request lapses it closes the socket and goes quiet again.
 *
 * A PAIRED bridge behaves exactly as before: real disconnects back off
 * exponentially with full jitter; `loggedOut` wipes the dead credentials.
 *
 * Everything here is synchronous and free of Baileys so the state machine can
 * be tested without a phone.
 */

/** What Cortex says in each heartbeat reply about pairing. */
export interface PairingRequest {
  requested: boolean;
  /** E.164 digits when a pairing CODE was asked for; null means QR. */
  phone: string | null;
}

export const NO_REQUEST: PairingRequest = { requested: false, phone: null };

export interface ReconnectPolicy {
  minBackoffMs: number;
  maxBackoffMs: number;
  /** Fixed pause before the next QR window while somebody is waiting. */
  pairingRetryMs: number;
  /** Ceiling for unexpected failures while pairing; never minutes. */
  pairingMaxBackoffMs: number;
}

/** WhatsApp's disconnect codes this file cares about (Baileys' DisconnectReason). */
export const CLOSE_CODES = {
  /** Also what "QR refs attempts ended" carries: the QR window simply ran out. */
  timedOut: 408,
  loggedOut: 401,
  restartRequired: 515,
} as const;

/** Full jitter: several instances restarting together must not synchronise. */
export function backoffFor(
  attempt: number,
  policy: Pick<ReconnectPolicy, 'minBackoffMs' | 'maxBackoffMs'>,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxBackoffMs, policy.minBackoffMs * 2 ** Math.min(attempt, 10));
  return Math.round(policy.minBackoffMs + random() * (ceiling - policy.minBackoffMs));
}

export type CloseDecision =
  /** Open a new socket after `delayMs`. `attempt` is the counter to keep. */
  | { kind: 'reconnect'; delayMs: number; attempt: number }
  /** Unpaired and nobody is asking: stay off WhatsApp until a request arrives. */
  | { kind: 'idle' }
  /** The paired device was unlinked. Wipe the credentials, then idle. */
  | { kind: 'logged_out' }
  /** The process is shutting down. */
  | { kind: 'stop' };

/**
 * A socket closed. What now?
 *
 * `paired` is whether the credentials in hand belong to a device WhatsApp has
 * accepted (Baileys' `creds.account`), read at the moment of the close — so the
 * restart WhatsApp demands right after a successful pairing already counts as
 * paired and reconnects normally.
 */
export function decideOnClose(
  input: {
    paired: boolean;
    statusCode: number | undefined;
    request: PairingRequest;
    /** Reconnect attempts so far since the last successful open. */
    attempt: number;
    stopping: boolean;
  },
  policy: ReconnectPolicy,
  random: () => number = Math.random,
): CloseDecision {
  if (input.stopping) return { kind: 'stop' };

  if (input.paired) {
    if (input.statusCode === CLOSE_CODES.loggedOut) return { kind: 'logged_out' };
    // Unchanged from before this file existed: exponential backoff with full
    // jitter, reset by the next successful open.
    const attempt = input.attempt + 1;
    return { kind: 'reconnect', delayMs: backoffFor(attempt, policy, random), attempt };
  }

  // Unpaired. Without somebody waiting there is nothing to retry for.
  if (!input.request.requested) return { kind: 'idle' };

  // The QR window ran out (or WhatsApp asked for a restart mid-handshake) while
  // somebody is looking at the screen: open the next window right away. Fixed,
  // short and NOT counted — the request itself is what bounds this loop, and it
  // lapses three minutes after the screen closes.
  if (
    input.statusCode === CLOSE_CODES.timedOut ||
    input.statusCode === CLOSE_CODES.restartRequired
  ) {
    return { kind: 'reconnect', delayMs: policy.pairingRetryMs, attempt: input.attempt };
  }

  // Something else broke while pairing (network, a refused handshake). Back off,
  // but never into minutes: a person is standing there with the phone.
  const attempt = input.attempt + 1;
  return {
    kind: 'reconnect',
    delayMs: Math.min(
      policy.pairingMaxBackoffMs,
      Math.max(policy.pairingRetryMs, backoffFor(attempt, policy, random)),
    ),
    attempt,
  };
}

export type HeartbeatAction =
  | { kind: 'none' }
  /** Open a socket now (a request arrived while idle). */
  | { kind: 'connect' }
  /** Close the pairing socket and go idle (the request lapsed). */
  | { kind: 'close' }
  /** Close and reopen: the person switched between QR and code, or the number. */
  | { kind: 'restart' };

/**
 * A heartbeat reply arrived. Does the pairing socket need to change?
 *
 * Only ever acts on an UNPAIRED bridge. Once paired, pairing requests are
 * meaningless and the connection is governed by `decideOnClose` alone.
 */
export function decideOnHeartbeat(input: {
  /** Null until the first boot read says whether there is a session. */
  paired: boolean | null;
  /** A socket is open or being opened. */
  socketActive: boolean;
  /** A reconnect is already scheduled. */
  reconnectPending: boolean;
  /** The pairing mode the open socket was started with (null = QR). */
  socketPhone: string | null;
  request: PairingRequest;
}): HeartbeatAction {
  if (input.paired !== false) return { kind: 'none' };

  if (!input.request.requested) {
    return input.socketActive || input.reconnectPending ? { kind: 'close' } : { kind: 'none' };
  }

  if (!input.socketActive) {
    // A scheduled reconnect will pick the request up on its own; do not race it
    // with a second socket.
    return input.reconnectPending ? { kind: 'none' } : { kind: 'connect' };
  }

  if (input.socketPhone !== input.request.phone) return { kind: 'restart' };
  return { kind: 'none' };
}

/** The status reported while the bridge is idle and unpaired. */
export function idleStatus(previous: string): 'waiting' | 'logged_out' {
  // After a logout the screen should keep saying WHY there is no session until
  // somebody re-pairs; otherwise "waiting" says it plainly.
  return previous === 'logged_out' ? 'logged_out' : 'waiting';
}

export const IDLE_HINT =
  'Sin vincular. El servicio está listo y espera que un administrador pida vincular el número desde Cortex → Integraciones → WhatsApp.';
