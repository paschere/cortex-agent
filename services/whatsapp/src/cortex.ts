import type { Config } from './config';
import { logger } from './logger';
import type { ClaimReply } from './reconcile';

/**
 * The only way this process reaches anything that persists.
 *
 * It holds no database credentials and opens no database connection. Everything
 * — the session, the groups, the messages, the answers to direct messages —
 * goes through Cortex over HTTPS with a shared bearer token. That is not
 * ceremony: it means the workspace scoping, the "is this group switched on"
 * check and every product decision live in one place that is already tested,
 * and this stays a transport. A bridge with a service-role key would be a
 * second application with its own opinion about who may read what.
 */

export interface RemoteState {
  creds: unknown | null;
  status: string;
  phoneNumber: string | null;
  keys: Record<string, Record<string, unknown>>;
}

export interface HeartbeatReply {
  archiveGroups: Array<{ jid: string; archiveFrom: string | null }>;
  /**
   * Groups Cortex may SPEAK in — and even there, only when it is mentioned.
   * A different list from `archiveGroups` on purpose: archiving and answering
   * are separate permissions (migration 0072) and the same group rarely wants
   * both.
   */
  replyGroups: string[];
  dmEnabled: boolean;
  /**
   * Somebody asked, within the last few minutes, to pair this number. Only
   * meaningful while the bridge has no session: an unpaired bridge talks to
   * WhatsApp ONLY while this is true. Optional because an older Cortex does not
   * send it, and absent must read as "nobody asked".
   */
  pairingRequested?: boolean;
  /** E.164 digits to request a pairing CODE for; null/absent means show a QR. */
  pairingPhone?: string | null;
  /**
   * Log this device out and forget the session (migration 0189). Sent when an
   * admin pressed «Desvincular», and when the number that just connected is
   * already linked to ANOTHER workspace — one phone serves one workspace.
   * Optional: absent means keep going.
   */
  unlink?: 'requested' | 'phone_taken' | null;
  /**
   * Replies a PERSON wrote from Cortex into an open customer-service
   * conversation (0185) — the client wrote within the last 24 h. Optional: an
   * older Cortex does not send it. Filtered again by `sanitizeOutbox`.
   */
  outbox?: unknown;
}

/** One line of the recent conversation, for context on a mention. */
export interface GroupContextLine {
  senderName: string | null;
  senderJid: string | null;
  sentAt: string;
  text: string;
}

export interface OutboundMessage {
  groupJid: string;
  messageId: string;
  senderJid: string | null;
  senderName: string | null;
  sentAt: string;
  body: string | null;
  kind: string;
  mediaMime: string | null;
  mediaFilename: string | null;
  mediaBase64: string | null;
}

/** Headers every bridge request carries, whichever workspace it is for. */
export const MODE_HEADER = 'x-cortex-bridge-mode';
export const INSTANCE_HEADER = 'x-cortex-bridge-instance';
export const ORGANIZATION_HEADER = 'x-cortex-organization';

