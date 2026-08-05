import 'server-only';
import { flattenMarkdownForChat } from '@cortex/agent-tools';

/**
 * An answer, shaped for a WhatsApp bubble.
 *
 * WHY THIS REUSES THE GOOGLE CHAT FLATTENER. Cortex answers in markdown —
 * headings, tables, bullet lists — and neither Chat nor WhatsApp renders any of
 * it. `flattenMarkdownForChat` already solves exactly that problem: headings
 * become bold lines, tables become bullet lines, links keep their text. And the
 * two dialects happen to agree on the part that matters: `*bold*`, `_italic_`,
 * `~strike~` and ``` fenced code ``` mean the same thing in both. Writing a
 * second flattener would be a copy that drifts, for a difference that does not
 * exist.
 *
 * The one genuine difference is length. Chat rejects a message over 4096
 * characters; WhatsApp accepts far more but nobody reads it — a wall of text in
 * a chat bubble is worse than a short answer, and the system prompt already
 * asks for a few lines. So the cap here is deliberate product behaviour rather
 * than a platform limit.
 */

/** Short enough to read on a phone without scrolling twice. */
export const WHATSAPP_TEXT_LIMIT = 3_000;

export function toWhatsappText(markdown: string, limit = WHATSAPP_TEXT_LIMIT): string {
  const flattened = flattenMarkdownForChat(markdown ?? '', limit).trim();
  return flattened || 'Listo.';
}

/**
 * How long to wait before answering, and why there is a wait at all.
 *
 * An account that replies in 180 milliseconds, at any hour, to every message,
 * is a bot in the most literal sense and reads as one to anybody watching the
 * traffic — including WhatsApp. The delay is short (it is not pretending to be
 * a person, it is declining to look like a script), proportional to the length
 * of the answer, and capped so nobody is left staring at "escribiendo…".
 *
 * The "typing…" indicator that runs during it is the honest part: it tells the
 * person the message arrived and something is happening, which a silent four
 * seconds does not.
 */
export function humanDelayMs(replyLength: number): number {
  const base = 900;
  // Roughly a fast typist's pace, then capped hard.
  const perCharacter = 12;
  return Math.min(4_500, base + Math.min(replyLength, 300) * perCharacter);
}
