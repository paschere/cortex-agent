/**
 * What each part of the turn weighed — the half of this surface that answers
 * "the model got 40.000 tokens and 70% of them were the tool list".
 *
 * TWO NUMBERS, AND THEY ARE NOT THE SAME KIND OF NUMBER.
 *
 *   `chars` is MEASURED. It is the length of the string that was actually
 *   concatenated into the request. There is nothing to get wrong about it and
 *   nothing to disagree with later.
 *
 *   `tokens` is ESTIMATED, from characters, with the same divisor the embedder
 *   has used since it shipped. It is shown as an estimate, in words, wherever
 *   it appears. Running a real tokenizer would mean shipping a tokenizer, and
 *   more to the point running it on the hot path of a chat response — several
 *   milliseconds and a megabyte of vocabulary, to sharpen a number whose only
 *   job is to say which part is the big one.
 *
 * THE TRUE TOTAL IS RECORDED SEPARATELY. The provider reports the real prompt
 * token count when the turn finishes, and that is stored as itself. So the page
 * can print one true figure and a breakdown that admits to being approximate,
 * rather than a set of confident numbers that quietly do not add up to what was
 * billed. Shares are computed on characters, where they are exact.
 */

import type { ContextPart, ContextPartKey } from './types';

/**
 * Characters per token. Deliberately the embedder's number rather than a new
 * one: the two are estimating the same thing about the same Spanish-and-English
 * text, and two different constants for that would be a bug waiting to be
 * argued about. Spanish runs a little denser than English, so this leans
 * pessimistic, which is the right direction for a figure people use to decide
 * what to cut.
 */
export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Weigh the parts of a turn. Parts that were empty are dropped rather than
 * listed at zero — a turn with no memories should show five bars, not six with
 * one invisible.
 */
export function weighParts(parts: Array<{ key: ContextPartKey; text: string }>): ContextPart[] {
  return parts
    .filter((p) => p.text.length > 0)
    .map((p) => ({
      key: p.key,
      chars: p.text.length,
      tokens: estimateTokens(p.text),
    }));
}

/**
 * Each part's share of the whole, 0–1, computed on characters.
 *
 * On characters and not on the estimated tokens, because the estimate is
 * proportional to characters anyway — so the share is exact, and calling it a
 * share of "lo que recibió" is a true statement rather than a rounded one.
 */
export function shareOf(part: ContextPart, parts: readonly ContextPart[]): number {
  const total = parts.reduce((sum, p) => sum + p.chars, 0);
  return total === 0 ? 0 : part.chars / total;
}

/** The heaviest part, which is the one anybody opening this page came to find. */
export function heaviest(parts: readonly ContextPart[]): ContextPart | null {
  let best: ContextPart | null = null;
  for (const part of parts) {
    if (!best || part.chars > best.chars) best = part;
  }
  return best;
}
