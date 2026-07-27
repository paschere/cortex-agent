import { FONT_STACK, MONO_STACK, escapeHtml, palette, safeHref, tones } from './theme';

/**
 * Markdown → email-safe HTML.
 *
 * Routine results, digests and approval notes are written by the agent in
 * markdown. Delivered as plain text people literally receive `## Weekly
 * payroll check` and `| Period | Gross |`, so this converts the subset an LLM
 * actually emits — headings, TABLES, lists, emphasis, code, links, rules,
 * quotes — into inline-styled, table-based HTML that survives Gmail, Outlook
 * and mobile clients.
 *
 * Deliberately dependency-free. The input is agent-generated markdown (a known,
 * narrow shape), not arbitrary user HTML, so a focused converter beats pulling
 * a parser + sanitizer into the app. Every text node is escaped before any
 * decoration is layered on, so a stray `<` can neither inject markup nor break
 * the layout.
 */

// ---------------------------------------------------------------------------
// Inline styles (kept together so the whole document reads as one system)
// ---------------------------------------------------------------------------

const S = {
  h2: `margin:26px 0 10px;font-family:${FONT_STACK};font-size:19px;line-height:1.3;font-weight:700;color:${palette.ink};letter-spacing:-.01em;`,
  h3: `margin:22px 0 8px;font-family:${FONT_STACK};font-size:15px;line-height:1.35;font-weight:700;color:${palette.primary};`,
  h4: `margin:18px 0 6px;font-family:${FONT_STACK};font-size:12px;line-height:1.4;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${palette.muted};`,
  p: `margin:0 0 12px;font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:${palette.ink};`,
  list: 'margin:0 0 14px;padding:0 0 0 22px;',
  li: `margin:0 0 7px;font-family:${FONT_STACK};font-size:15px;line-height:1.55;color:${palette.ink};`,
  hr: `border:0;border-top:1px solid ${palette.border};margin:22px 0;`,
  quote: `margin:0 0 14px;padding:10px 14px;background:${palette.surface};border-left:3px solid ${palette.primarySoft};color:${palette.muted};font-family:${FONT_STACK};font-size:14.5px;line-height:1.55;`,
  pre: `margin:0 0 14px;padding:12px 14px;background:${palette.surface};border:1px solid ${palette.border};border-radius:8px;font-family:${MONO_STACK};font-size:12.5px;line-height:1.5;color:${palette.ink};white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;`,
  code: `padding:1px 5px;background:${palette.chip};border-radius:4px;font-family:${MONO_STACK};font-size:13px;color:${tones.info.fg};word-break:break-word;`,
  link: `color:${palette.primary};text-decoration:underline;`,
  table: `width:100%;border-collapse:collapse;margin:14px 0 20px;border:1px solid ${palette.border};`,
  th: `padding:9px 12px;background:${palette.chip};border-bottom:1px solid ${palette.border};font-family:${FONT_STACK};font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${tones.info.fg};word-break:break-word;overflow-wrap:anywhere;`,
  td: `padding:9px 12px;border-bottom:1px solid ${palette.border};font-family:${FONT_STACK};font-size:13.5px;line-height:1.45;color:${palette.ink};vertical-align:top;word-break:break-word;overflow-wrap:anywhere;`,
};

// ---------------------------------------------------------------------------
// Inline conversion
// ---------------------------------------------------------------------------

const CODE_SENTINEL_OPEN = '\u0000c';
const CODE_SENTINEL_CLOSE = '\u0000';

