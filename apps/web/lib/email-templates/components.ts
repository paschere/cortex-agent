import { inlineMarkdownToHtml } from './markdown';
import { FONT_STACK, MONO_STACK, type Tone, escapeHtml, palette, safeHref, tones } from './theme';

/**
 * The building blocks the individual emails are assembled from.
 *
 * Everything is a `<table>` with inline styles: Outlook (Word's rendering
 * engine) ignores `div` margins, padding on inline elements and anything
 * resembling flexbox, but it has always laid out tables correctly.
 */

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

/** A small rounded badge — "Completed", "Failed", "Needs approval". */
export function statusPill(opts: { label: string; tone: Tone }): string {
  const t = tones[opts.tone];
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;">',
    '<tr><td style="',
    `padding:4px 11px;background-color:${t.bg};border:1px solid ${t.border};border-radius:999px;`,
    `font-family:${FONT_STACK};font-size:11.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${t.fg};white-space:nowrap;`,
    `">${escapeHtml(opts.label)}</td></tr>`,
    '</table>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Stat row
// ---------------------------------------------------------------------------

export interface StatItem {
  label: string;
  value: string;
}

/**
 * A row of number+label tiles ("Ran at / Duration / Next run"). Rendered as a
 * single table row: on narrow screens the cells compress rather than wrap to
 * their own lines, which is the trade every table-based email makes. Capped at
 * four so they stay legible on a phone.
 */
export function statRow(items: StatItem[]): string {
  const shown = items.filter((i) => i.value).slice(0, 4);
  if (shown.length === 0) return '';
  const width = `${Math.floor(100 / shown.length)}%`;

  const cells = shown
    .map(
      (item, index) => `<td width="${width}" style="
        width:${width};padding:11px 12px;vertical-align:top;
        background-color:${palette.surface};
        border:1px solid ${palette.border};${index > 0 ? 'border-left:0;' : ''}
      ">
        <div style="font-family:${FONT_STACK};font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:${palette.faint};">${escapeHtml(item.label)}</div>
        <div style="margin-top:4px;font-family:${FONT_STACK};font-size:14px;font-weight:600;line-height:1.35;color:${palette.ink};word-break:break-word;">${escapeHtml(item.value)}</div>
      </td>`,
    )
    .join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 20px;"><tr>${cells}</tr></table>`;
}

// ---------------------------------------------------------------------------
// Callout
// ---------------------------------------------------------------------------

/**
 * A tinted panel with a left accent bar. `text` is plain text by default (it
 * gets escaped); pass `html` when the caller has already built safe markup.
 */
export function calloutBox(opts: {
  tone: Tone;
  text?: string;
  html?: string;
  title?: string;
}): string {
  const t = tones[opts.tone];
  const body = opts.html ?? inlineMarkdownToHtml(opts.text ?? '');
  const title = opts.title
    ? `<div style="margin:0 0 5px;font-family:${FONT_STACK};font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${t.fg};">${escapeHtml(opts.title)}</div>`
    : '';
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 20px;">',
    `<tr><td style="padding:13px 16px;background-color:${t.bg};border:1px solid ${t.border};border-left:4px solid ${t.fg};">`,
    title,
    `<div style="font-family:${FONT_STACK};font-size:14.5px;line-height:1.55;color:${palette.ink};">${body}</div>`,
    '</td></tr></table>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

/**
 * Bulletproof button: a one-cell table with the background on the `<td>` and
 * the padding on the `<a>`, so the whole rectangle is clickable in Gmail and
 * still paints in Outlook (which drops `background` on anchors).
 */
export function button(opts: { href: string; label: string; tone?: 'primary' | 'quiet' }): string {
  const href = safeHref(opts.href);
  if (!href) return '';
  const quiet = opts.tone === 'quiet';
  const bg = quiet ? palette.card : palette.primary;
  const fg = quiet ? palette.primary : '#ffffff';
  const border = quiet ? palette.border : palette.primary;
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;">',
    `<tr><td align="center" style="background-color:${bg};border:1px solid ${border};border-radius:10px;">`,
    `<a href="${href}" style="display:inline-block;padding:12px 26px;font-family:${FONT_STACK};font-size:15px;font-weight:700;line-height:1;color:${fg};text-decoration:none;">${escapeHtml(opts.label)}</a>`,
    '</td></tr></table>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Key/value table
// ---------------------------------------------------------------------------

export interface KeyValueRow {
  label: string;
  value: string;
  /** Set when `value` is already safe HTML (e.g. built by another component). */
  isHtml?: boolean;
}

/** Label on the left, value on the right — "What / Where / Why". */
export function keyValueTable(rows: KeyValueRow[]): string {
  const visible = rows.filter((r) => r.value);
  if (visible.length === 0) return '';
  const body = visible
    .map(
      (row, index) => `<tr>
        <td width="34%" style="width:34%;padding:10px 12px;background-color:${palette.surface};border:1px solid ${palette.border};${index > 0 ? 'border-top:0;' : ''}font-family:${FONT_STACK};font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${palette.muted};vertical-align:top;word-break:break-word;">${escapeHtml(row.label)}</td>
        <td style="padding:10px 12px;border:1px solid ${palette.border};border-left:0;${index > 0 ? 'border-top:0;' : ''}font-family:${FONT_STACK};font-size:14.5px;line-height:1.5;color:${palette.ink};vertical-align:top;word-break:break-word;overflow-wrap:anywhere;">${row.isHtml ? row.value : escapeHtml(row.value)}</td>
      </tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 20px;">${body}</table>`;
}

// ---------------------------------------------------------------------------
// Code block
// ---------------------------------------------------------------------------

/** Monospaced, wrapped, escaped — for payloads, stack traces, error text. */
export function codeBlock(text: string, opts: { label?: string } = {}): string {
  const label = opts.label
    ? `<div style="margin:0 0 6px;font-family:${FONT_STACK};font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:${palette.faint};">${escapeHtml(opts.label)}</div>`
    : '';
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 20px;">',
    `<tr><td style="padding:13px 15px;background-color:${palette.surface};border:1px solid ${palette.border};border-radius:8px;">`,
    label,
    `<pre style="margin:0;font-family:${MONO_STACK};font-size:12.5px;line-height:1.5;color:${palette.ink};white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;">${escapeHtml(text)}</pre>`,
    '</td></tr></table>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

/** The one-line intro under the title. */
export function lede(text: string): string {
  return `<p style="margin:0 0 20px;font-family:${FONT_STACK};font-size:15.5px;line-height:1.55;color:${palette.muted};">${inlineMarkdownToHtml(text)}</p>`;
}

/** A quiet aside — truncation notices, "you can turn this off" lines. */
export function fineprint(text: string): string {
  return `<p style="margin:0 0 14px;font-family:${FONT_STACK};font-size:12.5px;line-height:1.55;color:${palette.faint};">${inlineMarkdownToHtml(text)}</p>`;
}

/** A hairline between sections of the card. */
export function divider(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 20px;"><tr><td style="border-top:1px solid ${palette.border};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}
