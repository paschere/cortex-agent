import { contentWords, keepIfSpecific, parseSuggestions } from '@/lib/followup-filter';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { suggestionModel } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { generateText } from 'ai';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
/** Nobody is waiting on this. If it cannot answer quickly it should not answer. */
export const maxDuration = 20;

/**
 * THREE THINGS WORTH ASKING NEXT — and the bar they have to clear.
 *
 * ===========================================================================
 * WHY THIS IS A SEPARATE REQUEST AND NOT PART OF THE TURN
 * ===========================================================================
 * The obvious place for follow-ups is the end of the chat route: the answer is
 * right there, the conversation is loaded, one more model call and you are
 * done. It is the wrong place for two reasons and the first one is fatal.
 *
 * A call inside the turn is a call the person WAITS FOR. Even at Haiku speed
 * that is a second of nothing happening after the answer has finished
 * streaming, which is the most expensive second in the whole interaction —
 * the answer is on screen and the product looks like it is still thinking.
 * And a failure there is a failure of the turn: a 429 from the suggestion call
 * would have to be swallowed somewhere inside the streaming path, which is
 * exactly the sort of thing that swallows a real error by accident.
 *
 * Here, the worst case is that a fetch fails and a row of chips never appears.
 * Nobody notices, nothing is logged as a user-facing failure, and the answer
 * was complete before this route was ever called.
 *
 * ===========================================================================
 * THE BAR, AND WHY THERE IS A FILTER AFTER THE MODEL
 * ===========================================================================
 * A generic suggestion is worse than no suggestion. "¿Quieres saber más?"
 * costs a row of screen, and — worse — it teaches the person that this strip
 * is noise, which kills the useful ones that come later. Two suggestions worth
 * clicking beat three where one is filler.
 *
 * So the prompt asks for specificity, and then `keepIfSpecific` CHECKS for it,
 * because a prompt is a request and a filter is a guarantee. The check is
 * deliberately mechanical rather than clever: a follow-up must reuse a
 * substantial word that actually appears in the answer. A question about "los
 * tres vehículos con SOAT vencido" passes because "vehículos" and "SOAT" are in
 * the text; "¿quieres que profundice?" fails because none of its words are.
 * That single rule kills almost the entire family of generic questions without
 * needing to enumerate them, and it fails safe: an over-zealous filter shows
 * fewer chips, never a wrong one.
 *
 * Returning fewer than three is a normal outcome and the client renders
 * whatever it gets. Returning zero is also normal.
 *
 * ===========================================================================
 * GENERATED ONCE, THEN STORED — AND WHY THAT IS THE POINT
 * ===========================================================================
 * This route used to run on every VIEW. Reopening yesterday's thread re-derived
 * three questions from an answer that had not changed and never would, and it
 * derived DIFFERENT ones each time, which is what taught people to stop reading
 * the strip: a suggestion that moves when you blink is not something the
 * product knows, it is decoration.
 *
 * An answer is immutable once written, so anything derived from it alone is a
 * property of that answer. It now lives on the message row
 * (`messages.followups`, migration 0090) and this route is a read-through:
 *
 *   followups is not null   return it. No model call. No cost. No drift.
 *   followups is null       generate once, filter, WRITE, return.
 *
 * `null` and `{}` are different answers and that difference is the whole retry
 * policy. `{}` means somebody generated and there was nothing worth asking —
 * settled, never tried again, including when the reason was a timeout or a rate
 * limit. The specificity filter below already fails toward fewer chips, so "no
 * hay una buena segunda pregunta" is the normal outcome for most answers and
 * the honest thing to record. Retrying would put the per-open cost straight
 * back for a second guess at something the strip omits gracefully.
 *
 * ===========================================================================
 * THE TARGET MESSAGE IS FOUND HERE, NOT SENT BY THE CLIENT
 * ===========================================================================
 * It used to arrive in the body as `messageId`. That was wrong twice over. The
 * schema demanded a uuid and `useChat` names a streaming assistant message with
 * its own generated id — so on the one turn that matters, the live one, the
 * body failed validation and this route returned an empty list without ever
 * calling the model. Follow-ups only appeared on RELOADED conversations, where
 * the ids come from the database. Now that the result is written down, a wrong
 * target would persist somebody else's questions under an answer, so the row is
 * resolved from the conversation instead: follow-ups belong to the newest
 * answer and to nothing else.
 */

const Body = z.object({
  conversationId: z.string().uuid(),
});

/**
 * How much of the exchange Haiku sees.
 *
 * Its window is 200K, not the 1M the conversation model gets, so this cannot be
 * "the transcript". It also should not be: a follow-up is about what was just
 * said, and handing it ten turns of history mostly produces questions about
 * something from twenty minutes ago. One exchange, clipped.
 *
 * The answer gets the larger share because that is where the specifics are.
 */
const QUESTION_CHARS = 700;
const ANSWER_CHARS = 2600;

/** Anything shorter than this had no content to ask a second question about. */
const MIN_ANSWER_CHARS = 120;

