import type { SupabaseClient } from '@supabase/supabase-js';
import { checkMeter, isRefused } from '../billing';
import type { ToolContext } from '../types';
import { assertProposalOnly } from './boundary';
import { MAX_LIVE_ERRANDS, ceilingsFor } from './budget';
import {
  DEFAULT_MONITOR_CADENCE_MINUTES,
  ERRAND_KIND_SPECS,
  isMonitorCadence,
  toolsFor,
} from './kinds';
import { type ErrandDb, answerQuestion } from './lifecycle';
import { ERRAND_COLUMNS, type ErrandKind, type ErrandView, toErrandView } from './shape';

/**
 * THE ONE DOOR AN ERRAND CAN BE COMMISSIONED THROUGH.
 *
 * Errands can now be started from two places — the /errands screen and a
 * sentence typed in the chat — and the second one is much easier to reach.
 * That makes the shape of this module the whole safety argument:
 *
 *   THE ADMISSION CHECKS ARE NOT IN THE ROUTE. THEY ARE IN HERE, AND BOTH
 *   CALLERS GO THROUGH THIS FUNCTION.
 *
 * `POST /api/errands` used to hold them, on the reasoning that it was the last
 * place with a session. That reasoning was right about sessions and wrong as
 * an architecture: the moment a second caller appears, checks that live in one
 * caller are checks the other silently skips, and the second caller here is one
 * the model invokes from natural language. So the route was reduced to parsing
 * and the checks moved here, where being invokable by saying "investígame esto"
 * cannot make anything more permissive than clicking the button.
 *
 * The three refusals, in the order they bite:
 *
 *   1. THE LINE. `assertProposalOnly` over the toolset this errand's legs would
 *      be handed, BEFORE a row exists. An errand searches, compares and
 *      proposes; it never buys, books, signs or sends. See ./boundary.ts — that
 *      file is the argument, this call is where it binds for the chat.
 *
 *   2. THE PLAN. A workspace whose `answers` meter is already refusing chat
 *      turns has no business commissioning an hour of autonomous research.
 *
 *   3. THE ROOM. `MAX_LIVE_ERRANDS` per workspace. Per-errand ceilings bound
 *      one errand; only this bounds somebody saying "investígame" five times in
 *      a row, which is a far more likely gesture in a chat than on a form.
 *
 * Refusals are RETURNED, not thrown, because the caller that matters most is a
 * model relaying the reason to a person. A thrown error becomes "no pude
 * hacerlo"; a returned reason becomes "ya tienes tres encargos andando, ¿paro
 * alguno?".
 */

export interface CommissionInput {
  kind: ErrandKind;
  request: string;
  /** Monitors only; ignored otherwise, defaulted when absent or not offered. */
  checkIntervalMinutes?: number | null;
  tokenCeiling?: number;
  legCeiling?: number;
  /**
   * The conversation this errand was commissioned in, when it was. It is what
   * lets a question come back to where it was asked instead of waiting on a
   * screen nobody is looking at. Null for the /errands form.
   */
  conversationId?: string | null;
}

export type CommissionRefusal = 'plan_limit' | 'too_many_live' | 'write_failed';

export type CommissionOutcome =
  | { ok: true; errand: ErrandView }
  | { ok: false; reason: CommissionRefusal; message: string };

/** Rows a workspace may have in flight. Read here so both callers share it. */
export async function countLiveErrands(db: SupabaseClient): Promise<number> {
  const { count } = await db
    .from('errands')
    .select('id', { count: 'exact', head: true })
    .in('state', ['queued', 'working', 'blocked', 'watching']);
  return count ?? 0;
}

