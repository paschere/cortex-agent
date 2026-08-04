/**
 * Design tokens for every automated email Cortex sends.
 *
 * Email is not the web: no external stylesheets, no `<style>` you can rely on
 * (Gmail strips it in some clients and always in the mobile apps), no web
 * fonts, no flexbox/grid. Everything below is meant to be interpolated as an
 * INLINE `style="..."` attribute on a table-based layout.
 *
 * The palette mirrors the product surface (see the OAuth consent screen in
 * `app/api/oauth/authorize/route.ts`, which uses the same plum/ink ramp).
 *
 * Light background only, on purpose: dark-mode email is a trap — Gmail and
 * Outlook.com invert colors with their own heuristics and a "dark" design ends
 * up unreadable in half the clients. We declare `color-scheme: light` and use
 * near-black (never `#000`) so forced inversion has the least to do.
 */

export const palette = {
  /** Brand plum — buttons, links, accents. */
  primary: "#7E4390",
  /** Lighter plum for gradients/secondary accents. */
  primarySoft: "#9658A3",
  /** Body text. Deliberately not pure black. */
  ink: "#241A2E",
  /** Secondary text: labels, meta, footers. */
  muted: "#5C4E68",
  /** Even quieter: legal-ish footer lines. */
  faint: "#8A7C96",
  /** Hairlines, table borders, card edges. */
  border: "#E6DDEE",
  /** Page background behind the card. */
  surface: "#FAF8FC",
  /** Card background. */
  card: "#ffffff",
  /** Tinted fill: table headers, chips, quiet panels. */
  chip: "#F3EBF8",
  /** Zebra striping for table rows (must stay lighter than `chip`). */
  zebra: "#FBF9FD",
} as const;

/** Status accents. Each tone is a text/background/border triple. */
export const tones = {
  info: { fg: "#6B3480", bg: "#F5EEF9", border: "#E1CFEA" },
  success: { fg: "#0B6B4F", bg: "#ECFDF5", border: "#B7E4D0" },
  warn: { fg: "#8A5A08", bg: "#FFF9EC", border: "#F3DDA8" },
  danger: { fg: "#A3123C", bg: "#FFF1F4", border: "#F4C2CE" },
  neutral: { fg: palette.muted, bg: palette.surface, border: palette.border },
} as const;

export type Tone = keyof typeof tones;

/** System stack — no web fonts survive Outlook, so don't pretend otherwise. */
export const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

export const MONO_STACK =
  "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',Courier,monospace";

/** The Cortex mark, served from the production app so every client can load it. */
export const CORTEX_ICON_URL = "https://cortex-Cortex.vercel.app/icon.png";

/** Body copy defaults, shared by the layout and the markdown converter. */
export const BODY_STYLE = `font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:${palette.ink};`;

/**
 * Escape every HTML-significant character in a text node.
 *
 * Agent output is not trusted markup: a stray `<` in a report (`< 40 hours`,
 * an XML snippet, a `<script` someone pasted into a ticket) must never become
 * live markup or shear the layout in half. Applied to ALL text before any
 * markdown decoration is layered on top.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Only let real, clickable schemes through. Anything else (javascript:, data:)
 * renders as plain text instead of a link.
 */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!/^(https?:\/\/|mailto:|tel:)/i.test(trimmed)) return null;
  return escapeHtml(trimmed);
}
