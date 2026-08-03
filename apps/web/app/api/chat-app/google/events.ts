/**
 * The shapes Google Chat POSTs to an HTTP-endpoint app, plus the pure helpers
 * that turn one into something we can act on.
 *
 * Kept free of I/O so the parsing rules (especially mention stripping, which
 * decides what text the model actually sees) stay obvious and testable.
 */

export type ChatEventType =
  | 'ADDED_TO_SPACE'
  | 'MESSAGE'
  | 'REMOVED_FROM_SPACE'
  | 'CARD_CLICKED'
  | (string & {});

export interface ChatUser {
  /** Google's stable id for the person: `users/1234567890`. */
  name?: string;
  displayName?: string;
  /** Present for users inside the Workspace domain. Our join key. */
  email?: string;
  type?: 'HUMAN' | 'BOT' | (string & {});
}

export interface ChatSpace {
  /** `spaces/AAAA1111` */
  name?: string;
  /** Legacy field: 'DM' | 'ROOM'. */
  type?: string;
  /** Newer field: 'DIRECT_MESSAGE' | 'SPACE' | 'GROUP_CHAT'. */
  spaceType?: string;
  displayName?: string;
  singleUserBotDm?: boolean;
}

export interface ChatAnnotation {
  type?: 'USER_MENTION' | 'SLASH_COMMAND' | (string & {});
  startIndex?: number;
  length?: number;
  userMention?: { user?: ChatUser; type?: 'ADD' | 'MENTION' | (string & {}) };
  slashCommand?: { commandId?: string; commandName?: string; bot?: ChatUser };
}

export interface ChatMessageBody {
  name?: string;
  sender?: ChatUser;
  /** Raw text INCLUDING the `@Cortex` mention and any slash command. */
  text?: string;
  /** Google's own mention/command-stripped version. Not always present. */
  argumentText?: string;
  thread?: { name?: string; threadKey?: string };
  annotations?: ChatAnnotation[];
  slashCommand?: { commandId?: string };
}

/**
 * The newer shape of an interaction payload: `commonEventObject` on a Workspace
 * add-on, `common` on a plain Chat app. Parameters arrive as a plain map.
 */
export interface ChatCommonEvent {
  /** The `onClick.action.function` name from the button that was pressed. */
  invokedFunction?: string;
  parameters?: Record<string, unknown>;
}

/** The older shape, still sent alongside the newer one. Parameters are a list. */
export interface ChatActionEvent {
  actionMethodName?: string;
  parameters?: Array<{ key?: string; value?: string }>;
}

export interface ChatEvent {
  type?: ChatEventType;
  eventTime?: string;
  space?: ChatSpace;
  message?: ChatMessageBody;
  /** The acting user — the adder on ADDED_TO_SPACE, the clicker on CARD_CLICKED. */
  user?: ChatUser;
  common?: ChatCommonEvent;
  action?: ChatActionEvent;
}

/**
 * The parameters a clicked button carried.
 *
 * Google sends these in two places at once and has been migrating between them
 * for years: `action.parameters` (a list of {key, value}) is the original, and
 * `common.parameters` / `commonEventObject.parameters` (a map) is what add-on
 * invocations use. Which one is populated depends on the envelope, so both are
 * read and the map wins — an approval button that silently loses its id is a
 * button that does nothing, with no error anywhere.
 *
 * Values are forced to strings and nothing is trusted: the id read out of here
 * is only ever a lookup key, never an authorisation.
 */
export function readActionParameters(event: ChatEvent): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of event.action?.parameters ?? []) {
    if (entry?.key && typeof entry.value === 'string') out[entry.key] = entry.value;
  }
  for (const [key, value] of Object.entries(event.common?.parameters ?? {})) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

/** Which button's handler was invoked, whichever field carries it. */
export function invokedFunctionOf(event: ChatEvent): string {
  return event.common?.invokedFunction ?? event.action?.actionMethodName ?? '';
}

/**
 * Where the answer would land if we replied in place.
 *
 *  - 'dm'    — a 1:1 with the app. Only the sender can read it.
 *  - 'space' — a room or group chat. Everything posted is a BROADCAST, which is
 *              why the privacy guard in turn.ts exists.
 */
export type ChatAudience = 'dm' | 'space';

export function audienceOf(space: ChatSpace | undefined): ChatAudience {
  const legacy = (space?.type ?? '').toUpperCase();
  const modern = (space?.spaceType ?? '').toUpperCase();
  if (legacy === 'DM' || modern === 'DIRECT_MESSAGE') return 'dm';
  return 'space';
}

