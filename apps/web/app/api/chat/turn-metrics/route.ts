import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { loadTurnLatencies } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * HOW LONG EACH STEP OF THE LAST TURN REALLY TOOK.
 *
 * ===========================================================================
 * WHY THIS READS TWO TABLES AND MEASURES NOTHING ITSELF
 * ===========================================================================
 * The task rows want a duration per tool call. There was a tempting shortcut —
 * start a stopwatch in the browser when a tool invocation appears in the stream
 * and stop it when its result arrives — and it is wrong twice over. It would be
 * a SECOND measurement of something already measured, free to disagree with the
 * one the product reports everywhere else; and it would measure the wrong
 * thing, since it includes stream scheduling and whatever the tab was doing.
 *
 * Both numbers already exist, in two places, for two different reasons:
 *
 *   `turn_latencies` (migration 0084) — the SHAPE OF THE TURN. How long before
 *     the first visible character, how much of that was Cortex's own prelude,
 *     how many tool calls there were and how many milliseconds went into them
 *     in total. It deliberately keeps no per-tool breakdown: see the note in
 *     latency/types.ts, which says so and points here.
 *
 *   `audit_events` — ONE ROW PER TOOL CALL, each with its own `latency_ms`,
 *     written by `runTool` whether the call succeeded or failed. That is the
 *     per-tool breakdown, and it is not duplicated into the latency table
 *     precisely so there is one answer to "how long did that call take".
 *
 * So this route joins them and invents nothing.
 *
 * ===========================================================================
 * MATCHING A ROW TO A CALL
 * ===========================================================================
 * `audit_events` has no tool-call id — it predates the AI SDK's — so a turn
 * that called `vehicles.check_runt` three times produces three rows that look
 * alike. They are matched to the invocations POSITIONALLY, per tool id: the
 * nth row for a tool is the nth call to it. That holds because `runTool` writes
 * one row per call in call order, and it degrades safely — a mismatch shows a
 * duration against the wrong call of the same tool, never against a different
 * tool, and never a number that was not measured.
 *
 * The window is the turn: rows written at or after the latency row's own start.
 * A conversation resumed tomorrow does not pick up yesterday's timings.
 */

/** One turn's worth. A chat turn is capped at 12 steps, so this is generous. */
const MAX_TOOL_ROWS = 60;

export async function GET(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get('conversationId');
  if (!conversationId) return NextResponse.json({ metrics: null });

  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  // Newest turn of this conversation. The scoped handle means another
  // workspace's id returns nothing rather than somebody else's timings.
  const [latest] = await loadTurnLatencies(db, { conversationId, limit: 1 }).catch(() => []);
  if (!latest) return NextResponse.json({ metrics: null });

  // `createdAt` is when the row was written, i.e. after the answer finished.
  // The turn began `totalMs` before that, less a little slack for the write.
  const startedAt = new Date(Date.parse(latest.createdAt) - latest.totalMs - 2_000).toISOString();

  const { data: events } = await db
    .from('audit_events')
    .select('tool_id, latency_ms, status, created_at')
    .eq('conversation_id', conversationId)
    .gte('created_at', startedAt)
    // The turn's own summary row, not a tool. Excluded so it cannot be matched
    // to an invocation.
    .neq('tool_id', '__agent_turn')
    .order('created_at', { ascending: true })
    .limit(MAX_TOOL_ROWS);

  return NextResponse.json({
    metrics: {
      messageId: latest.messageId,
      /** Before anything appeared on screen. */
      firstVisibleMs: latest.firstVisibleMs,
      /** Of that, how much was Cortex's own work rather than the model's. */
      preludeMs: latest.preludeMs,
      totalMs: latest.totalMs,
      toolCalls: latest.toolCalls,
      toolMs: latest.toolMs,
      /** In call order, so the client can match positionally per tool id. */
      calls: (events ?? []).map((e) => ({
        toolId: e.tool_id as string,
        ms: (e.latency_ms as number | null) ?? null,
        status: e.status as string,
      })),
    },
  });
}
