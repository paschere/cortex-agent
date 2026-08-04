import type { DigestThread } from './gather';

/**
 * Rendering the digest for humans: a markdown version for chat/agent contexts
 * and a complete, inline-styled HTML email.
 *
 * ---------------------------------------------------------------------------
 * SOURCE OF TRUTH: `apps/web/lib/email-templates/` (theme.ts, markdown.ts,
 * components.ts, layout.ts). The tokens and the markdown→HTML rules below are a
 * deliberate MIRROR of that design system, not an import.
 *
 * Why mirrored and not shared: this package is a leaf that `apps/web` depends
 * on (and that also runs inside the MCP server and vitest, with no Next.js and
 * no bundler aliases). Importing `apps/web/lib/...` from here would invert the
 * dependency direction and drag `server-only` app code into a plain Node
 * package — the one thing we must not do. The alternative, a third shared
 * package, is a bigger change than one screen of duplicated CSS constants
 * justifies. So: change `apps/web/lib/email-templates/theme.ts` first, then
 * carry the change here.
 * ---------------------------------------------------------------------------
 */

// --- Design tokens (mirror of apps/web/lib/email-templates/theme.ts) --------

const C = {
  primary: '#7E4390',
  primarySoft: '#9658A3',
  ink: '#241A2E',
  muted: '#5C4E68',
  faint: '#8A7C96',
  border: '#E6DDEE',
  surface: '#FAF8FC',
  card: '#ffffff',
  chip: '#F3EBF8',
  zebra: '#FBF9FD',
  warnFg: '#8A5A08',
  warnBg: '#FFF9EC',
  warnBorder: '#F3DDA8',
  infoFg: '#6B3480',
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',Courier,monospace";
// A mail client fetches the logo out of band, so it has to be an absolute URL
// on the deployment's own public origin rather than a site-relative path.
const cortexIconUrl = () => `${(process.env.APP_BASE_URL ?? '').replace(/\/+$/, '')}/icon.png`;

const S = {
  h2: `margin:26px 0 10px;font-family:${FONT};font-size:19px;line-height:1.3;font-weight:700;color:${C.ink};letter-spacing:-.01em;`,
  h3: `margin:22px 0 8px;font-family:${FONT};font-size:15px;line-height:1.35;font-weight:700;color:${C.primary};`,
  h4: `margin:18px 0 6px;font-family:${FONT};font-size:12px;line-height:1.4;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${C.muted};`,
  p: `margin:0 0 12px;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.ink};`,
  list: 'margin:0 0 14px;padding:0 0 0 22px;',
  li: `margin:0 0 7px;font-family:${FONT};font-size:15px;line-height:1.55;color:${C.ink};`,
  hr: `border:0;border-top:1px solid ${C.border};margin:22px 0;`,
  quote: `margin:0 0 14px;padding:10px 14px;background:${C.surface};border-left:3px solid ${C.primarySoft};color:${C.muted};font-family:${FONT};font-size:14.5px;line-height:1.55;`,
  pre: `margin:0 0 14px;padding:12px 14px;background:${C.surface};border:1px solid ${C.border};border-radius:8px;font-family:${MONO};font-size:12.5px;line-height:1.5;color:${C.ink};white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;`,
  code: `padding:1px 5px;background:${C.chip};border-radius:4px;font-family:${MONO};font-size:13px;color:${C.infoFg};word-break:break-word;`,
  link: `color:${C.primary};text-decoration:underline;`,
  table: `width:100%;border-collapse:collapse;margin:14px 0 20px;border:1px solid ${C.border};`,
  th: `padding:9px 12px;background:${C.chip};border-bottom:1px solid ${C.border};font-family:${FONT};font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${C.infoFg};word-break:break-word;overflow-wrap:anywhere;`,
  td: `padding:9px 12px;border-bottom:1px solid ${C.border};font-family:${FONT};font-size:13.5px;line-height:1.45;color:${C.ink};vertical-align:top;word-break:break-word;overflow-wrap:anywhere;`,
};

// --- Escaping ---------------------------------------------------------------

/** Every text node goes through this before any markup is layered on. */
export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!/^(https?:\/\/|mailto:|tel:)/i.test(trimmed)) return null;
  return escapeHtml(trimmed);
}