const SYSTEM = [
  'Eres el que propone la siguiente pregunta dentro de Cortex, un asistente de operaciones para una empresa colombiana de logística, aduanas y flota.',
  'Te doy la última pregunta de la persona y la respuesta que se le dio. Devuelves como máximo tres preguntas que esa persona podría querer hacer AHORA, sabiendo lo que acaba de leer.',
  '',
  'Reglas:',
  '- Cada pregunta tiene que nacer de algo CONCRETO que aparece en la respuesta: una placa, un cliente, una cifra, una fecha, un documento, un nombre. Menciónalo con sus palabras.',
  '- Tienen que ser accionables: algo que se pueda averiguar o hacer, no una invitación a divagar.',
  '- Prohibido lo genérico. Nada de "¿quieres saber más?", "¿te amplío?", "¿quieres detalles?", "¿en qué más te ayudo?". Si no se te ocurre nada concreto, devuelve menos preguntas, o ninguna.',
  '- No repitas la pregunta que ya se hizo, ni pidas algo que la respuesta ya dio.',
  '- Español de Colombia, tuteo, una línea cada una, máximo 90 caracteres.',
  '',
  'Formato: una pregunta por línea, sin numerar, sin viñetas, sin comillas y sin ninguna otra frase. Si no hay ninguna buena, no escribas nada.',
].join('\n');

export async function POST(req: NextRequest) {
  const user = await requireSession();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json({ suggestions: [] });

  const db = getOrgScopedClient(user.organization.id);

  // The scoped handle is the whole tenancy story here: another workspace's
  // conversation id simply returns no rows, so there is nothing to check by
  // hand and nothing to forget to check.
  const { data: rows } = await db
    .from('messages')
    .select('id, role, content, followups')
    .eq('conversation_id', parsed.data.conversationId)
    .order('created_at', { ascending: false })
    .limit(6);

  const newest = [...(rows ?? [])];

  // Follow-ups hang off the LAST answer or off nothing. If the newest row is
  // not an assistant one, the turn's row has not landed yet (this fetch races
  // the chat route's own write by a few hundred milliseconds) — so nothing is
  // generated and, deliberately, nothing is WRITTEN. Leaving the column null
  // keeps the state at "nobody has tried", which is true, and the next time
  // somebody opens the conversation it is generated then. That is the one case
  // that gets a second chance, and it costs nothing when it never happens.
  const target = newest[0];
  if (!target || target.role !== 'assistant') {
    return NextResponse.json({ suggestions: [] });
  }

  const stored = target.followups as string[] | null;
  if (stored !== null && stored !== undefined) {
    // The whole savings, in three lines: an answer that has already been asked
    // this question is never asked again, however many times it is reopened.
    return NextResponse.json({ suggestions: stored.slice(0, 3) });
  }

  const messageId = target.id as string;

  /** Settle this message, so re-reading the thread never spends anything again. */
  const settle = async (suggestions: string[]): Promise<string[]> => {
    // A write that fails costs the next open one generation and nothing else,
    // so it must never cost the person the chips that are already in hand.
    const { error } = await db
      .from('messages')
      .update({ followups: suggestions })
      .eq('id', messageId);
    if (error) logger.debug('followups not stored', { message: error.message });
    return suggestions;
  };

  const answer = target.content;
  const question = newest.find((m) => m.role === 'user')?.content ?? '';

  // A one-line answer ("Listo, ya quedó programado") has nothing to branch off.
  // Cheaper and more honest to say nothing than to invent three questions — and
  // it is settled as {} without a single model call, because that answer is
  // never going to grow.
  if (typeof answer !== 'string' || answer.trim().length < MIN_ANSWER_CHARS) {
    return NextResponse.json({ suggestions: await settle([]) });
  }

  const clippedAnswer = answer.slice(0, ANSWER_CHARS);
  const clippedQuestion = String(question).slice(0, QUESTION_CHARS);

  try {
    const { text } = await generateText({
      model: suggestionModel(),
      system: SYSTEM,
      prompt: [
        `<pregunta>\n${clippedQuestion}\n</pregunta>`,
        '',
        `<respuesta>\n${clippedAnswer}\n</respuesta>`,
      ].join('\n'),
      // Room for three short lines and nothing else. Reasoning is off for this
      // model (see `suggestionModel`), so the whole budget is the answer.
      maxTokens: 200,
      abortSignal: AbortSignal.timeout(12_000),
    });

    const answerWords = contentWords(clippedAnswer);
    const suggestions = parseSuggestions(text)
      .filter((s) => keepIfSpecific(s, answerWords, clippedQuestion))
      .slice(0, 3);

    return NextResponse.json({ suggestions: await settle(suggestions) });
  } catch (err) {
    // Deliberately not surfaced. A missing strip of chips is not an incident,
    // and telling somebody their suggestions failed is worse than the silence.
    logger.debug('followups failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    // Settled as {} rather than left open. A timeout here is indistinguishable
    // from "this answer had no good second question", both render the same
    // nothing, and the alternative — retry on every open — is the cost this
    // whole change exists to remove. See migration 0090.
    return NextResponse.json({ suggestions: await settle([]) });
  }
}
