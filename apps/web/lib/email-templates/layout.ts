import { CORTEX_ICON_PATH, FONT_STACK, escapeHtml, palette, safeHref } from './theme';

/**
 * The shell every automated Cortex email is poured into.
 *
 * Structure (all tables, all inline styles):
 *
 *   body (surface background)
 *   └ hidden preheader  ← the snippet Gmail shows next to the subject
 *   └ 600px centred table
 *     ├ header band: the Cortex mark + wordmark
 *     ├ white card: title, optional eyebrow/pill, body
 *     └ footer: link back to Cortex + why this landed in their inbox
 */

/** Gmail clips messages past ~102KB; stay comfortably under it. */
export const MAX_EMAIL_HTML_CHARS = 90_000;

/** What every concrete template returns. `text` is never optional: some
 * clients (and every screen reader shortcut, notification preview and
 * `text/plain`-only corporate gateway) never render the HTML part. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** The app's public origin, without a trailing slash. */
export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
}

export interface RenderEmailOptions {
  /** Used for `<title>` and as the H1 inside the card. */
  title: string;
  /**
   * The ~90 characters Gmail/Apple Mail preview next to the subject. The
   * highest-leverage copy in the whole email — write it as a sentence that
   * completes the subject, never a repeat of it.
   */
  preheader: string;
  /** Pre-rendered, already-escaped HTML for the card body. */
  bodyHtml: string;
  /** Small line above the title (e.g. "Scheduled routine"). Plain text. */
  eyebrow?: string;
  /** Right-hand badge next to the eyebrow — pass `statusPill(...)`. */
  pillHtml?: string;
  /** One line explaining why this person received the email. Plain text. */
  footerNote?: string;
}

/** Keeps the body copy out of the inbox preview after the preheader. */
const PREHEADER_PADDING = '&#847;&zwnj;&nbsp;'.repeat(60);

export function renderEmail(opts: RenderEmailOptions): string {
  const base = appBaseUrl();
  // No base URL configured means no absolute link and no logo — both the
  // header and the footer below already render fine without them.
  const home = safeHref(base);
  const icon = base ? safeHref(`${base}${CORTEX_ICON_PATH}`) : '';

  const header = [
    `<tr><td style="padding:0 4px 14px;">`,
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>',
    icon
      ? `<td width="32" style="width:32px;padding-right:9px;vertical-align:middle;"><img src="${icon}" width="32" height="32" alt="Cortex" style="display:block;width:32px;height:32px;border:0;border-radius:8px;" /></td>`
      : '',
    `<td style="vertical-align:middle;font-family:${FONT_STACK};font-size:16px;font-weight:700;letter-spacing:-.01em;color:${palette.primary};">Cortex</td>`,
    '</tr></table>',
    '</td></tr>',
  ].join('');

  const eyebrowRow =
    opts.eyebrow || opts.pillHtml
      ? [
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 8px;"><tr>',
          `<td style="font-family:${FONT_STACK};font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${palette.faint};vertical-align:middle;">${escapeHtml(opts.eyebrow ?? '')}</td>`,
          `<td align="right" style="text-align:right;vertical-align:middle;">${opts.pillHtml ?? ''}</td>`,
          '</tr></table>',
        ].join('')
      : '';

  const footer = [
    `<tr><td style="padding:18px 4px 0;">`,
    `<p style="margin:0 0 6px;font-family:${FONT_STACK};font-size:12.5px;line-height:1.55;color:${palette.faint};">`,
    home
      ? `Sent by Cortex · <a href="${home}" style="color:${palette.primary};text-decoration:underline;">Open Cortex</a>`
      : 'Sent by Cortex',
    '</p>',
    opts.footerNote
      ? `<p style="margin:0;font-family:${FONT_STACK};font-size:12.5px;line-height:1.55;color:${palette.faint};">${escapeHtml(opts.footerNote)}</p>`
      : '',
    '</td></tr>',
  ].join('');

  return `<!doctype html>
<html lang="en" style="color-scheme:light;supported-color-schemes:light;">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${palette.surface};color-scheme:light;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${palette.surface};">${escapeHtml(opts.preheader)}${PREHEADER_PADDING}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${palette.surface};">
<tr><td align="center" style="padding:28px 14px 40px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;">
${header}
<tr><td style="padding:26px 26px 24px;background-color:${palette.card};border:1px solid ${palette.border};border-radius:16px;">
${eyebrowRow}
<h1 style="margin:0 0 16px;font-family:${FONT_STACK};font-size:23px;line-height:1.28;font-weight:800;letter-spacing:-.015em;color:${palette.ink};">${escapeHtml(opts.title)}</h1>
${opts.bodyHtml}
</td></tr>
${footer}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}