/** `spaces/X/threads/Y` → `Y`; anything unexpected → null. */
export function threadIdOf(threadName: string | undefined): string | null {
  const match = /\/threads\/([^/]+)$/.exec(threadName ?? '');
  return match?.[1] ?? null;
}

/**
 * The conversation key this message belongs to.
 *
 * A DM is one continuous conversation with the app, so the whole space is the
 * key. A space thread is its own topic — and its own audience — so each thread
 * gets its own conversation row. Both live under `conversations.external_key`
 * next to `mcp:<session>`, which is what makes Chat history show up in Zipdev
 * OS like every other surface.
 */
export function conversationKey(
  space: string,
  audience: ChatAudience,
  threadName: string | undefined,
): string {
  if (audience === 'dm') return `gchat:${space}`;
  const thread = threadIdOf(threadName);
  return thread ? `gchat:${space}/${thread}` : `gchat:${space}`;
}

export type ChatSlashCommand = 'ask' | 'brief' | 'report';

const SLASH_RE = /(?:^|\s)\/(ask|brief|report)\b/i;

/**
 * Slash commands are configured in the Chat app console and arrive as ordinary
 * messages with a SLASH_COMMAND annotation. They are pure sugar here: a plain
 * @mention must always work, so an unrecognised command is simply treated as
 * text.
 */
export function detectSlashCommand(message: ChatMessageBody | undefined): ChatSlashCommand | null {
  const head = (message?.text ?? '').slice(0, 80);
  const match = SLASH_RE.exec(head);
  return match?.[1] ? (match[1].toLowerCase() as ChatSlashCommand) : null;
}

/** Extra instruction folded into the prompt for each supported command. */
export const SLASH_DIRECTIVES: Record<ChatSlashCommand, string> = {
  ask: '',
  brief: 'Answer as a short briefing: three bullets maximum, numbers first, no preamble.',
  report:
    'Answer as a structured report: a one-line verdict, then the supporting numbers, then risks. Keep it under 15 lines.',
};

/**
 * The text the model should actually see.
 *
 * In a space, Chat only delivers a MESSAGE event when the app is @mentioned,
 * and `text` then begins with the mention ("@Cortex what's the pipeline?").
 * Feeding that to the model verbatim wastes tokens and confuses it, and a
 * regex on the display name breaks the moment someone renames the app or
 * another user's name contains it.
 *
 * So we cut by ANNOTATION: Chat tells us the exact [startIndex, length) of every
 * mention and slash command. We remove bot mentions and slash commands
 * right-to-left (so earlier offsets stay valid), sanity-check that what we are
 * about to delete really starts with `@` or `/`, and fall back to Google's own
 * `argumentText` if anything looks off.
 */
export function extractUserText(message: ChatMessageBody | undefined): string {
  const raw = message?.text ?? '';
  const annotations = message?.annotations ?? [];

  const removable = annotations.filter(
    (a) =>
      typeof a.startIndex === 'number' &&
      typeof a.length === 'number' &&
      a.length > 0 &&
      ((a.type === 'USER_MENTION' && a.userMention?.user?.type === 'BOT') ||
        a.type === 'SLASH_COMMAND'),
  );

  if (raw && removable.length > 0) {
    const ordered = [...removable].sort((a, b) => (b.startIndex ?? 0) - (a.startIndex ?? 0));
    let out = raw;
    let clean = true;
    for (const a of ordered) {
      const start = a.startIndex ?? 0;
      const end = start + (a.length ?? 0);
      if (start < 0 || end > out.length) {
        clean = false;
        break;
      }
      const slice = out.slice(start, end);
      // Indices are reported over the plain-text body; if they don't land on a
      // mention/command the message contains something we don't model (an
      // astral-plane emoji shifting offsets, say) — bail out to argumentText.
      if (!slice.startsWith('@') && !slice.startsWith('/')) {
        clean = false;
        break;
      }
      out = out.slice(0, start) + out.slice(end);
    }
    if (clean) return collapse(out);
  }

  if (message?.argumentText) return collapse(message.argumentText);
  // Last resort: drop a leading slash command so `/brief sales` doesn't reach
  // the model as a literal command.
  return collapse(raw.replace(/^\s*\/(ask|brief|report)\b/i, ''));
}

function collapse(s: string): string {
  // Chat pads mentions with non-breaking spaces; deleting the mention leaves
  // them behind as invisible junk at the front of the prompt.
  return s
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