// --- Inline markdown --------------------------------------------------------

const CODE_OPEN = '\u0000c';
const CODE_CLOSE = '\u0000';

/** Inline markdown → inline HTML: code, links, bold, italic, strikethrough. */
function inlineHtml(raw: string): string {
  const spans: string[] = [];
  let s = escapeHtml(raw).replace(/`([^`]+?)`/g, (_m, code: string) => {
    spans.push(code);
    return `${CODE_OPEN}${spans.length - 1}${CODE_CLOSE}`;
  });

  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
    const safe = safeHref(href.replace(/&amp;/g, '&'));
    return safe ? `<a href="${safe}" style="${S.link}">${label}</a>` : match;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong style="font-weight:700;">$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:)!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

  return s.replace(
    new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, 'g'),
    (_m, i: string) => `<code style="${S.code}">${spans[Number(i)] ?? ''}</code>`,
  );
}

// --- Tables -----------------------------------------------------------------

type Align = 'left' | 'center' | 'right';

function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function parseDelimiter(line: string): Align[] | null {
  if (!line.includes('-') || !line.includes('|')) return null;
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const aligns: Align[] = [];
  for (const cell of cells) {
    if (!/^:?-{1,}:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : 'left');
  }
  return aligns;
}

function renderTable(header: string[], aligns: Align[], rows: string[][]): string {
  const width = Math.max(header.length, ...rows.map((r) => r.length), 1);
  const at = (i: number): Align => aligns[i] ?? 'left';
  const head = Array.from(
    { length: width },
    (_, i) =>
      `<th align="${at(i)}" style="${S.th}text-align:${at(i)};">${inlineHtml(header[i] ?? '')}</th>`,
  ).join('');
  const body = rows
    .map((row, rowIndex) => {
      const zebra = rowIndex % 2 === 1 ? `background-color:${C.zebra};` : '';
      const cells = Array.from({ length: width }, (_, i) => {
        const value = inlineHtml(row[i] ?? '');
        return `<td align="${at(i)}" style="${S.td}text-align:${at(i)};${zebra}">${value || '&nbsp;'}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return [
    '<div style="width:100%;overflow-x:auto;">',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${S.table}">`,
    `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`,
    '</table></div>',
  ].join('');
}

// --- Lists ------------------------------------------------------------------

interface ListItem {
  depth: number;
  ordered: boolean;
  text: string;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function renderList(items: ListItem[], start: number, depth: number): [string, number] {
  const ordered = items[start]?.ordered ?? false;
  const tag = ordered ? 'ol' : 'ul';
  const parts: string[] = [`<${tag} style="${S.list}">`];
  let i = start;
  while (i < items.length) {
    const item = items[i];
    if (!item || item.depth < depth) break;
    if (item.depth > depth) {
      const [nested, next] = renderList(items, i, item.depth);
      parts.push(nested);
      i = next;
      continue;
    }
    if (item.ordered !== ordered) break;
    parts.push(`<li style="${S.li}">${inlineHtml(item.text)}</li>`);
    i++;
  }
  parts.push(`</${tag}>`);
  return [parts.join(''), i];
}

// --- Block-level markdown ---------------------------------------------------

function isBlockStart(line: string): boolean {
  const t = line.trim();
  return (
    t === '' ||
    /^#{1,6}\s/.test(t) ||
    /^```/.test(t) ||
    /^>/.test(t) ||
    /^([-*_])\s*\1\s*\1[\s\-*_]*$/.test(t) ||
    LIST_RE.test(line) ||
    /^\|/.test(t)
  );
}

function convert(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i++;
      }
      i++;
      out.push(`<pre style="${S.pre}">${escapeHtml(body.join('\n'))}</pre>`);
      continue;
    }

    if (trimmed.startsWith('|')) {
      const aligns = parseDelimiter(lines[i + 1] ?? '');
      if (aligns) {
        const header = splitRow(trimmed);
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
          rows.push(splitRow(lines[i] ?? ''));
          i++;
        }
        out.push(renderTable(header, aligns, rows));
        continue;
      }
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const text = inlineHtml((heading[2] ?? '').replace(/\s*#+\s*$/, ''));
      const style = level <= 2 ? S.h2 : level === 3 ? S.h3 : S.h4;
      const tag = level <= 2 ? 'h2' : level === 3 ? 'h3' : 'h4';
      out.push(`<${tag} style="${style}">${text}</${tag}>`);
      i++;
      continue;
    }

    if (/^([-*_])\s*\1\s*\1[\s\-*_]*$/.test(trimmed)) {
      out.push(`<hr style="${S.hr}" />`);
      i++;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('>')) {
        body.push((lines[i] ?? '').trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote style="${S.quote}">${inlineHtml(body.join(' '))}</blockquote>`);
      continue;
    }

