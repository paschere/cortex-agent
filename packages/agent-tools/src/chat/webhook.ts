import { ValidationError } from '@cortex/core';
import { isPrivateUrl } from '../external-mcp';

/**
 * Google Chat delivery primitives.
 *
 * Delivery goes through an INCOMING WEBHOOK the person creates inside their own
 * space (Space → Apps & integrations → Webhooks → Add webhook). That choice is
 * deliberate: no extra OAuth scope, no Chat app to install, no admin approval —
 * and the blast radius of the credential is exactly one space the user already
 * belongs to.
 *
 * The flip side is that a webhook URL is a bearer credential embedded in a URL
 * we POST to, which is an SSRF-adjacent surface: whatever string we accept, we
 * will send content to. So the guard here is an ALLOW-LIST, not a block-list —
 * `https://chat.googleapis.com/v1/spaces/...` and nothing else.
 *
 * The OTHER Chat path lives in `./service-account.ts` + `./send-dm.ts`: posting
 * as the Cortex Chat app to someone's private DM thread. `flattenMarkdownForChat`
 * below is shared by both — Chat's markdown subset does not care how the message
 * was authenticated. That module is itself a deliberate copy of
 * `apps/web/lib/google-chat.ts`; see its header for why.
 */

/** The only host we will ever POST a webhook message to. */
export const GOOGLE_CHAT_WEBHOOK_HOST = 'chat.googleapis.com';

/** Google Chat rejects text messages above 4096 characters. */
export const CHAT_TEXT_LIMIT = 4096;

export interface ChatWebhookTarget {
  /** The validated URL, safe to fetch. Never surface it back to a model/user. */
  url: string;
  /** `spaces/AAAA1111` — safe to show, identifies the destination. */
  space: string;
}

/**
 * Validate a Google Chat incoming-webhook URL and extract the space it targets.
 * Throws ValidationError with a plain-language reason — this message is shown
 * to the person pasting the URL into settings.
 */
export function parseChatWebhookUrl(raw: string): ChatWebhookTarget {
  const trimmed = raw.trim();
  if (!trimmed) throw new ValidationError('The Google Chat webhook URL is empty.');

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ValidationError('That is not a valid URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new ValidationError('The Google Chat webhook URL must start with https://.');
  }
  if (parsed.username || parsed.password) {
    throw new ValidationError('The webhook URL must not contain a username or password.');
  }
  if (parsed.hostname.toLowerCase() !== GOOGLE_CHAT_WEBHOOK_HOST) {
    throw new ValidationError(
      `Only Google Chat webhooks are accepted — the URL must be on ${GOOGLE_CHAT_WEBHOOK_HOST}. Copy it from the space: Apps & integrations → Webhooks.`,
    );
  }
  // Defence in depth: the host pin above already settles it, but if that check
  // ever loosens, the private-range guard is still standing.
  if (isPrivateUrl(trimmed)) {
    throw new ValidationError('That URL is not allowed.');
  }

  const match = parsed.pathname.match(/^\/v1\/(spaces\/[A-Za-z0-9_-]+)\/messages$/);
  if (!match?.[1]) {
    throw new ValidationError(
      'That does not look like a Google Chat webhook. The URL should look like ' +
        'https://chat.googleapis.com/v1/spaces/XXXX/messages?key=…&token=…',
    );
  }
  if (!parsed.searchParams.get('key') || !parsed.searchParams.get('token')) {
    throw new ValidationError(
      'The webhook URL is missing its key/token — copy the whole URL, including everything after the "?".',
    );
  }

  return { url: parsed.toString(), space: match[1] };
}