export async function commissionErrand(
  ctx: ToolContext,
  input: CommissionInput,
): Promise<CommissionOutcome> {
  const spec = ERRAND_KIND_SPECS[input.kind];

  // ── 1. The line, before anything exists ─────────────────────────────────
  // Throws rather than returns: a caller that got here with a toolset that can
  // send has a bug, not a quota problem, and the correct behaviour is to stop
  // loudly. The list is the same one the /errands form uses, and it contains
  // nothing that can act outward.
  assertProposalOnly(toolsFor(input.kind));

  // ── 2. The plan ─────────────────────────────────────────────────────────
  const answers = await checkMeter(ctx.db, 'answers');
  if (isRefused(answers)) {
    return {
      ok: false,
      reason: 'plan_limit',
      message:
        'Este espacio de trabajo llegó al tope de respuestas de su plan. Un encargo corre solo y ' +
        'puede consumir bastante, así que no lo dejamos arrancar mientras el plan esté al límite. ' +
        'Mira Plan y consumo.',
    };
  }

  // ── 3. The room ─────────────────────────────────────────────────────────
  const live = await countLiveErrands(ctx.db);
  if (live >= MAX_LIVE_ERRANDS) {
    return {
      ok: false,
      reason: 'too_many_live',
      message:
        `Ya hay ${live} encargos andando en este espacio de trabajo, que es el máximo. ` +
        'Espera a que alguno entregue, o detén el que ya no necesites en la pantalla de Encargos.',
    };
  }

  const { tokenCeiling, legCeiling } = ceilingsFor(input.kind, spec, input);
  const isMonitor = input.kind === 'monitor_change';
  const cadence = isMonitor
    ? input.checkIntervalMinutes && isMonitorCadence(input.checkIntervalMinutes)
      ? input.checkIntervalMinutes
      : DEFAULT_MONITOR_CADENCE_MINUTES
    : null;

  const { data, error } = await ctx.db
    .from('errands')
    .insert({
      user_id: ctx.userId,
      kind: input.kind,
      request: input.request.trim().slice(0, 4000),
      state: 'queued',
      token_ceiling: tokenCeiling,
      leg_ceiling: legCeiling,
      check_interval_minutes: cadence,
      conversation_id: input.conversationId ?? null,
      // The sweep's clock starts here, not when a worker picks the errand up:
      // one that never reaches Inngest at all has to be closable too.
      last_heartbeat_at: new Date().toISOString(),
    })
    .select(ERRAND_COLUMNS)
    .single();

  if (error || !data) {
    return {
      ok: false,
      reason: 'write_failed',
      message: `No se pudo crear el encargo: ${error?.message ?? 'sin detalle'}`,
    };
  }

  return { ok: true, errand: toErrandView(data as unknown as Record<string, unknown>) };
}

// ---------------------------------------------------------------------------
// What the chat needs to read back
// ---------------------------------------------------------------------------

export interface OpenErrandSummary {
  id: string;
  kind: ErrandKind;
  kindLabel: string;
  request: string;
  state: ErrandView['state'];
  legsUsed: number;
  legCeiling: number;
  spentPercent: number;
  createdAt: string;
  /** Present only while the errand is blocked. This is the point of the tool. */
  question: {
    id: string;
    question: string;
    why: string;
    options: string[];
  } | null;
  /** Only on a finished errand, so the model can read the answer out. */
  deliverable: string | null;
  closingNote: string | null;
}

/**
 * Everything still in flight, plus anything that finished recently.
 *
 * Both, in one call, because the two questions a person actually asks are "¿en
 * qué va lo que te encargué?" and "¿ya quedó?", and a tool that answers only
 * the first makes the model report an errand as running for as long as nobody
 * reloads a screen.
 */