    if (LIST_RE.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length && LIST_RE.test(lines[i] ?? '')) {
        const m = (lines[i] ?? '').match(LIST_RE);
        if (!m) break;
        const indent = (m[1] ?? '').replace(/\t/g, '  ').length;
        items.push({
          depth: Math.min(Math.floor(indent / 2), 3),
          ordered: /\d/.test(m[2] ?? ''),
          text: m[3] ?? '',
        });
        i++;
      }
      const baseDepth = Math.min(...items.map((it) => it.depth));
      const [html] = renderList(
        items.map((it) => ({ ...it, depth: it.depth - baseDepth })),
        0,
        0,
      );
      out.push(html);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && !isBlockStart(lines[i] ?? '')) {
      para.push((lines[i] ?? '').trim());
      i++;
    }
    out.push(`<p style="${S.p}">${para.map(inlineHtml).join('<br />')}</p>`);
  }

  return out.join('');
}

/**
 * Block-level markdown → email-safe HTML: headings, tables, lists, quotes,
 * code, rules and paragraphs. **Never throws** — anything the converter cannot
 * handle degrades to escaped preformatted text rather than an unsent email.
 */
export function markdownToHtml(markdown: string): string {
  const source = (markdown ?? '').trim();
  if (!source) return '';
  try {
    return convert(source) || `<pre style="${S.pre}">${escapeHtml(source)}</pre>`;
  } catch {
    return `<pre style="${S.pre}">${escapeHtml(source)}</pre>`;
  }
}

// --- Digest -----------------------------------------------------------------

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

