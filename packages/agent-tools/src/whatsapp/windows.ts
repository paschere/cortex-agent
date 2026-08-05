/**
 * Turning a stream of WhatsApp messages into things that can be documents.
 *
 * THE PROBLEM, STATED PRECISELY. A message is not a document. An active
 * dispatch group emits eight hundred messages a day, most of them under five
 * words — "listo", "ya salió", "confirmo con el cliente". Indexing each one
 * costs an embedding and buys a fragment that retrieves as an anonymous
 * assertion with no context. Indexing all of them together as "Tuesday" buys a
 * document covering six unrelated incidents, too diluted to match anything well
 * and useless to cite. Neither is retrievable months later, which is the only
 * thing this feature exists for.
 *
 * THE FOUR CANDIDATES, AND WHY THIS ONE.
 *
 *   Per message   — see above. Rejected.
 *
 *   Per day       — a real unit for a quiet group and a garbage bag for a busy
 *                   one, which is exactly backwards: the busy groups are the
 *                   ones worth remembering. Rejected as the primary rule, kept
 *                   as a ceiling (see `dayBoundary` below).
 *
 *   Per thread    — WhatsApp has no threads. It has quoted replies, and in a
 *                   real operations group the quote graph is a scattering of
 *                   disconnected pairs: most messages quote nothing and the
 *                   ones that do quote across topics. There is no tree to walk.
 *                   Rejected as unavailable, not as undesirable.
 *
 *   Per conversation window — what this module implements. A window opens with
 *                   a message and closes after `idleGapMinutes` of silence.
 *
 * WHY THE WINDOW IS RIGHT. A WhatsApp group does not converse continuously; it
 * bursts. Something happens — a truck is late, a client complains, a container
 * clears customs — twenty messages fly in eleven minutes, and then the group is
 * silent for four hours. The silence is not an absence of signal, it is the end
 * of the episode. So the window is not an arbitrary bucket: it is the episode,
 * and the episode is the thing somebody will look for. "Qué pasó con el
 * despacho de Acme el martes" should return one document that is that
 * conversation, opening with a header that says which group, which day, and who
 * was in it — and that is what a window produces.
 *
 * THE TWO CEILINGS. A window closes early on a calendar-day boundary in the
 * workspace's timezone (a conversation that runs past midnight is two days'
 * work, and a citation that says "the 3rd" should mean the 3rd), and on a hard
 * duration cap, so a group that genuinely never goes quiet — a monitoring feed,
 * a channel with a bot in it — still produces bounded documents instead of one
 * that grows forever.
 *
 * WHY THE KEY IS THE START INSTANT. `window_key` is the window's first message
 * to the minute, in UTC. Planning is a pure function of the messages, so the
 * same set always yields the same boundaries and therefore the same key: a
 * re-plan after new messages arrive updates the window it already ingested
 * rather than making a second one. The one case that key alone does not cover —
 * a message arriving that is OLDER than a window's current start, which shifts
 * the boundary — is handled a level up, in `ingest-window.ts`, by matching the
 * ledger on time range rather than on key.
 *
 * This module is pure: no database, no clock of its own, no I/O. Everything it
 * decides is decided from its arguments, which is what makes the grouping rule
 * testable without a WhatsApp account.
 */

/** What a staged message is, as far as grouping is concerned. */
export type WhatsappMessageKind =
  | 'text'
  | 'voice'
  | 'image'
  | 'video'
  | 'document'
  | 'location'
  | 'contact'
  | 'other';

export interface StagedMessage {
  /** Our row id, so the caller can stamp the window back onto it. */
  id: string;
  /** WhatsApp's own message id — the idempotency key for delivery. */
  messageId: string;
  senderJid: string | null;
  /** The push name everybody in the group already sees. */
  senderName: string | null;
  /** ISO-8601. */
  sentAt: string;
  body: string | null;
  kind: WhatsappMessageKind;
  /** Deepgram's text for a voice note. */
  transcript: string | null;
  mediaFilename: string | null;
  /** Set when an attachment became its own Brain Knowledge document. */
  attachmentDocumentId: string | null;
}