/** Non-throwing form, for UI validation and route guards. */
export function isGoogleChatWebhookUrl(raw: string): boolean {
  try {
    parseChatWebhookUrl(raw);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Markdown → Google Chat text
// ---------------------------------------------------------------------------

/**
 * Google Chat's text messages support a small markdown subset: `*bold*`,
 * `_italic_`, `~strike~`, `` `code` `` and `<url|label>` links. No headings, no
 * tables, no nested lists, and DOUBLE asterisks render literally.
 *
 * Everything Cortex produces is ordinary markdown, so this flattens it into that
 * subset instead of letting reports arrive full of `##` and pipe characters.
 */
export function flattenMarkdownForChat(markdown: string, limit = CHAT_TEXT_LIMIT): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  // Tables are handled as a block: collect consecutive `|`-rows, then render.
  let table: string[] = [];
  const flushTable = () => {
    if (table.length === 0) return;
    out.push(...renderTable(table));
    table = [];
  };

  for (const line of lines) {
    if (isTableRow(line)) {
      table.push(line);
      continue;
    }
    flushTable();

    const trimmed = line.trim();

    // Horizontal rules add nothing in a chat message.
    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      out.push('');
      continue;
    }

    // Headings become bold lines; the top level gets a blank line above it.
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const text = inlineToChat(heading[2] ?? '');
      if (level <= 2 && out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(`*${text}*`);
      continue;
    }

    // Bullets: one bullet glyph, indentation preserved as spaces.
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const indent = ' '.repeat(Math.min((bullet[1] ?? '').length, 8));
      out.push(`${indent}• ${inlineToChat(bullet[2] ?? '')}`);
      continue;
    }

    // Numbered lists keep their numbers.
    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      const indent = ' '.repeat(Math.min((numbered[1] ?? '').length, 8));
      out.push(`${indent}${numbered[2]}. ${inlineToChat(numbered[3] ?? '')}`);
      continue;
    }

    // Blockquotes lose the marker — Chat has no quote styling.
    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      out.push(inlineToChat(quote[1] ?? ''));
      continue;
    }

    out.push(trimmed ? inlineToChat(trimmed) : '');
  }
  flushTable();

  // Collapse runs of blank lines; Chat renders each one.
  const collapsed: string[] = [];
  for (const line of out) {
    if (line === '' && collapsed[collapsed.length - 1] === '') continue;
    collapsed.push(line);
  }
  const text = collapsed.join('\n').trim();
  return text.length > limit ? `${text.slice(0, limit - 2)} …` : text;
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|') && t.length > 2;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

const SEPARATOR_CELL = /^:?-{2,}:?$/;

/**
 * A markdown table becomes one bullet per row: the first column is the label,
 * the remaining columns are `header: value` pairs. Chat has no monospace block
 * wide enough to keep a real table readable on a phone, and aligned text wraps
 * into noise — bullets survive every client.
 */
function renderTable(rows: string[]): string[] {
  const cells = rows.map(splitRow);
  const headerIdx = cells.findIndex((_, i) => cells[i + 1]?.every((c) => SEPARATOR_CELL.test(c)));
  const header = headerIdx >= 0 ? (cells[headerIdx] ?? []) : [];
  const body = cells.filter(
    (row, i) => i !== headerIdx && !row.every((c) => SEPARATOR_CELL.test(c)),
  );

  if (body.length === 0) return [];

  return body.map((row) => {
    const label = inlineToChat(row[0] ?? '');
    const rest = row
      .slice(1)
      .map((value, i) => {
        const key = header[i + 1];
        const v = inlineToChat(value);
        if (!v) return '';
        return key ? `${inlineToChat(key)}: ${v}` : v;
      })
      .filter(Boolean);
    return rest.length ? `• *${label}* — ${rest.join(' · ')}` : `• *${label}*`;
  });
}

/** Inline markdown → the Chat subset. */
function inlineToChat(s: string): string {
  return (
    s
      // links first, so their label can still carry emphasis
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
        label.trim() === url ? `<${url}>` : `<${url}|${label.trim()}>`,
      )
      // bold+italic → bold (Chat has no combined form)
      .replace(/\*\*\*([^*]+)\*\*\*/g, '*$1*')
      // **bold** → *bold*
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      // __bold__ → *bold*
      .replace(/__([^_]+)__/g, '*$1*')
      .trim()
  );
}