/** A row of number+label tiles — mirrors `components.ts#statRow`. */
function statRow(items: Array<{ label: string; value: string }>): string {
  const shown = items.filter((i) => i.value).slice(0, 4);
  if (shown.length === 0) return '';
  const width = `${Math.floor(100 / shown.length)}%`;
  const cells = shown
    .map((item, index) =>
      [
        `<td width="${width}" style="width:${width};padding:11px 12px;vertical-align:top;background-color:${C.surface};border:1px solid ${C.border};${index > 0 ? 'border-left:0;' : ''}">`,
        `<div style="font-family:${FONT};font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:${C.faint};">${escapeHtml(item.label)}</div>`,
        `<div style="margin-top:4px;font-family:${FONT};font-size:14px;font-weight:600;line-height:1.35;color:${C.ink};word-break:break-word;">${escapeHtml(item.value)}</div>`,
        '</td>',
      ].join(''),
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 20px;"><tr>${cells}</tr></table>`;
}

/** One thread line: subject as the link, sender/age/count underneath. */
function threadRow(t: DigestThread, tone: 'you' | 'them'): string {
  const accent = tone === 'you' ? C.warnFg : C.muted;
  const href = safeHref(t.permalink);
  const subject = escapeHtml(t.subject);
  return [
    `<tr><td style="padding:11px 0;border-bottom:1px solid ${C.border};">`,
    href
      ? `<a href="${href}" style="font-family:${FONT};font-size:15px;font-weight:600;color:${C.ink};text-decoration:none;">${subject}</a>`
      : `<span style="font-family:${FONT};font-size:15px;font-weight:600;color:${C.ink};">${subject}</span>`,
    `<div style="margin-top:3px;font-family:${FONT};font-size:12.5px;line-height:1.45;color:${accent};">${escapeHtml(t.lastFrom)} · ${escapeHtml(humanAge(t.ageHours))} ago · ${t.messageCount} message${t.messageCount === 1 ? '' : 's'}</div>`,
    '</td></tr>',
  ].join('');
}

function threadSection(
  title: string,
  threads: DigestThread[],
  tone: 'you' | 'them',
  empty: string,
): string {
  return [
    `<h3 style="${S.h3}">${escapeHtml(title)}</h3>`,
    threads.length === 0
      ? `<p style="margin:0 0 14px;font-family:${FONT};font-size:14px;color:${C.faint};">${escapeHtml(empty)}</p>`
      : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 18px;">${threads
          .slice(0, 12)
          .map((t) => threadRow(t, tone))
          .join('')}</table>`,
  ].join('');
}

const PREHEADER_PADDING = '&#847;&zwnj;&nbsp;'.repeat(60);

/**
 * The digest as a complete, self-contained email document — same shell,
 * palette and components as every other automated Cortex email.
 */
export function renderDigestHtml(input: DigestRenderInput): string {
  const title = `Your inbox digest — ${input.dateLabel}`;
  const preheader =
    input.needsYou.length > 0
      ? `${input.needsYou.length} conversation${input.needsYou.length === 1 ? '' : 's'} waiting on your reply, oldest first.`
      : `Nothing is waiting on you. Here is what moved in the last ${input.windowHours} hours.`;

  const body = [
    statRow([
      { label: 'Waiting on you', value: String(input.needsYou.length) },
      {
        label: 'Waiting on others',
        value: String(input.waitingOnOthers.length),
      },
      { label: 'Window', value: `Last ${input.windowHours}h` },
    ]),
    input.focus
      ? [
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 20px;">',
          `<tr><td style="padding:13px 16px;background-color:${C.warnBg};border:1px solid ${C.warnBorder};border-left:4px solid ${C.warnFg};">`,
          `<div style="margin:0 0 5px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${C.warnFg};">Prioritized around</div>`,
          `<div style="font-family:${FONT};font-size:14.5px;line-height:1.55;color:${C.ink};">${escapeHtml(input.focus)}</div>`,
          '</td></tr></table>',
        ].join('')
      : '',
    markdownToHtml(input.summaryMarkdown),
    threadSection(
      'Waiting on you',
      input.needsYou,
      'you',
      'Nothing is waiting on a reply from you.',
    ),
    threadSection(
      'Waiting on someone else',
      input.waitingOnOthers,
      'them',
      'You are not blocked on anyone right now.',
    ),
  ]
    .filter(Boolean)
    .join('');

  const footerNote = `Built by Cortex from your own mailbox — ${input.scanned} recent conversation${
    input.scanned === 1 ? '' : 's'
  } read and summarized on Cortex's side. ${input.excludedNote} You asked for this digest in Settings and can turn it off there at any time.`;

  return `<!doctype html>
<html lang="en" style="color-scheme:light;supported-color-schemes:light;">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${C.surface};color-scheme:light;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.surface};">${escapeHtml(preheader)}${PREHEADER_PADDING}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${C.surface};">
<tr><td align="center" style="padding:28px 14px 40px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;">
<tr><td style="padding:0 4px 14px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="32" style="width:32px;padding-right:9px;vertical-align:middle;"><img src="${cortexIconUrl()}" width="32" height="32" alt="Cortex" style="display:block;width:32px;height:32px;border:0;border-radius:8px;" /></td>
<td style="vertical-align:middle;font-family:${FONT};font-size:16px;font-weight:700;letter-spacing:-.01em;color:${C.primary};">Cortex</td>
</tr></table>
</td></tr>
<tr><td style="padding:26px 26px 24px;background-color:${C.card};border:1px solid ${C.border};border-radius:16px;">
<div style="margin:0 0 8px;font-family:${FONT};font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.faint};">Daily inbox digest</div>
<h1 style="margin:0 0 16px;font-family:${FONT};font-size:23px;line-height:1.28;font-weight:800;letter-spacing:-.015em;color:${C.ink};">${escapeHtml(input.dateLabel)}</h1>
${body}
</td></tr>
<tr><td style="padding:18px 4px 0;">
<p style="margin:0;font-family:${FONT};font-size:12.5px;line-height:1.55;color:${C.faint};">${escapeHtml(footerNote)}</p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}