export interface ConversationWindow {
  /** ISO-8601 UTC of the first message, to the minute. Stable and unique. */
  key: string;
  startMs: number;
  endMs: number;
  messages: StagedMessage[];
  /** Display names, in first-heard order. */
  participants: string[];
}

export interface PlanWindowsOptions {
  /**
   * Silence that ends an episode. Forty-five minutes is long enough to survive
   * a group going quiet while somebody drives across town or checks with a
   * client, and short enough that the morning's dispatch and the afternoon's
   * incident do not end up in the same document.
   */
  idleGapMinutes?: number;
  /** Ceiling on a single window, for groups that never go quiet. */
  maxWindowHours?: number;
  /** Calendar-day boundaries are read in this zone. */
  timeZone?: string;
  /** "Now", supplied rather than read, so tests are not time-dependent. */
  nowMs: number;
}

export interface PlannedWindows {
  /**
   * Windows that will not grow any more: either a later message broke them, or
   * the group has been silent past the idle gap. These are safe to ingest.
   */
  closed: ConversationWindow[];
  /**
   * The trailing window, if the group is still talking. Deliberately NOT
   * ingested: writing a document for a conversation that is still happening
   * means rewriting it every few minutes, and every rewrite re-embeds the whole
   * thing.
   */
  open: ConversationWindow | null;
}

export const DEFAULT_IDLE_GAP_MINUTES = 45;
export const DEFAULT_MAX_WINDOW_HOURS = 8;
/** Where the company is. Day boundaries mean nothing without a place. */
export const DEFAULT_TIME_ZONE = 'America/Bogota';

/**
 * The local calendar day of an instant, as `YYYY-MM-DD`.
 *
 * Uses `Intl` rather than arithmetic on a fixed offset because Colombia does
 * not observe DST but the deployments this runs in are not promised to stay
 * Colombian, and an offset baked in here would be wrong somewhere else silently.
 */
