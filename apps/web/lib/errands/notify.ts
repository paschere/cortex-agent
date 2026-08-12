import 'server-only';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * WHEN AN ERRAND NEEDS SOMETHING, IT GOES BACK TO WHERE IT WAS ASKED FOR.
 *
 * ── THE PROBLEM ───────────────────────────────────────────────────────────
 *
 * Asking instead of guessing is the whole point of an errand, and it only
 * works if the question REACHES somebody. Before the chat could start one,
 * every errand was born on the /errands screen, so a question waiting there
 * was a question waiting where its owner had just been looking. That stopped
 * being true the moment «investígame esto» became a sentence you say in a
 * conversation: the person carries on with their day, the errand blocks, and
 * the question sits on a page nobody has open. A blocked errand costs the same
 * as a running one and delivers nothing, so silence here is the expensive
 * failure, not the cheap one.
 *
 * ── WHAT THIS IS NOT ──────────────────────────────────────────────────────
 *
 * It is NOT a second question store. The question lives in `errand_questions`,
 * exactly where it did, with the same one-open-per-errand index and the same
 * conditional UPDATE guarding the answer — whether the answer arrives from the
 * screen, from `POST /api/errands/[id]/answer`, or from the `errands.answer`
 * tool. Only the DELIVERY is new, and even that is not new machinery: a
 * scheduled routine already reports back into a conversation the same way
 * (`scheduled_jobs.conversation_id`, inngest/functions/schedule-run.ts), by
 * inserting one assistant message. This is that mechanism, reused.
 *
 * ── WHY AN ASSISTANT MESSAGE, AND WHAT IT COSTS ───────────────────────────
 *
 * Because it is the only channel the person is already watching, it survives
 * a reload, and it puts the question in the thread that contains the context
 * for it. It is metered: `usage_meter_answer()` (migration 0085) counts one
 * answer per assistant message, so an errand that asks a question spends one.
 * That is the same bargain a routine notification already makes, and it is the
 * right one — a question that arrives is worth an answer's worth of quota; a
 * question nobody sees is worth nothing.
 *
 * ── BEST EFFORT, ALWAYS ───────────────────────────────────────────────────
 *
 * Never throws. The question is already durably stored and answerable from the
 * screen before this is called; a failed notification must not roll that back
 * or take the worker down with it. The worst case is the behaviour we had
 * before this file existed.
 */

/**
 * The app's own origin, for the "ver el encargo" link.
 *
 * Read the same way every other background notifier in apps/web reads it
 * (dev-work-notify, google-chat, mcp-url) rather than through the reports
 * package's copy, so a deployment that sets only one of the two variables gets
 * the same answer here as it does everywhere else. An empty base degrades to a
 * relative link, which still works from inside the app.
 */
function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
}

/** Kept short: this lands in a chat thread, not on a report page. */
const REQUEST_PREVIEW = 160;
const DELIVERABLE_PREVIEW = 2_000;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

async function post(db: SupabaseClient, conversationId: string, content: string): Promise<boolean> {
  try {
    const { error } = await db
      .from('messages')
      .insert({ conversation_id: conversationId, role: 'assistant', content });
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    logger.error('errands: could not deliver into the conversation', {
      conversationId,
      error: (err as Error).message,
    });
    return false;
  }
}

/**
 * Put the question in the thread the errand came from.
 *
 * The options are spelled out as a list rather than left implicit: the person
 * answers by typing, and a reply of "la primera" only works if there visibly
 * was a first. `errands.answer` then folds whatever they say back in.
 */
export async function askInConversation(
  db: SupabaseClient,
  input: {
    conversationId: string | null;
    errandId: string;
    request: string;
    question: string;
    why: string;
    options: string[];
  },
): Promise<boolean> {
  if (!input.conversationId) return false;

  const options =
    input.options.length > 0
      ? `\n\n${input.options.map((o) => `- ${o}`).join('\n')}\n\nContéstame aquí mismo y sigue desde donde iba.`
      : '\n\nContéstame aquí mismo y sigue desde donde iba.';

  const content = [
    `**Una pregunta sobre el encargo que me hiciste** — _${clip(input.request, REQUEST_PREVIEW)}_`,
    '',
    input.question,
    '',
    input.why,
    options.trimStart(),
    '',
    `Nada se pierde mientras decides: todo lo que llevo encontrado está guardado. [Ver el encargo](${appBaseUrl()}/errands/${input.errandId})`,
  ].join('\n');

  return post(db, input.conversationId, content);
}

/**
 * Come back with the answer — or with an honest account of why there isn't one.
 *
 * The deliverable is clipped rather than pasted whole: a comparison of eleven
 * operators is a document, and a chat thread is not where a document is read.
 * The link goes to the page that has it in full, with its source ledger.
 */
export async function deliverInConversation(
  db: SupabaseClient,
  input: {
    conversationId: string | null;
    errandId: string;
    request: string;
    state: 'delivered' | 'failed' | 'exhausted' | 'cancelled';
    deliverable: string | null;
    closingNote: string;
    sourceCount: number;
  },
): Promise<boolean> {
  if (!input.conversationId) return false;

  const heading =
    input.state === 'delivered'
      ? '**Terminé el encargo**'
      : input.state === 'exhausted'
        ? '**Cerré el encargo al llegar a su tope**'
        : '**El encargo no pudo terminar**';

  const body = input.deliverable ? clip(input.deliverable, DELIVERABLE_PREVIEW) : input.closingNote;

  const tail: string[] = [];
  if (input.deliverable && input.deliverable.trim().length > DELIVERABLE_PREVIEW) {
    tail.push('Esto es un resumen; el resultado completo está en la pantalla del encargo.');
  }
  if (input.sourceCount > 0) {
    tail.push(
      `Sale de ${input.sourceCount} ${input.sourceCount === 1 ? 'fuente' : 'fuentes'}, cada una con la hora a la que la leí.`,
    );
  }
  tail.push(`[Ver el encargo con sus fuentes](${appBaseUrl()}/errands/${input.errandId})`);

  const content = [
    `${heading} — _${clip(input.request, REQUEST_PREVIEW)}_`,
    '',
    body,
    '',
    tail.join(' '),
  ].join('\n');

  return post(db, input.conversationId, content);
}
