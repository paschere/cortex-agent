import type { DigestThread } from './gather';

/**
 * Rendering the digest for humans: a markdown version for chat/agent contexts
 * and an inline-styled HTML version for email, in the same house style as
 * `meetings.prepare_briefing` (no external CSS — mail clients strip it).
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline markdown → inline HTML: bold, italic, links. */
function inlineHtml(s: string): string {
  return escapeHtml(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" style="color:#2563eb;">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:)!?]|$)/g, '$1<em>$2</em>');
}

/**
 * Small block-level markdown → HTML. Handles what the digest prompt can
 * produce: headings, bullets, numbered lists and paragraphs. Anything else
 * degrades to a paragraph rather than leaking raw syntax into someone's inbox.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let listTag: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listTag) {
      out.push(`</${listTag}>`);
      listTag = null;
    }
  };
  const openList = (tag: 'ul' | 'ol') => {
    if (listTag === tag) return;
    closeList();
    out.push(`<${tag} style="margin:6px 0 12px;padding-left:20px;">`);
    listTag = tag;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1]?.length ?? 1;
      const text = inlineHtml(heading[2] ?? '');
      out.push(
        level <= 1
          ? `<h2 style="margin:22px 0 8px;font-size:17px;color:#111827;">${text}</h2>`
          : `<h3 style="margin:20px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#374151;">${text}</h3>`,
      );
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      closeList();
      out.push('<hr style="border:0;border-top:1px solid #e5e7eb;margin:20px 0;">');
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      openList('ul');
      out.push(`<li style="margin:0 0 6px;">${inlineHtml(bullet[1] ?? '')}</li>`);
      continue;
    }

    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (numbered) {
      openList('ol');
      out.push(`<li style="margin:0 0 6px;">${inlineHtml(numbered[1] ?? '')}</li>`);
      continue;
    }

    closeList();
    out.push(`<p style="margin:0 0 10px;">${inlineHtml(trimmed)}</p>`);
  }
  closeList();
  return out.join('');
}

/** "3h" / "2d 4h" — how long the other side has been waiting. */
export function humanAge(hours: number): string {
  if (hours < 1) return 'under an hour';
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours - days * 24);
  return rest > 0 ? `${days}d ${rest}h` : `${days}d`;
}

export interface DigestRenderInput {
  /** Wall-clock label for the day, in the user's zone. */
  dateLabel: string;
  /** The distilled digest produced server-side. */
  summaryMarkdown: string;
  needsYou: DigestThread[];
  waitingOnOthers: DigestThread[];
  windowHours: number;
  scanned: number;
  excludedNote: string;
  focus: string | null;
}

/** The whole digest as markdown — what chat delivery and the agent see. */
export function renderDigestMarkdown(input: DigestRenderInput): string {
  const lines = [
    `# Your inbox digest — ${input.dateLabel}`,
    '',
    `${input.needsYou.length} conversation${input.needsYou.length === 1 ? '' : 's'} waiting on you · ` +
      `${input.waitingOnOthers.length} waiting on someone else · last ${input.windowHours}h`,
    '',
    input.summaryMarkdown.trim(),
    '',
  ];

  if (input.needsYou.length > 0) {
    lines.push('## The threads themselves', '');
    for (const t of input.needsYou.slice(0, 12)) {
      lines.push(
        `- **${t.subject}** — ${t.lastFrom}, waiting ${humanAge(t.ageHours)} · [open](${t.permalink})`,
      );
    }
    lines.push('');
  }

  lines.push(
    '---',
    '',
    `_Scanned ${input.scanned} recent conversation${input.scanned === 1 ? '' : 's'} from your own mailbox. ${input.excludedNote}_`,
  );
  if (input.focus) lines.push('', `_Prioritized around: ${input.focus}_`);

  return lines.join('\n');
}

/** The same digest as a self-contained, inline-styled email body. */
export function renderDigestHtml(input: DigestRenderInput): string {
  const row = (t: DigestThread, tone: 'you' | 'them') => {
    const accent = tone === 'you' ? '#b45309' : '#6b7280';
    return [
      '<tr>',
      `<td style="padding:10px 0;border-bottom:1px solid #f0f1f3;">`,
      `<a href="${escapeHtml(t.permalink)}" style="color:#111827;font-weight:600;text-decoration:none;">${escapeHtml(t.subject)}</a>`,
      `<div style="margin-top:3px;font-size:12.5px;color:${accent};">${escapeHtml(t.lastFrom)} · ${escapeHtml(humanAge(t.ageHours))} ago · ${t.messageCount} message${t.messageCount === 1 ? '' : 's'}</div>`,
      '</td>',
      '</tr>',
    ].join('');
  };

  const section = (title: string, threads: DigestThread[], tone: 'you' | 'them', empty: string) =>
    [
      `<h3 style="margin:24px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#374151;">${escapeHtml(title)}</h3>`,
      threads.length === 0
        ? `<p style="margin:0 0 8px;font-size:13px;color:#9ca3af;">${escapeHtml(empty)}</p>`
        : `<table style="width:100%;border-collapse:collapse;">${threads
            .slice(0, 12)
            .map((t) => row(t, tone))
            .join('')}</table>`,
    ].join('');

  return [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f2328;max-width:640px;margin:0 auto;padding:24px;">',
    '<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;">Daily inbox digest</p>',
    `<h1 style="margin:0 0 4px;font-size:22px;line-height:1.3;color:#111827;">${escapeHtml(input.dateLabel)}</h1>`,
    `<p style="margin:0 0 18px;color:#6b7280;font-size:13.5px;">${input.needsYou.length} waiting on you · ${input.waitingOnOthers.length} waiting on someone else · last ${input.windowHours} hours</p>`,
    input.focus
      ? `<p style="margin:0 0 18px;padding:10px 12px;background:#f3f4f6;border-left:3px solid #2563eb;border-radius:4px;font-size:13.5px;"><strong>Prioritized around:</strong> ${escapeHtml(input.focus)}</p>`
      : '',
    markdownToHtml(input.summaryMarkdown),
    section('Waiting on you', input.needsYou, 'you', 'Nothing is waiting on a reply from you.'),
    section(
      'Waiting on someone else',
      input.waitingOnOthers,
      'them',
      'You are not blocked on anyone right now.',
    ),
    '<hr style="border:0;border-top:1px solid #e5e7eb;margin:26px 0 12px;">',
    `<p style="margin:0 0 6px;font-size:11.5px;color:#9ca3af;">Built by Zippy from your own mailbox — ${escapeHtml(
      String(input.scanned),
    )} recent conversations read and summarized on Zipdev's side. ${escapeHtml(input.excludedNote)}</p>`,
    '<p style="margin:0;font-size:11.5px;color:#9ca3af;">You asked for this digest in Settings, and you can turn it off there at any time.</p>',
    '</div>',
  ]
    .filter(Boolean)
    .join('');
}
