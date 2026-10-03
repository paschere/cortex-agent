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
import { isPaired, usePostgresAuthState } from './auth-state';
import type { Config } from './config';
import { CortexClient, type GroupContextLine, type OutboundMessage } from './cortex';
import { extractDirectText, extractGroupMessage, extractMentionSignals } from './extract';
import { baileysLogger, logger } from './logger';
import { type OutboxMessage, gapMs, sanitizeOutbox, typingMs } from './outbox';
import {
  CLOSE_CODES,
  IDLE_HINT,
  NO_REQUEST,
  type PairingRequest,
  backoffFor,
  decideOnClose,
  decideOnHeartbeat,
  idleStatus,
} from './pairing';

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
 *   "hay que volver a vincular", and go idle.
 *
 * ── PAIRING ─────────────────────────────────────────────────────────────────
 *
 * Without a paired session this process does NOT talk to WhatsApp on its own.
 * It heartbeats to Cortex (status `waiting`) until an admin asks for a pairing
 * on the Cortex screen; then it opens a registration socket and keeps a fresh
 * QR — or an 8-character code for "Vincular con el número de teléfono" — coming
 * for as long as somebody is looking, and goes quiet again when they stop. The
 * decisions live in `pairing.ts` as pure functions, with the reasons.
 */

export type Status = 'disconnected' | 'waiting' | 'pairing' | 'connected' | 'logged_out';