export async function listErrandsForChat(
  db: SupabaseClient,
  opts: { includeFinished?: boolean; limit?: number; conversationId?: string | null } = {},
): Promise<OpenErrandSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const states = opts.includeFinished
    ? ['queued', 'working', 'blocked', 'watching', 'delivered', 'failed', 'exhausted', 'cancelled']
    : ['queued', 'working', 'blocked', 'watching'];

  let query = db
    .from('errands')
    .select(`${ERRAND_COLUMNS}, errand_questions(id, question, why, options, state)`)
    .in('state', states)
    .order('created_at', { ascending: false })
    .limit(limit);

  // Narrowing to one conversation is offered but never the default: an errand
  // started from the /errands screen has no conversation, and a person asking
  // "¿en qué va?" in the chat means all of them, not the subset that happens to
  // share a thread id with the sentence they just typed.
  if (opts.conversationId) query = query.eq('conversation_id', opts.conversationId);

  const { data } = await query;

  return ((data ?? []) as Record<string, unknown>[]).map((row) => {
    const view = toErrandView(row);
    const questions =
      (row.errand_questions as Array<Record<string, unknown>> | null)?.filter(
        (q) => q.state === 'open',
      ) ?? [];
    const open = questions[0];
    return {
      id: view.id,
      kind: view.kind,
      kindLabel: ERRAND_KIND_SPECS[view.kind].label,
      request: view.request,
      state: view.state,
      legsUsed: view.legsUsed,
      legCeiling: view.legCeiling,
      spentPercent:
        view.tokenCeiling > 0 ? Math.round((view.tokensSpent / view.tokenCeiling) * 100) : 0,
      createdAt: view.createdAt,
      question: open
        ? {
            id: open.id as string,
            question: (open.question as string) ?? '',
            why: (open.why as string) ?? '',
            options: Array.isArray(open.options)
              ? (open.options as unknown[]).filter((o): o is string => typeof o === 'string')
              : [],
          }
        : null,
      deliverable: view.deliverable,
      closingNote: view.closingNote,
    };
  });
}

/** The single open question anywhere in this workspace, if there is exactly one. */
export async function findAnswerableQuestion(
  db: SupabaseClient,
  errandId?: string | null,
): Promise<{ errandId: string; questionId: string; question: string } | null> {
  let query = db
    .from('errand_questions')
    .select('id, errand_id, question, asked_at')
    .eq('state', 'open')
    .order('asked_at', { ascending: false })
    .limit(2);
  if (errandId) query = query.eq('errand_id', errandId);

  const { data } = await query;
  const rows = (data ?? []) as Record<string, unknown>[];
  // Two open questions and no errand named: the model would be guessing which
  // one it is answering, and a wrong guess sends an hour of work down the wrong
  // road. Refuse and make it ask which.
  if (rows.length !== 1) return null;
  const row = rows[0] as Record<string, unknown>;
  return {
    errandId: row.errand_id as string,
    questionId: row.id as string,
    question: (row.question as string) ?? '',
  };
}

export type AnswerFromChat =
  | { ok: true; errandId: string; question: string }
  | { ok: false; reason: 'ambiguous' | 'none_open' | 'not_open'; message: string };

/**
 * Answer the question an errand stopped on, from a sentence in the chat.
 *
 * Delegates the actual write to `answerQuestion` in ./lifecycle.ts rather than
 * repeating it: the guard that makes two people answering at once produce ONE
 * resumption is a conditional UPDATE on the question row, and a second copy of
 * a compare-and-set is a second copy that will eventually be subtly different.
 */
export async function answerFromChat(
  db: SupabaseClient,
  input: { errandId?: string | null; answer: string; userId: string },
): Promise<AnswerFromChat> {
  const target = await findAnswerableQuestion(db, input.errandId ?? null);
  if (!target) {
    const { count } = await db
      .from('errand_questions')
      .select('id', { count: 'exact', head: true })
      .eq('state', 'open');
    if ((count ?? 0) === 0) {
      return {
        ok: false,
        reason: 'none_open',
        message: 'Ningún encargo está esperando una respuesta ahora mismo.',
      };
    }
    return {
      ok: false,
      reason: 'ambiguous',
      message:
        'Hay más de un encargo esperando respuesta. Dime a cuál le estás contestando — usa ' +
        'errands.status para verlos y pásame el id del encargo.',
    };
  }

  const outcome = await answerQuestion(db as unknown as ErrandDb, {
    errandId: target.errandId,
    questionId: target.questionId,
    answer: input.answer,
    userId: input.userId,
  });

  if (outcome === 'resumed') {
    return { ok: true, errandId: target.errandId, question: target.question };
  }
  return {
    ok: false,
    reason: 'not_open',
    message:
      'Esa pregunta ya no estaba abierta — puede que alguien más la haya contestado desde la ' +
      'pantalla de Encargos.',
  };
}