/** `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, `[label](href)`. */
export function inlineMarkdownToHtml(raw: string): string {
  // Code spans are pulled out first so their contents are never re-decorated
  // (a `*` inside `` `a*b` `` is not emphasis).
  const spans: string[] = [];
  let s = escapeHtml(raw).replace(/`([^`]+?)`/g, (_m, code: string) => {
    spans.push(code);
    return `${CODE_SENTINEL_OPEN}${spans.length - 1}${CODE_SENTINEL_CLOSE}`;
  });

  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
    const safe = safeHref(href.replace(/&amp;/g, '&'));
    return safe ? `<a href="${safe}" style="${S.link}">${label}</a>` : match;
  });
  // Bare URLs that were not already turned into anchors.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (match, lead: string, url: string) => {
    const safe = safeHref(url.replace(/&amp;/g, '&'));
    return safe ? `${lead}<a href="${safe}" style="${S.link}">${url}</a>` : match;
  });

  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong style="font-weight:700;">$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:)!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

  return s.replace(
    new RegExp(`${CODE_SENTINEL_OPEN}(\\d+)${CODE_SENTINEL_CLOSE}`, 'g'),
    (_m, index: string) => `<code style="${S.code}">${spans[Number(index)] ?? ''}</code>`,
  );
}

// ---------------------------------------------------------------------------
// Tables — the single most important conversion (routine reports are mostly
// tables, and a markdown table delivered as text is unreadable).
// ---------------------------------------------------------------------------

type Align = 'left' | 'center' | 'right';

/** Split a `| a | b |` row, honouring `\|` escapes inside cells. */
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

/** A pipe row. Trailing pipes are optional — models omit them often enough. */
function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') && t.includes('|', 1);
}

/** `|---|:--:|---:|` — the line that makes a pipe row an actual table. */
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

  const headCells = Array.from({ length: width }, (_, i) => {
    const label = inlineMarkdownToHtml(header[i] ?? '');
    return `<th align="${at(i)}" style="${S.th}text-align:${at(i)};">${label}</th>`;
  }).join('');

  const bodyRows = rows
    .map((row, rowIndex) => {
      const zebra = rowIndex % 2 === 1 ? `background-color:${palette.zebra};` : '';
      const cells = Array.from({ length: width }, (_, i) => {
        const value = inlineMarkdownToHtml(row[i] ?? '');
        return `<td align="${at(i)}" style="${S.td}text-align:${at(i)};${zebra}">${value || '&nbsp;'}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  // The wrapper keeps a wide table from pushing the whole card sideways on
  // mobile; clients that ignore `overflow` still get the plain table.
  return [
    `<div style="width:100%;overflow-x:auto;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${S.table}">`,
    `<thead><tr>${headCells}</tr></thead>`,
    `<tbody>${bodyRows}</tbody>`,
    '</table>',
    '</div>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

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
    parts.push(`<li style="${S.li}">${inlineMarkdownToHtml(item.text)}</li>`);
    i++;
  }

  parts.push(`</${tag}>`);
  return [parts.join(''), i];
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

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

    // Fenced code block
    if (/^```/.test(trimmed)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i++;
      }
      i++; // closing fence
      out.push(`<pre style="${S.pre}">${escapeHtml(body.join('\n'))}</pre>`);
      continue;
    }

    // Table: a pipe row immediately followed by a delimiter row
    if (trimmed.startsWith('|') && isTableRow(trimmed)) {
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

    // Heading
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const text = inlineMarkdownToHtml((heading[2] ?? '').replace(/\s*#+\s*$/, ''));
      const style = level <= 2 ? S.h2 : level === 3 ? S.h3 : S.h4;
      const tag = level <= 2 ? 'h2' : level === 3 ? 'h3' : 'h4';
      out.push(`<${tag} style="${style}">${text}</${tag}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^([-*_])\s*\1\s*\1[\s\-*_]*$/.test(trimmed)) {
      out.push(`<hr style="${S.hr}" />`);
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('>')) {
        body.push((lines[i] ?? '').trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push(
        `<blockquote style="${S.quote}">${inlineMarkdownToHtml(body.join('\n'))
          .split('\n')
          .join('<br />')}</blockquote>`,
      );
      continue;
    }

    // Lists (with one or more levels of indentation)
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

    // Paragraph: consecutive plain lines. Single newlines are treated as hard
    // breaks — agents use them as such, and prose is rarely hard-wrapped.
    const para: string[] = [];
    while (i < lines.length && !isBlockStart(lines[i] ?? '')) {
      para.push((lines[i] ?? '').trim());
      i++;
    }
    out.push(`<p style="${S.p}">${para.map(inlineMarkdownToHtml).join('<br />')}</p>`);
  }

  return out.join('');
}

/** Escaped, monospaced, wrapped — the last-resort rendering of any text. */
export function preformatted(text: string): string {
  return `<pre style="${S.pre}">${escapeHtml(text)}</pre>`;
}

/**
 * Convert agent markdown to email HTML. **Never throws**: if anything in the
 * converter goes wrong the caller still gets a readable email — the original
 * text, escaped, inside a `<pre>` — rather than no email at all.
 */
export function markdownToEmailHtml(markdown: string): string {
  const source = (markdown ?? '').trim();
  if (!source) return `<p style="${S.p}"><em>No output.</em></p>`;
  try {
    const html = convert(source);
    return html || preformatted(source);
  } catch {
    return preformatted(source);
  }
}

/**
 * Gmail clips a message past ~102KB and hides the rest behind "View entire
 * message", which is exactly where the call-to-action lives. Long reports are
 * cut at a paragraph boundary well before that.
 */
export function clampMarkdown(
  markdown: string,
  maxChars: number,
): { markdown: string; truncated: boolean } {
  const source = (markdown ?? '').trim();
  if (source.length <= maxChars) return { markdown: source, truncated: false };
  const head = source.slice(0, maxChars);
  const cut = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('\n'));
  return {
    markdown: (cut > maxChars * 0.5 ? head.slice(0, cut) : head).trimEnd(),
    truncated: true,
  };
}
