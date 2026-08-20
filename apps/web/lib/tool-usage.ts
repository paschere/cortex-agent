import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Recent tool usage, aggregated for the tools control centre.
 *
 * WHY THIS IS A SCAN AND NOT A GROUP BY. `audit_events` has no aggregate view
 * and adding one means a migration, which this change is not allowed to ship.
 * PostgREST cannot express `group by tool_id` either, so the honest options
 * were N queries (one count per tool — ~180 round trips on this registry) or
 * one bounded scan folded in memory. This is the scan.
 *
 * WHAT THAT COSTS AND WHAT IT BUYS. Three narrow columns, one index-ordered
 * read on `audit_events(organization_id, created_at desc)`, capped at
 * USAGE_SCAN_LIMIT rows. A busy workspace crosses that cap and the window
 * effectively shortens — which is why `truncated` and `oldest` are part of the
 * result and are SHOWN on screen. A number whose window the reader cannot see
 * is worse than no number: they will read "3 usos" as "three times in 30 days"
 * when it means "three times in the last four hours of a very busy day".
 *
 * FAILS SOFT. Any error returns an empty report with `available: false`; the
 * catalogue then renders without usage instead of not rendering at all.
 */

/** How far back the report looks when the workspace is quiet enough to reach. */
export const USAGE_WINDOW_DAYS = 30;

/** Hard ceiling on rows folded into the report. See the note above. */
export const USAGE_SCAN_LIMIT = 5000;

/** Audit rows for a whole agent turn are filed under this pseudo tool id. */
const AGENT_TURN_TOOL_ID = '__agent_turn';

export interface ToolUsage {
  /** Calls that reached the handler and returned. */
  ok: number;
  /** Calls that ended in an error — the handler threw, or the guardrail blocked. */
  errors: number;
  /** Calls that stopped to ask a person first. */
  awaitingConfirmation: number;
  /** Calls refused by the rate limiter. */
  rateLimited: number;
  /** Every row, whatever its status. */
  total: number;
  /** ISO timestamp of the most recent call. */
  lastAt: string;
  /** Status of that most recent call. */
  lastStatus: string;
}

export interface UsageReport {
  /** Empty when the query failed — the UI drops the usage column rather than lie. */
  available: boolean;
  byTool: Record<string, ToolUsage>;
  /** Rows actually folded in. */
  scanned: number;
  /** True when the scan hit USAGE_SCAN_LIMIT and the window is really shorter. */
  truncated: boolean;
  /** Start of the requested window, ISO. */
  since: string;
  /** Oldest row actually seen, ISO — the true left edge when truncated. */
  oldest: string | null;
  /** Distinct tools that ran at least once inside what was scanned. */
  distinctTools: number;
}

const EMPTY: UsageReport = {
  available: false,
  byTool: {},
  scanned: 0,
  truncated: false,
  since: '',
  oldest: null,
  distinctTools: 0,
};

interface UsageRow {
  tool_id: string;
  status: string;
  created_at: string;
}

/**
 * Folds the last USAGE_WINDOW_DAYS of `audit_events` into per-tool counters.
 * `sb` must already be scoped to the workspace.
 */
export async function fetchToolUsage(sb: SupabaseClient): Promise<UsageReport> {
  const since = new Date(Date.now() - USAGE_WINDOW_DAYS * 86_400_000).toISOString();

  const { data, error } = await sb
    .from('audit_events')
    .select('tool_id, status, created_at')
    .gte('created_at', since)
    .neq('tool_id', AGENT_TURN_TOOL_ID)
    // Sin las filas de intención (0118): attempted + ok son UNA llamada.
    .neq('status', 'attempted')
    .order('created_at', { ascending: false })
    .limit(USAGE_SCAN_LIMIT);

  if (error) {
    console.error('[tool-usage] could not read audit_events, rendering without usage:', error);
    return { ...EMPTY, since };
  }

  const rows = (data ?? []) as unknown as UsageRow[];
  const byTool: Record<string, ToolUsage> = {};

  // Rows arrive newest-first, so the first row seen for a tool IS its last run.
  for (const row of rows) {
    if (!row.tool_id) continue;
    const entry = byTool[row.tool_id];
    if (entry) {
      entry.total += 1;
      bump(entry, row.status);
    } else {
      const fresh: ToolUsage = {
        ok: 0,
        errors: 0,
        awaitingConfirmation: 0,
        rateLimited: 0,
        total: 1,
        lastAt: row.created_at,
        lastStatus: row.status,
      };
      bump(fresh, row.status);
      byTool[row.tool_id] = fresh;
    }
  }

  return {
    available: true,
    byTool,
    scanned: rows.length,
    truncated: rows.length >= USAGE_SCAN_LIMIT,
    since,
    oldest: rows.length > 0 ? (rows[rows.length - 1]?.created_at ?? null) : null,
    distinctTools: Object.keys(byTool).length,
  };
}

function bump(entry: ToolUsage, status: string): void {
  if (status === 'ok') entry.ok += 1;
  else if (status === 'error') entry.errors += 1;
  else if (status === 'confirmation_required') entry.awaitingConfirmation += 1;
  else if (status === 'rate_limited') entry.rateLimited += 1;
}
