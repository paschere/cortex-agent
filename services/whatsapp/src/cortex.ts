import type { Config } from './config';
import { logger } from './logger';

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
  dmEnabled: boolean;
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

export class CortexClient {
  constructor(private readonly config: Config) {}

  private async call<T>(
    path: string,
    init: { method: string; body?: unknown; timeoutMs?: number },
  ): Promise<T | null> {
    const url = `${this.config.cortexBaseUrl}${path}`;
    // Every call is bounded. A hung request to Cortex must not stall the event
    // loop that is also holding the WhatsApp socket open.
    const signal = AbortSignal.timeout(init.timeoutMs ?? 30_000);

    try {
      const response = await fetch(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${this.config.bridgeToken}`,
          'x-cortex-organization': this.config.organizationId,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal,
      });

      if (!response.ok) {
        // The body can echo a message, so only the status travels to the log.
        logger.error({ path, status: response.status }, 'cortex refused a request');
        return null;
      }
      return (await response.json()) as T;
    } catch (err) {
      logger.error({ path, err: (err as Error).message }, 'could not reach cortex');
      return null;
    }
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

  /** Called only when WhatsApp says the device was logged out. */
  wipeState(): Promise<unknown> {
    return this.call('/api/whatsapp/bridge/state', { method: 'DELETE' });
  }

  heartbeat(body: {
    status: string;
    phoneNumber?: string | null;
    qr?: string | null;
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
}
