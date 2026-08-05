import type { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  type WASocket,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import qrTerminal from 'qrcode-terminal';
import { usePostgresAuthState } from './auth-state';
import type { Config } from './config';
import { CortexClient, type OutboundMessage } from './cortex';
import { extractDirectText, extractGroupMessage } from './extract';
import { baileysLogger, logger } from './logger';

/**
 * The connection.
 *
 * ── WHAT IT WILL AND WILL NOT DO ────────────────────────────────────────────
 *
 * This account NEVER STARTS A CONVERSATION. Not a greeting, not a notification,
 * not a "your report is ready". It replies in a 1:1 chat where the other person
 * wrote first, and it says nothing at all in a group — it is a silent member
 * there, reading the groups an operator explicitly switched on.
 *
 * That is partly manners and mostly risk. Baileys is an unofficial client;
 * WhatsApp's abuse detection is not published, but the behaviour that gets a
 * number banned is well understood and it is all outbound: unsolicited first
 * messages, bulk sends, instant replies at machine speed, a client identity
 * that changes every restart. Reading emits almost nothing by comparison. So
 * the shape here is: read a lot, write rarely, and when writing, look like a
 * person answering their phone — a short delay proportional to the reply, the
 * "escribiendo…" indicator while it lasts, and a fixed browser identity so the
 * device list on the phone shows one stable entry called Cortex rather than a
 * new one after every deploy.
 *
 * ── RECONNECTING ────────────────────────────────────────────────────────────
 *
 * Two failures that look identical in the logs and must be handled in opposite
 * ways:
 *
 *   Everything except `loggedOut` — a dropped socket, a restart WhatsApp asked
 *   for, a network blip, a 503. The session is still valid. Reconnect with
 *   exponential backoff and full jitter, and the backoff resets the moment a
 *   connection succeeds.
 *
 *   `loggedOut` — the device was unlinked, from the phone or by WhatsApp. The
 *   credentials are DEAD. Retrying with them is an infinite loop against a
 *   device that no longer exists, and it is the fastest way to get the number
 *   flagged. So: wipe the stored session, report it so the screen can say
 *   "hay que volver a emparejar", and come back once — after a long pause —
 *   with an empty session, which is what puts a fresh QR on the screen. One
 *   restart into pairing mode, never a loop.
 */

export type Status = 'disconnected' | 'pairing' | 'connected' | 'logged_out';

/** Full jitter: several instances restarting together must not synchronise. */
function backoffFor(attempt: number, config: Config): number {
  const ceiling = Math.min(config.maxBackoffMs, config.minBackoffMs * 2 ** Math.min(attempt, 10));
  return Math.round(config.minBackoffMs + Math.random() * (ceiling - config.minBackoffMs));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class WhatsappBridge {
  private sock: WASocket | null = null;
  private readonly cortex: CortexClient;

  private status: Status = 'disconnected';
  private lastError: string | null = null;
  private phoneNumber: string | null = null;
  /** Rendered PNG data URL, so the browser needs no QR library. */
  private qrDataUrl: string | null = null;

  private attempt = 0;
  private stopping = false;
  private connecting = false;

  /** Group jids an operator switched on. Nothing else is even buffered. */
  private allowed = new Map<string, number>();
  private dmEnabled = true;

  private buffer: OutboundMessage[] = [];
  private flushing = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly config: Config) {
    this.cortex = new CortexClient(config);
  }

  // -------------------------------------------------------------------------
  // What /health and /qr answer with
  // -------------------------------------------------------------------------

  snapshot(): {
    status: Status;
    phoneNumber: string | null;
    hasQr: boolean;
    buffered: number;
    archivedGroups: number;
    lastError: string | null;
  } {
    return {
      status: this.status,
      phoneNumber: this.phoneNumber,
      hasQr: Boolean(this.qrDataUrl),
      buffered: this.buffer.length,
      archivedGroups: this.allowed.size,
      lastError: this.lastError,
    };
  }

  currentQr(): string | null {
    return this.qrDataUrl;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.timers.push(setInterval(() => void this.heartbeat(), this.config.heartbeatMs));
    this.timers.push(setInterval(() => void this.flushBuffer(), this.config.batchIntervalMs));
    this.timers.push(setInterval(() => void this.cortex.flush(), this.config.ingestTickMs));
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    // Anything heard in the last few seconds is still only in memory. Losing it
    // would be a hole in the archive that nothing later would notice.
    await this.flushBuffer();
    try {
      this.sock?.end(undefined);
    } catch {
      // Already gone; nothing to do.
    }
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.stopping) return;
    this.connecting = true;

    try {
      const auth = await usePostgresAuthState(this.cortex);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({
        // A pinned fallback beats refusing to start: WhatsApp accepts slightly
        // stale protocol versions, and the fetch is a convenience.
        version: undefined as unknown as [number, number, number],
      }));

      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: {
          creds: auth.state.creds,
          // Baileys' own read-through cache in front of ours. It collapses the
          // repeated key reads a single decryption performs.
          keys: makeCacheableSignalKeyStore(auth.state.keys, baileysLogger),
        },
        logger: baileysLogger,
        browser: this.config.browser,
        // We are not a phone: printing the QR is this service's job, and
        // marking every chat read on connect would emit a burst of receipts.
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
      });
      this.sock = sock;

      sock.ev.on('creds.update', () => {
        void auth.saveCreds();
      });

      sock.ev.on('connection.update', (update) => {
        void this.onConnectionUpdate(update, auth.flush);
      });

      sock.ev.on('messages.upsert', (event) => {
        // `notify` is a live message. `append` is history sync replaying things
        // that were already delivered, and answering one of those would mean
        // replying to a question somebody asked three days ago.
        if (event.type !== 'notify') return;
        for (const message of event.messages) void this.onMessage(message);
      });

      sock.ev.on('groups.upsert', () => void this.publishGroups());
      sock.ev.on('groups.update', () => void this.publishGroups());
    } catch (err) {
      this.lastError = (err as Error).message;
      logger.error({ err: this.lastError }, 'could not open the WhatsApp connection');
      this.connecting = false;
      await this.scheduleReconnect();
      return;
    }

    this.connecting = false;
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.stopping) return;
    this.attempt += 1;
    const wait = backoffFor(this.attempt, this.config);
    logger.warn({ attempt: this.attempt, waitMs: wait }, 'reconnecting to WhatsApp');
    await sleep(wait);
    await this.connect();
  }

  private async onConnectionUpdate(
    update: { connection?: string; lastDisconnect?: { error?: Error }; qr?: string },
    flushState: () => Promise<void>,
  ): Promise<void> {
    if (update.qr) {
      this.status = 'pairing';
      // Two renderings of the same code, deliberately. The terminal one is what
      // an operator tailing `railway logs` can scan without opening anything
      // else; the PNG is what the Cortex screen shows to somebody who has no
      // access to the logs at all.
      qrTerminal.generate(update.qr, { small: true });
      logger.info('scan the QR above, or open Cortex → WhatsApp, to pair this number');
      this.qrDataUrl = await QRCode.toDataURL(update.qr, { margin: 1, width: 512 }).catch(
        () => null,
      );
      await this.heartbeat();
    }

    if (update.connection === 'open') {
      this.status = 'connected';
      this.attempt = 0;
      this.qrDataUrl = null;
      this.lastError = null;
      this.phoneNumber = this.sock?.user?.id?.split(':')[0]?.split('@')[0] ?? null;
      logger.info({ phoneNumber: this.phoneNumber }, 'connected to WhatsApp');
      await this.heartbeat();
      await this.publishGroups();
      return;
    }

    if (update.connection !== 'close') return;

    const statusCode = (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;

    // Whatever is still buffered in the auth store belongs to a session that
    // was valid a moment ago. Push it before deciding what to do.
    await flushState().catch(() => undefined);

    if (loggedOut) {
      this.status = 'logged_out';
      this.lastError =
        'WhatsApp cerró la sesión de este dispositivo. Hay que volver a emparejar escaneando el código QR.';
      logger.error(
        'WhatsApp logged this device out. The stored credentials are dead and will NOT be retried; wiping them so the next connection asks for a fresh pairing.',
      );
      await this.cortex.wipeState();
      await this.heartbeat();

      // One restart, after a long pause, with an empty session — which is what
      // produces a QR to re-pair with. Not a retry loop: there is nothing to
      // retry, and hammering a logged-out account is exactly the behaviour that
      // gets a number flagged.
      this.attempt = 0;
      await sleep(this.config.maxBackoffMs);
      await this.connect();
      return;
    }

    this.status = 'disconnected';
    this.lastError = (update.lastDisconnect?.error as Error | undefined)?.message ?? null;
    await this.heartbeat();
    await this.scheduleReconnect();
  }

  // -------------------------------------------------------------------------
  // Reporting in
  // -------------------------------------------------------------------------

  private async heartbeat(): Promise<void> {
    const reply = await this.cortex.heartbeat({
      status: this.status,
      phoneNumber: this.phoneNumber,
      qr: this.qrDataUrl,
      error: this.lastError,
    });
    if (!reply) return;

    // The allow-list is refreshed on every heartbeat, so switching a group on
    // in Cortex takes effect within one beat rather than on the next deploy.
    this.allowed = new Map(
      reply.archiveGroups.map((g) => [g.jid, g.archiveFrom ? Date.parse(g.archiveFrom) : 0]),
    );
    this.dmEnabled = reply.dmEnabled;
  }

  private async publishGroups(): Promise<void> {
    const sock = this.sock;
    if (!sock || this.status !== 'connected') return;
    try {
      const all = await sock.groupFetchAllParticipating();
      const groups = Object.values(all).map((g) => ({
        jid: g.id,
        subject: g.subject ?? null,
        participantCount: g.participants?.length ?? null,
      }));
      if (groups.length > 0) await this.cortex.publishGroups(groups);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'could not list the groups');
    }
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  private async onMessage(raw: Parameters<typeof extractGroupMessage>[0]): Promise<void> {
    const jid = raw.key?.remoteJid ?? '';
    if (!jid) return;

    if (jid.endsWith('@g.us')) {
      await this.onGroupMessage(raw);
      return;
    }
    // Status broadcasts, newsletters and anything else that is not a person.
    if (!jid.endsWith('@s.whatsapp.net')) return;
    if (raw.key?.fromMe) return;
    await this.onDirectMessage(raw);
  }

  /**
   * THE FIRST OF TWO LOCKS on "only the groups somebody switched on".
   *
   * A message from a group that is not on the allow-list is dropped here, in
   * memory, on the Railway container — it never crosses the network, never
   * reaches Cortex and never touches the database. The second lock is in the
   * ingest route, which checks again against the database, so a bridge running
   * a stale allow-list still cannot archive anything nobody chose.
   */
  private async onGroupMessage(raw: Parameters<typeof extractGroupMessage>[0]): Promise<void> {
    const jid = raw.key?.remoteJid ?? '';
    const archiveFrom = this.allowed.get(jid);
    if (archiveFrom === undefined) return;

    const extracted = extractGroupMessage(raw);
    if (!extracted) return;
    if (archiveFrom > 0 && Date.parse(extracted.sentAt) < archiveFrom) return;

    let mediaBase64: string | null = null;
    if (extracted.hasMedia) {
      mediaBase64 = await this.downloadMedia(raw, extracted.kind);
    }

    this.buffer.push({
      groupJid: extracted.groupJid,
      messageId: extracted.messageId,
      senderJid: extracted.senderJid,
      senderName: extracted.senderName,
      sentAt: extracted.sentAt,
      body: extracted.body,
      kind: extracted.kind,
      mediaMime: extracted.mediaMime,
      mediaFilename: extracted.mediaFilename,
      mediaBase64,
    });

    // Buffered rather than sent one at a time: a busy group emits hundreds of
    // messages a day and a request per message would be hundreds of round trips
    // for text like "listo".
    if (this.buffer.length >= this.config.batchSize) await this.flushBuffer();
  }

  /**
   * Pull the bytes, but only for the two things Cortex has a plan for: a voice
   * note (transcribed with Deepgram) and a file it can parse (filed as its own
   * document). Photographs and video are represented by their caption; storing
   * them would cost bandwidth and storage to produce nothing retrievable.
   */
  private async downloadMedia(
    raw: Parameters<typeof extractGroupMessage>[0],
    kind: string,
  ): Promise<string | null> {
    const limit = kind === 'voice' ? this.config.maxVoiceBytes : this.config.maxDocumentBytes;
    try {
      const buffer = (await downloadMediaMessage(
        raw,
        'buffer',
        {},
        {
          logger: baileysLogger,
          reuploadRequest: this.sock?.updateMediaMessage as never,
        },
      )) as Buffer;
      if (!buffer || buffer.byteLength === 0 || buffer.byteLength > limit) return null;
      return buffer.toString('base64');
    } catch (err) {
      // A message whose media cannot be fetched is still part of the
      // conversation and is still archived — as a marker, without its content.
      logger.warn({ err: (err as Error).message, kind }, 'could not download media');
      return null;
    }
  }

  private async flushBuffer(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];

    try {
      const result = await this.cortex.sendMessages(batch);
      if (!result) {
        // Cortex was unreachable. Put them back at the FRONT, in order, so the
        // conversation is not reassembled out of sequence later.
        this.buffer = [...batch, ...this.buffer];
      } else {
        logger.info(
          { stored: result.stored, ignored: result.ignored },
          'staged a batch of group messages',
        );
      }
    } finally {
      this.flushing = false;
    }
  }

  // -------------------------------------------------------------------------
  // Direct messages
  // -------------------------------------------------------------------------

  private async onDirectMessage(raw: Parameters<typeof extractGroupMessage>[0]): Promise<void> {
    const sock = this.sock;
    const jid = raw.key?.remoteJid;
    if (!sock || !jid || !this.dmEnabled) return;

    const text = extractDirectText(raw);
    if (!text) return;

    // Marking the message read is the one outbound signal here that is not a
    // reply, and it is the one a person expects: somebody who wrote to a number
    // that never shows a blue tick assumes nobody is there.
    await sock.readMessages([raw.key]).catch(() => undefined);

    // "escribiendo…" for as long as the turn actually takes, refreshed because
    // WhatsApp expires the indicator after a few seconds. It is honest — the
    // work is genuinely happening — and it is what stops a slow turn reading as
    // silence.
    let typing: NodeJS.Timeout | null = null;
    try {
      await sock.sendPresenceUpdate('composing', jid).catch(() => undefined);
      typing = setInterval(() => {
        void sock.sendPresenceUpdate('composing', jid).catch(() => undefined);
      }, 5_000);

      const answer = await this.cortex.askAgent({
        jid,
        pushName: raw.pushName ?? null,
        text,
        messageId: raw.key?.id ?? '',
      });

      if (typing) clearInterval(typing);
      typing = null;
      await sock.sendPresenceUpdate('paused', jid).catch(() => undefined);

      // Null is a decision, not a failure: a group message reaching here, or a
      // sender Cortex would not act for. Silence is the correct reply.
      if (!answer?.reply) return;

      // A short pause before sending. Not theatre — an account that answers in
      // 180 ms at 3am is a script, and looking like one is the risk this whole
      // module is arranged around.
      if (answer.delayMs) await sleep(Math.min(answer.delayMs, 6_000));
      await sock.sendMessage(jid, { text: answer.reply });
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'could not answer a direct message');
    } finally {
      if (typing) clearInterval(typing);
    }
  }
}