type Auth = Awaited<ReturnType<typeof usePostgresAuthState>>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class WhatsappBridge {
  private sock: WASocket | null = null;
  private readonly cortex: CortexClient;

  private status: Status = 'disconnected';
  private lastError: string | null = null;
  private phoneNumber: string | null = null;
  /** Rendered PNG data URL, so the browser needs no QR library. */
  private qrDataUrl: string | null = null;
  /** The 8-character code from `requestPairingCode`, while its socket lives. */
  private pairingCode: string | null = null;

  /**
   * Whether the session in hand belongs to a device WhatsApp accepted. Null
   * until the first read of the stored session; see `isPaired`.
   */
  private paired: boolean | null = null;
  /** The latest pairing request Cortex reported. See `pairing.ts`. */
  private request: PairingRequest = NO_REQUEST;
  /** The pairing mode the current socket was opened for (null = QR). */
  private socketPhone: string | null = null;

  private attempt = 0;
  private stopping = false;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  /** Group jids an operator switched ARCHIVING on for. Nothing else is buffered. */
  private allowed = new Map<string, number>();
  /**
   * Group jids Cortex may SPEAK in when mentioned. A different set from
   * `allowed` on purpose: archiving a group and answering in it are separate
   * permissions, and the same group rarely wants both.
   */
  private replyGroups = new Set<string>();
  /**
   * The last few messages of each reply-enabled group, IN MEMORY ONLY.
   *
   * "@Cortex mira esto" means nothing on its own, so a mention has to arrive
   * with the conversation around it. Keeping that here rather than reading it
   * back from the database is what lets a group have answering switched on and
   * archiving switched off and genuinely store nothing: the context exists for
   * the length of one turn and dies with the process.
   */
  private recent = new Map<string, GroupContextLine[]>();
  private dmEnabled = true;
  /** Una sola tanda de respuestas de personas a la vez. */
  private deliveringOutbox = false;

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
    hasPairingCode: boolean;
    pairingRequested: boolean;
    buffered: number;
    archivedGroups: number;
    replyGroups: number;
    lastError: string | null;
  } {
    return {
      status: this.status,
      phoneNumber: this.phoneNumber,
      hasQr: Boolean(this.qrDataUrl),
      hasPairingCode: Boolean(this.pairingCode),
      pairingRequested: this.request.requested,
      buffered: this.buffer.length,
      archivedGroups: this.allowed.size,
      replyGroups: this.replyGroups.size,
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
    this.timers.push(setInterval(() => void this.flushBuffer(), this.config.batchIntervalMs));
    this.timers.push(setInterval(() => void this.cortex.flush(), this.config.ingestTickMs));
    this.scheduleHeartbeat();
    // A paired session reconnects straight away. An unpaired one reads the
    // stored state, finds nothing, reports in and waits — `connect` decides.
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.clearReconnect();
    // Anything heard in the last few seconds is still only in memory. Losing it
    // would be a hole in the archive that nothing later would notice.
    await this.flushBuffer();
    try {
      this.sock?.end(undefined);
    } catch {
      // Already gone; nothing to do.
    }
  }

  /**
   * The heartbeat is a loop of timeouts rather than an interval because its
   * period depends on the state: every `heartbeatMs` while connected, and every
   * `pairingHeartbeatMs` (≤ 15 s) otherwise — the reply is how a pairing request
   * reaches an idle bridge, and somebody is standing there with the phone.
   */
  private scheduleHeartbeat(): void {
    if (this.stopping) return;
    const every =
      this.status === 'connected' ? this.config.heartbeatMs : this.config.pairingHeartbeatMs;
    this.heartbeatTimer = setTimeout(() => {
      void this.heartbeat().finally(() => this.scheduleHeartbeat());
    }, every);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopping) return;
    this.clearReconnect();
    logger.warn({ attempt: this.attempt, waitMs: delayMs }, 'reconnecting to WhatsApp');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.stopping || this.sock) return;
    this.clearReconnect();
    this.connecting = true;

    let auth: Auth;
    let sock: WASocket;
    let pairingPhone: string | null = null;
    try {
      auth = await usePostgresAuthState(this.cortex);
      this.paired = auth.paired;
      const { version } = await fetchLatestBaileysVersion().catch(() => ({
        // A pinned fallback beats refusing to start: WhatsApp accepts slightly
        // stale protocol versions, and the fetch is a convenience.
        version: undefined as unknown as [number, number, number],
      }));

      // THE RULE THIS WHOLE CHANGE IS ABOUT: without a session, nobody asking
      // means no socket. Checked after the awaits so a request that lapsed
      // while the state was loading is honoured.
      if (!auth.paired && !this.request.requested) {
        this.connecting = false;
        await this.goIdle();
        return;
      }
      if (this.stopping) {
        this.connecting = false;
        return;
      }
      pairingPhone = auth.paired ? null : this.request.phone;

      sock = makeWASocket({
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
    } catch (err) {
      this.lastError = (err as Error).message;
      logger.error({ err: this.lastError }, 'could not open the WhatsApp connection');
      this.connecting = false;
      this.attempt += 1;
      this.scheduleReconnect(backoffFor(this.attempt, this.config));
      return;
    }

    this.sock = sock;
    this.socketPhone = pairingPhone;
    if (!auth.paired) {
      this.status = 'pairing';
      this.lastError = null;
      logger.info(
        { mode: pairingPhone ? 'code' : 'qr' },
        'pairing requested from Cortex; opening a registration socket',
      );
    }
    const currentAuth = auth;
    let codeRequested = false;

    sock.ev.on('creds.update', () => {
      void currentAuth.saveCreds();
    });

    sock.ev.on('connection.update', (update) => {
      // A socket this process already let go of (a lapsed request, a switch
      // between QR and code) still emits its own close. It is not news.
      if (sock !== this.sock) return;
      // A pairing CODE is requested on the registration socket once WhatsApp
      // has finished the handshake — the first QR is the signal that it has.
      if (update.qr && pairingPhone && !codeRequested && !isPaired(currentAuth.state.creds)) {
        codeRequested = true;
        void this.requestCode(sock, pairingPhone);
      }
      void this.onConnectionUpdate(sock, update, currentAuth);
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

    this.connecting = false;
  }

  /**
   * Off WhatsApp until somebody asks. Only ever reached without a paired
   * session: a paired bridge is never idle, it is connected or reconnecting.
   */
  private async goIdle(): Promise<void> {
    this.clearReconnect();
    const sock = this.sock;
    this.sock = null;
    this.socketPhone = null;
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.attempt = 0;
    if (sock) {
      try {
        sock.end(undefined);
      } catch {
        // Already gone.
      }
    }
    const before = this.status;
    this.status = idleStatus(before);
    if (this.status === 'waiting') this.lastError = IDLE_HINT;
    if (before !== this.status || sock) {
      logger.info('no pairing requested; staying off WhatsApp until somebody asks from Cortex');
    }
    await this.heartbeat();
  }

  /** The person switched between QR and code, or typed another number. */
  private restartPairing(): void {
    const sock = this.sock;
    this.sock = null;
    this.socketPhone = null;
    this.qrDataUrl = null;
    this.pairingCode = null;
    try {
      sock?.end(undefined);
    } catch {
      // Already gone.
    }
    void this.connect();
  }

  private async requestCode(sock: WASocket, phone: string): Promise<void> {
    try {
      const code = await sock.requestPairingCode(phone);
      if (sock !== this.sock) return;
      this.pairingCode = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      this.lastError = null;
      // The code itself is NOT logged: it is a short-lived credential, and the
      // Cortex screen is where the person who asked for it is looking.
      logger.info('pairing code issued; it is on the Cortex screen');
    } catch (err) {
      if (sock !== this.sock) return;
      this.lastError =
        'WhatsApp no entregó un código para ese número. Revisa que tenga el indicativo del país y que sea el del teléfono dedicado; mientras tanto puedes escanear el QR.';
      logger.warn({ err: (err as Error).message }, 'could not get a pairing code');
    }
    await this.heartbeat();
  }

  private async onConnectionUpdate(
    sock: WASocket,
    update: { connection?: string; lastDisconnect?: { error?: Error }; qr?: string },
    auth: Auth,
  ): Promise<void> {
    if (update.qr) {
      this.status = 'pairing';
      if (!this.socketPhone) {
        // Two renderings of the same code, deliberately. The terminal one is
        // what an operator tailing `railway logs` can scan without opening
        // anything else; the PNG is what the Cortex screen shows to somebody
        // who has no access to the logs at all.
        qrTerminal.generate(update.qr, { small: true });
        logger.info('scan the QR above, or open Cortex → WhatsApp, to pair this number');
      }
      const rendered = await QRCode.toDataURL(update.qr, { margin: 1, width: 512 }).catch(
        () => null,
      );
      // The socket may have been let go while the image rendered.
      if (sock !== this.sock) return;
      this.qrDataUrl = rendered;
      await this.heartbeat();
    }

    if (update.connection === 'open') {
      this.status = 'connected';
      this.paired = true;
      this.attempt = 0;
      this.qrDataUrl = null;
      this.pairingCode = null;
      this.socketPhone = null;
      this.request = NO_REQUEST;
      this.lastError = null;
      this.phoneNumber = this.sock?.user?.id?.split(':')[0]?.split('@')[0] ?? null;
      logger.info({ phoneNumber: this.phoneNumber }, 'connected to WhatsApp');
      await this.heartbeat();
      await this.publishGroups();
      return;
    }

    if (update.connection !== 'close') return;

    if (this.sock === sock) this.sock = null;
    this.socketPhone = null;
    this.qrDataUrl = null;
    this.pairingCode = null;

    const error = update.lastDisconnect?.error as (Boom & Error) | undefined;
    const statusCode = error?.output?.statusCode;

    // Whatever is still buffered in the auth store belongs to a session that
    // was valid a moment ago. Push it before deciding what to do.
    await auth.flush().catch(() => undefined);

    const paired = isPaired(auth.state.creds);
    this.paired = paired;
    const decision = decideOnClose(
      {
        paired,
        statusCode,
        request: this.request,
        // The restart WhatsApp demands right after a successful pairing is the
        // first close of a brand-new session, not the Nth failure of an old one.
        attempt: this.status === 'pairing' ? 0 : this.attempt,
        stopping: this.stopping,
      },
      this.config,
    );

    switch (decision.kind) {
      case 'stop':
        return;

      case 'logged_out':
        this.status = 'logged_out';
        this.paired = false;
        this.lastError =
          'WhatsApp cerró la sesión de este dispositivo. Hay que volver a vincular el número desde esta pantalla.';
        logger.error(
          'WhatsApp logged this device out. The stored credentials are dead and will NOT be retried; wiping them and waiting for somebody to ask for a new pairing.',
        );
        await this.cortex.wipeState();
        // Not a retry loop and not even one automatic restart: there is nothing
        // to retry, hammering a logged-out account is exactly the behaviour that
        // gets a number flagged, and a fresh pairing needs a person anyway.
        await this.goIdle();
        return;

      case 'idle':
        await this.goIdle();
        return;

      case 'reconnect':
        this.attempt = decision.attempt;
        if (paired) {
          this.status = 'disconnected';
          this.lastError = error?.message ?? null;
        } else if (statusCode !== CLOSE_CODES.timedOut) {
          // Still pairing; between QR windows is not worth a message, a real
          // failure is.
          this.lastError = error?.message ?? null;
        }
        await this.heartbeat();
        this.scheduleReconnect(decision.delayMs);
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Reporting in
  // -------------------------------------------------------------------------

  private async heartbeat(): Promise<void> {
    const reply = await this.cortex.heartbeat({
      status: this.status,
      phoneNumber: this.phoneNumber,
      qr: this.qrDataUrl,
      pairingCode: this.pairingCode,
      error: this.lastError,
    });
    if (!reply) return;

    // The allow-list is refreshed on every heartbeat, so switching a group on
    // in Cortex takes effect within one beat rather than on the next deploy.
    this.allowed = new Map(
      reply.archiveGroups.map((g) => [g.jid, g.archiveFrom ? Date.parse(g.archiveFrom) : 0]),
    );
    this.replyGroups = new Set(reply.replyGroups ?? []);
    // Stop holding context for a group Cortex is no longer allowed to speak in.
    for (const jid of [...this.recent.keys()]) {
      if (!this.replyGroups.has(jid)) this.recent.delete(jid);
    }
    this.dmEnabled = reply.dmEnabled;

    // Respuestas de una persona (0185). Nunca esperadas desde el latido: una
    // tanda tarda segundos a propósito y el latido no puede quedarse quieto.
    const outbox = sanitizeOutbox(reply.outbox);
    if (outbox.length > 0) void this.deliverOutbox(outbox);

    this.request = {
      requested: reply.pairingRequested === true,
      phone:
        typeof reply.pairingPhone === 'string' && /^\d{8,15}$/.test(reply.pairingPhone)
          ? reply.pairingPhone
          : null,
    };
    this.applyPairingRequest();
  }

  /** Never awaited from the heartbeat: opening a socket must not stall the beat. */
  private applyPairingRequest(): void {
    if (this.stopping) return;
    const action = decideOnHeartbeat({
      paired: this.paired,
      socketActive: Boolean(this.sock) || this.connecting,
      reconnectPending: this.reconnectTimer !== null,
      socketPhone: this.socketPhone,
      request: this.request,
    });
    switch (action.kind) {
      case 'connect':
        void this.connect();
        return;
      case 'close':
        logger.info('the pairing request lapsed; closing the registration socket');
        void this.goIdle();
        return;
      case 'restart':
        logger.info('the pairing mode changed; reopening the registration socket');
        this.restartPairing();
        return;
      case 'none':
        return;
    }
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
   * Digits of every way WhatsApp writes this account: with a device suffix, as
   * a plain JID, and as a `@lid` in newer versions.
   */
  private selfJids(): string[] {
    const user = this.sock?.user;
    return [user?.id, (user as { lid?: string } | undefined)?.lid].filter(
      (jid): jid is string => typeof jid === 'string' && jid.length > 0,
    );
  }

  /**
   * A CHEAP PRE-FILTER, not the decision.
   *
   * The real rule — what counts as being spoken to, and why the bare name in
   * text does not — lives in `whatsapp/mentions.ts` in agent-tools, and Cortex
   * applies it again on every request. This only avoids a round trip for the
   * overwhelming majority of group messages that mention nobody. If the two
   * ever disagree, Cortex wins and stays quiet, which is the safe direction.
   */
  private looksAddressedToUs(mentionedJids: string[], quotedAuthorJid: string | null): boolean {
    const self = new Set(
      this.selfJids().map((jid) => jid.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') ?? ''),
    );
    self.delete('');
    if (self.size === 0) return false;
    const digits = (jid: string | null | undefined): string =>
      jid?.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') ?? '';
    if (mentionedJids.some((jid) => self.has(digits(jid)))) return true;
    return self.has(digits(quotedAuthorJid));
  }

  /** The rolling context a mention arrives with. Memory only, never written. */
  private rememberForContext(jid: string, line: GroupContextLine): void {
    if (!this.replyGroups.has(jid)) return;
    const buffer = this.recent.get(jid) ?? [];
    buffer.push(line);
    // Bounded twice over: the tail is all that is ever sent, and an idle group
    // must not hold a day of conversation in the heap.
    if (buffer.length > 60) buffer.splice(0, buffer.length - 60);
    this.recent.set(jid, buffer);
  }

  /**
   * TWO INDEPENDENT PERMISSIONS, checked separately, in one place.
   *
   * `allowed` is archiving: a message from a group that is not on that list is
   * dropped here, in memory, on the Railway container — it never crosses the
   * network, never reaches Cortex, never touches the database. The second lock
   * is in the ingest route, which checks the database again, so a bridge
   * running a stale allow-list still cannot archive anything nobody chose.
   *
   * `replyGroups` is answering, and it grants nothing to archiving. A group can
   * be on either list, both, or neither. A reply-only group's messages are held
   * in memory for context and are never sent anywhere unless somebody mentions
   * Cortex — and even then only the recent window travels, for one turn.
   */
  private async onGroupMessage(raw: Parameters<typeof extractGroupMessage>[0]): Promise<void> {
    const jid = raw.key?.remoteJid ?? '';
    const archiveFrom = this.allowed.get(jid);
    const canReply = this.replyGroups.has(jid);
    if (archiveFrom === undefined && !canReply) return;

    const extracted = extractGroupMessage(raw);
    if (!extracted) return;

    if (canReply) {
      const body = extracted.body ?? '';
      if (body.trim()) {
        this.rememberForContext(jid, {
          senderName: extracted.senderName,
          senderJid: extracted.senderJid,
          sentAt: extracted.sentAt,
          text: body,
        });
      }
      // Fire and forget: answering must not hold up archiving the same message.
      void this.maybeAnswerMention(raw, extracted);
    }

    if (archiveFrom === undefined) return;
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
  // Answering in a group
  // -------------------------------------------------------------------------

  /**
   * Somebody may have spoken to Cortex in a group.
   *
   * WHAT THIS ACCOUNT WILL DO IN A GROUP, COMPLETE: reply once to a message
   * that mentioned it. That is the whole list. It does not greet, does not
   * announce itself, does not follow up, does not react and does not speak
   * because a keyword appeared. Writing in groups is a bigger signal to
   * WhatsApp than reading, and the only thing that makes it defensible is that
   * every message is a direct answer to somebody who asked for it by tapping
   * the name.
   *
   * The reply QUOTES the mention, so in a busy room it is obvious what is being
   * answered and Cortex never appears to be interjecting.
   */
  private async maybeAnswerMention(
    raw: Parameters<typeof extractGroupMessage>[0],
    extracted: NonNullable<ReturnType<typeof extractGroupMessage>>,
  ): Promise<void> {
    const sock = this.sock;
    const jid = raw.key?.remoteJid;
    if (!sock || !jid) return;

    const signals = extractMentionSignals(raw);
    if (!this.looksAddressedToUs(signals.mentionedJids, signals.quotedAuthorJid)) return;

    let typing: NodeJS.Timeout | null = null;
    try {
      await sock.sendPresenceUpdate('composing', jid).catch(() => undefined);
      typing = setInterval(() => {
        void sock.sendPresenceUpdate('composing', jid).catch(() => undefined);
      }, 5_000);

      const answer = await this.cortex.answerMention({
        groupJid: jid,
        messageId: extracted.messageId,
        senderJid: extracted.senderJid,
        senderName: extracted.senderName,
        text: extracted.body ?? '',
        mentionedJids: signals.mentionedJids,
        quotedAuthorJid: signals.quotedAuthorJid,
        selfJids: this.selfJids(),
        // Everything except this message, which Cortex receives as the question.
        recent: (this.recent.get(jid) ?? []).filter((line) => line.sentAt !== extracted.sentAt),
      });

      if (typing) clearInterval(typing);
      typing = null;
      await sock.sendPresenceUpdate('paused', jid).catch(() => undefined);

      // Null is the ordinary answer, not a failure: a duplicate delivery, a
      // sender who has already been told, a group that has had enough this
      // hour, or a mention Cortex decided was not one. Silence is correct for
      // every single one of those, and a bot explaining its own silence is the
      // noise this is trying to avoid.
      if (!answer?.reply) return;

      if (answer.delayMs) await sleep(Math.min(answer.delayMs, 6_000));
      await sock.sendMessage(jid, { text: answer.reply }, { quoted: raw });

      // The half that had to stay out of the room. Sent only to a chat the
      // person has already opened with this number — Cortex answering privately
      // is still Cortex answering, never Cortex starting a conversation. When
      // there is no such chat, Cortex has already emailed it instead.
      if (answer.dm?.jid && answer.dm.text) {
        await sleep(600);
        await sock.sendMessage(answer.dm.jid, { text: answer.dm.text }).catch(() => undefined);
      }
    } catch (err) {
      // Silence on failure. In a 1:1 an apology is right because somebody is
      // waiting on it; in a group it is one more message nobody wanted.
      logger.error({ err: (err as Error).message }, 'could not answer a group mention');
    } finally {
      if (typing) clearInterval(typing);
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

  // -------------------------------------------------------------------------
  // Respuestas de una persona (Cortex 0185)
  // -------------------------------------------------------------------------

  /**
   * Manda, como respuesta en su conversación, lo que una persona escribió desde
   * Cortex. Con «escribiendo…» y pausas, de a una, y le dice a Cortex qué salió.
   * Si una tanda sigue en curso, la nueva se ignora: Cortex la vuelve a ofrecer
   * cuando su reclamo caduca (2 min) y el acuse evita mandarla dos veces.
   */
  private async deliverOutbox(items: OutboxMessage[]): Promise<void> {
    if (this.deliveringOutbox || this.status !== 'connected') return;
    this.deliveringOutbox = true;
    try {
      for (const [index, item] of items.entries()) {
        const sock = this.sock;
        if (!sock || this.status !== 'connected') return;
        let ok = false;
        try {
          if (index > 0) await sleep(gapMs());
          await sock.sendPresenceUpdate('composing', item.jid).catch(() => undefined);
          await sleep(typingMs(item.text));
          await sock.sendPresenceUpdate('paused', item.jid).catch(() => undefined);
          await sock.sendMessage(item.jid, { text: item.text });
          ok = true;
        } catch (err) {
          logger.error({ err: (err as Error).message }, 'could not deliver a person reply');
        }
        await this.cortex.ackOutbox({ id: item.id, ok });
      }
    } finally {
      this.deliveringOutbox = false;
    }
  }
}