export function localDay(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ms));
  } catch {
    // An unknown zone must not stop a group being archived; UTC days are still
    // days, they just sit six hours off from the people who lived them.
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * How a person is named inside the document.
 *
 * The push name when WhatsApp gives one — that is the name every other member
 * of the group already sees next to the message, so using it discloses nothing
 * to the archive that the conversation did not already disclose to the room.
 *
 * When there is no name, the number is MASKED to its last four digits. A group
 * routinely contains clients, suppliers and drivers who never agreed to be in a
 * company knowledge base; their full number is contact information and does not
 * belong in an indexed, searchable, quotable document. The complete JID stays on
 * the `whatsapp_messages` row, where it is operational data an admin can reach,
 * rather than in text the agent will read back out loud.
 */
export function displayName(message: Pick<StagedMessage, 'senderName' | 'senderJid'>): string {
  const name = message.senderName?.trim();
  if (name) return name;

  const user = (message.senderJid ?? '').split('@')[0]?.replace(/\D/g, '') ?? '';
  if (user.length >= 4) return `+${user.slice(0, 2)} ···${user.slice(-4)}`;
  return 'Unknown participant';
}

/**
 * The line a message contributes to the transcript.
 *
 * Non-text messages become a short marker rather than being dropped. A silent
 * omission would misrepresent the conversation — "mandé la factura" followed by
 * nothing reads as an unanswered request when in fact the invoice is right
 * there — and the marker is what makes the caption searchable.
 *
 * Markers are in English to match the meeting and audio documents already in
 * Brain Knowledge (`import-transcript.ts`), so one corpus does not speak two
 * languages in its scaffolding. The conversation itself is untouched.
 */
export function renderMessageText(message: StagedMessage): string {
  const caption = (message.body ?? '').trim();

  switch (message.kind) {
    case 'voice': {
      const said = message.transcript?.trim();
      // The 🎤 is not decoration: it survives into the chunk text, so a reader
      // (and the model quoting it) can tell a transcribed voice note from
      // something that was typed, which changes how literally to take it.
      return said ? `🎤 ${said}` : '[voice note — not transcribed]';
    }
    case 'image':
      return caption ? `[image] ${caption}` : '[image]';
    case 'video':
      return caption ? `[video] ${caption}` : '[video]';
    case 'document': {
      const name = message.mediaFilename?.trim() || 'file';
      const filed = message.attachmentDocumentId
        ? ' — saved to Brain Knowledge as its own document'
        : '';
      return caption ? `[file: ${name}]${filed} ${caption}` : `[file: ${name}]${filed}`;
    }
    case 'location':
      return caption ? `[location] ${caption}` : '[location shared]';
    case 'contact':
      return caption ? `[contact] ${caption}` : '[contact shared]';
    default:
      return caption;
  }
}

/** ISO to the minute — the window key, and how a window is identified anywhere. */
export function windowKeyOf(startMs: number): string {
  return `${new Date(startMs).toISOString().slice(0, 16)}Z`;
}

function finish(messages: StagedMessage[]): ConversationWindow {
  const startMs = Date.parse(messages[0]?.sentAt ?? '');
  const endMs = Date.parse(messages[messages.length - 1]?.sentAt ?? '');
  const participants: string[] = [];
  for (const m of messages) {
    const who = displayName(m);
    if (!participants.includes(who)) participants.push(who);
  }
  return {
    key: windowKeyOf(startMs),
    startMs,
    endMs: Math.max(endMs, startMs),
    messages,
    participants,
  };
}

/**
 * Group a group's messages into conversation windows.
 *
 * Messages may arrive in any order; they are sorted here, because Baileys
 * replays history out of order after a reconnect and a window planned from an
 * unsorted list would be nonsense in a way nothing downstream could detect.
 */
export function planWindows(messages: StagedMessage[], opts: PlanWindowsOptions): PlannedWindows {
  const idleGapMs = (opts.idleGapMinutes ?? DEFAULT_IDLE_GAP_MINUTES) * 60_000;
  const maxWindowMs = (opts.maxWindowHours ?? DEFAULT_MAX_WINDOW_HOURS) * 3_600_000;
  const timeZone = opts.timeZone ?? DEFAULT_TIME_ZONE;

  const ordered = messages
    .filter((m) => Number.isFinite(Date.parse(m.sentAt)))
    .sort((a, b) => {
      const delta = Date.parse(a.sentAt) - Date.parse(b.sentAt);
      // A stable tie-break on the WhatsApp id: two messages in the same second
      // are common, and an unstable sort would re-order them between plans and
      // change the document's sha256 for no reason.
      return delta !== 0 ? delta : a.messageId.localeCompare(b.messageId);
    });

  if (ordered.length === 0) return { closed: [], open: null };

  const windows: StagedMessage[][] = [];
  let current: StagedMessage[] = [];

  for (const message of ordered) {
    if (current.length === 0) {
      current = [message];
      continue;
    }

    const previous = current[current.length - 1] as StagedMessage;
    const startMs = Date.parse((current[0] as StagedMessage).sentAt);
    const atMs = Date.parse(message.sentAt);

    const wentQuiet = atMs - Date.parse(previous.sentAt) >= idleGapMs;
    const tooLong = atMs - startMs >= maxWindowMs;
    const newDay = localDay(atMs, timeZone) !== localDay(startMs, timeZone);

    if (wentQuiet || tooLong || newDay) {
      windows.push(current);
      current = [message];
    } else {
      current.push(message);
    }
  }
  if (current.length > 0) windows.push(current);

  // The last window is only finished if the group has since gone quiet for
  // longer than the gap. Anything else is a conversation still in progress.
  const last = windows[windows.length - 1] as StagedMessage[];
  const lastMs = Date.parse((last[last.length - 1] as StagedMessage).sentAt);
  const stillTalking = opts.nowMs - lastMs < idleGapMs;

  const closedRaw = stillTalking ? windows.slice(0, -1) : windows;
  return {
    closed: closedRaw.map(finish),
    open: stillTalking ? finish(last) : null,
  };
}