async function callCortex<T>(
  config: Config,
  path: string,
  init: {
    method: string;
    body?: unknown;
    timeoutMs?: number;
    organizationId?: string;
    query?: string;
  },
): Promise<T | null> {
  const url = `${config.cortexBaseUrl}${path}${init.query ?? ''}`;
  // Every call is bounded. A hung request to Cortex must not stall the event
  // loop that is also holding the WhatsApp sockets open.
  const signal = AbortSignal.timeout(init.timeoutMs ?? 30_000);

  try {
    const response = await fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${config.bridgeToken}`,
        [MODE_HEADER]: config.mode,
        [INSTANCE_HEADER]: config.instanceId,
        ...(init.organizationId ? { [ORGANIZATION_HEADER]: init.organizationId } : {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal,
    });

    if (!response.ok) {
      // The body can echo a message, so only the status travels to the log.
      logger.error(
        { path, status: response.status, org: init.organizationId },
        'cortex refused a request',
      );
      return null;
    }
    return (await response.json()) as T;
  } catch (err) {
    logger.error(
      { path, err: (err as Error).message, org: init.organizationId },
      'could not reach cortex',
    );
    return null;
  }
}

/**
 * The process-level conversation with Cortex: which workspaces need a socket
 * here, and the lease that says this process — and no other — holds them.
 * Carries no workspace header: it is about all of them.
 */
export class CortexControl {
  constructor(private readonly config: Config) {}

  claim(body: { running: string[] }): Promise<ClaimReply | null> {
    return callCortex<ClaimReply>(this.config, '/api/whatsapp/bridge/sessions', {
      method: 'POST',
      body: {
        action: 'claim',
        mode: this.config.mode,
        maxSessions: this.config.maxSessions,
        leaseMs: this.config.leaseMs,
        organizationId: this.config.organizationId,
        running: body.running,
      },
      timeoutMs: 20_000,
    });
  }

  /** Shutdown: give every workspace back so the next process can take it at once. */
  release(): Promise<unknown> {
    return callCortex(this.config, '/api/whatsapp/bridge/sessions', {
      method: 'POST',
      body: { action: 'release' },
      timeoutMs: 10_000,
    });
  }
}

/**
 * One workspace's conversation with Cortex. Every request names that
 * workspace, so a session can only ever read and write its own state.
 */
export class CortexClient {
  constructor(
    private readonly config: Config,
    readonly organizationId: string,
  ) {}

  private call<T>(
    path: string,
    init: { method: string; body?: unknown; timeoutMs?: number; query?: string },
  ): Promise<T | null> {
    return callCortex<T>(this.config, path, { ...init, organizationId: this.organizationId });
  }

  /** Boot: the paired identity and every signal key, in one read. */
  loadState(): Promise<RemoteState | null> {
    // Generous: this is one request at startup and it carries the whole key
    // store, which for a busy account is a few thousand small records.
    return this.call<RemoteState>('/api/whatsapp/bridge/state', {
      method: 'GET',
      timeoutMs: 60_000,
    });
  }

  saveState(body: {
    creds?: unknown;
    set?: Record<string, Record<string, unknown | null>>;
  }): Promise<unknown> {
    return this.call('/api/whatsapp/bridge/state', { method: 'POST', body });
  }

  /**
   * Forget the session. `logged_out`: WhatsApp revoked the device. `unlink`: an
   * admin pressed «Desvincular». `phone_taken`: the number is another
   * workspace's. Cortex words the screen differently for each.
   */
  wipeState(reason: 'logged_out' | 'unlink' | 'phone_taken' = 'logged_out'): Promise<unknown> {
    return this.call('/api/whatsapp/bridge/state', {
      method: 'DELETE',
      query: `?reason=${reason}`,
    });
  }

  heartbeat(body: {
    status: string;
    phoneNumber?: string | null;
    qr?: string | null;
    /** The 8-character code from `requestPairingCode`, while it is alive. */
    pairingCode?: string | null;
    error?: string | null;
  }): Promise<HeartbeatReply | null> {
    return this.call<HeartbeatReply>('/api/whatsapp/bridge/heartbeat', { method: 'POST', body });
  }

  publishGroups(
    groups: Array<{ jid: string; subject: string | null; participantCount: number | null }>,
  ): Promise<unknown> {
    return this.call('/api/whatsapp/bridge/groups', { method: 'POST', body: { groups } });
  }

  sendMessages(messages: OutboundMessage[]): Promise<{ stored: number; ignored: number } | null> {
    return this.call('/api/whatsapp/bridge/messages', {
      method: 'POST',
      body: { messages },
      // Voice notes are transcribed inside this request.
      timeoutMs: 240_000,
    });
  }

  /** Ask Cortex to fold finished conversations into Brain Knowledge. */
  flush(): Promise<unknown> {
    return this.call('/api/whatsapp/bridge/flush', { method: 'POST', timeoutMs: 280_000 });
  }

  askAgent(body: {
    jid: string;
    pushName: string | null;
    text: string;
    messageId: string;
  }): Promise<{ reply: string | null; delayMs?: number } | null> {
    return this.call('/api/whatsapp/bridge/dm', { method: 'POST', body, timeoutMs: 280_000 });
  }

  /** Tell Cortex whether a person's reply from the outbox went out. */
  ackOutbox(body: { id: string; ok: boolean }): Promise<unknown> {
    return this.call('/api/whatsapp/bridge/customer/sent', { method: 'POST', body });
  }

  /**
   * Cortex was mentioned in a group. Cortex decides whether that earns a reply
   * — the bridge does not. `reply: null` is the normal, expected answer for a
   * duplicate delivery, an unknown sender who has already been told, or a group
   * that has had enough for one hour.
   */
  answerMention(body: {
    groupJid: string;
    messageId: string;
    senderJid: string | null;
    senderName: string | null;
    text: string;
    mentionedJids: string[];
    quotedAuthorJid: string | null;
    selfJids: string[];
    recent: GroupContextLine[];
  }): Promise<{
    reply: string | null;
    delayMs?: number;
    /** Substance kept out of the room, for the asker's own chat. */
    dm?: { jid: string; text: string } | null;
  } | null> {
    return this.call('/api/whatsapp/bridge/group-mention', {
      method: 'POST',
      body,
      timeoutMs: 280_000,
    });
  }
}
