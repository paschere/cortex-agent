import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AUDIT_SELECT,
  AUDIT_SELECT_LEGACY,
  normaliseAuditRow,
  riskSignals,
  type AuditEventRow,
} from '@/app/api/admin/_lib/audit-filters';

/**
 * Aggregates behind /admin/users and /admin/users/[id].
 *
 * Everything here is deliberately BOUNDED: each read is limited to a time
 * window and a hard row cap, ordered newest-first, and folded up in JS. There
 * is never a query per user or per row — the roster runs two reads total no
 * matter how many teammates exist, and a profile runs one fixed set.
 *
 * When a read hits its cap we say so in the UI rather than quietly showing a
 * wrong number: `capped` means "this is a floor, not the exact total".
 */

export const DAY = 86_400_000;

/** How far back the roster and the profile look. */
export const WINDOW_DAYS = 30;
/** Hard caps — a busy workspace must never pull an unbounded result set. */
export const AUDIT_ROW_CAP = 5000;
export const SECURITY_ROW_CAP = 1000;

export function sinceIso(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

/** `__agent_turn` rows are chat turns, not tool calls — counted separately. */
export const AGENT_TURN = '__agent_turn';

/* ------------------------------------------------------------------ roster */

export interface RosterActivity {
  /** Tool calls (excluding chat turns) in the last 7 days. */
  calls7d: number;
  /** Everything recorded in the window, chat turns included. */
  events30d: number;
  /** Newest audit_events.created_at seen in the window, or null. */
  lastActive: string | null;
  /** security_events in the last 30 days. */
  flagged30d: number;
}

export interface RosterActivityResult {
  byUser: Record<string, RosterActivity>;
  /** The audit read hit its cap — the numbers shown are a floor. */
  capped: boolean;
  windowDays: number;
}

const EMPTY_ROSTER: RosterActivity = {
  calls7d: 0,
  events30d: 0,
  lastActive: null,
  flagged30d: 0,
};

export function rosterFor(
  result: RosterActivityResult,
  userId: string,
): RosterActivity {
  return result.byUser[userId] ?? EMPTY_ROSTER;
}

/**
 * Per-user at-a-glance numbers for the whole roster in exactly two reads.
 *
 * 1. audit_events over the last 30 days, newest first, capped at 5 000 rows —
 *    serves the 7-day call count AND "last active" (exact, because the rows
 *    arrive newest-first, so the cap only ever truncates the oldest tail).
 * 2. security_events over the last 30 days, capped at 1 000 rows — serves the
 *    "N flagged" pill. Missing on databases that have not run 0042; the read
 *    simply yields nothing and every user reads as unflagged.
 *
 * Only pre-0042 columns are selected, so no legacy fallback is needed here.
 */
export async function fetchRosterActivity(sb: SupabaseClient): Promise<RosterActivityResult> {
  const since30 = sinceIso(WINDOW_DAYS);
  const since7 = sinceIso(7);

  const [auditRes, securityRes] = await Promise.all([
    sb
      .from('audit_events')
      .select('user_id, tool_id, created_at')
      .gte('created_at', since30)
      .order('created_at', { ascending: false })
      .limit(AUDIT_ROW_CAP),
    sb
      .from('security_events')
      .select('user_id')
      .gte('created_at', since30)
      .limit(SECURITY_ROW_CAP),
  ]);

  const auditRows = (auditRes.data ?? []) as unknown as Array<Record<string, unknown>>;
  const securityRows = (securityRes.data ?? []) as unknown as Array<Record<string, unknown>>;

  const byUser: Record<string, RosterActivity> = {};
  const bucket = (id: string) => (byUser[id] ??= { ...EMPTY_ROSTER });

  for (const r of auditRows) {
    const userId = String(r.user_id ?? '');
    if (!userId) continue;
    const createdAt = String(r.created_at ?? '');
    const toolId = String(r.tool_id ?? '');
    const b = bucket(userId);
    b.events30d += 1;
    if (toolId !== AGENT_TURN && createdAt >= since7) b.calls7d += 1;
    if (!b.lastActive || createdAt > b.lastActive) b.lastActive = createdAt;
  }

  for (const r of securityRows) {
    const userId = String(r.user_id ?? '');
    if (!userId) continue;
    bucket(userId).flagged30d += 1;
  }

  return {
    byUser,
    capped: auditRows.length >= AUDIT_ROW_CAP,
    windowDays: WINDOW_DAYS,
  };
}

/* ----------------------------------------------------------------- profile */

export interface ToolUsage {
  toolId: string;
  count: number;
  errors: number;
  avgLatency: number;
}

export interface DayPoint {
  day: string;
  ok: number;
  error: number;
}

export interface UserUsage {
  calls7d: number;
  calls30d: number;
  turns30d: number;
  distinctTools: number;
  successRate: number | null;
  avgLatency: number;
  lastActive: string | null;
  bySurface: Record<string, number>;
  topTools: ToolUsage[];
  days: DayPoint[];
  /** Newest-first slice for the "recent activity" table. */
  recent: AuditEventRow[];
  /** The read hit its cap — numbers are a floor for this window. */
  capped: boolean;
  /** 0042 columns are missing on this database. */
  legacySchema: boolean;
}

/**
 * One bounded audit read (30 days, newest first, 5 000 rows) folded into every
 * usage number the profile shows. Falls back to the pre-0042 column set so the
 * page still renders against an un-migrated database.
 */
export async function fetchUserUsage(sb: SupabaseClient, userId: string): Promise<UserUsage> {
  const since30 = sinceIso(WINDOW_DAYS);
  const since7 = sinceIso(7);

  const run = (select: string) =>
    sb
      .from('audit_events')
      .select(select)
      .eq('user_id', userId)
      // Sin las filas de intención (0118): attempted + ok son UNA acción.
      .neq('status', 'attempted')
      .gte('created_at', since30)
      .order('created_at', { ascending: false })
      .limit(AUDIT_ROW_CAP);

  let legacySchema = false;
  let res = await run(AUDIT_SELECT);
  if (res.error) {
    legacySchema = true;
    res = await run(AUDIT_SELECT_LEGACY);
  }

  const rows = ((res.data ?? []) as unknown as Array<Record<string, unknown>>).map(
    normaliseAuditRow,
  );

  const byTool: Record<string, { count: number; errors: number; latencySum: number; n: number }> =
    {};
  const byDay: Record<string, { ok: number; error: number }> = {};
  const bySurface: Record<string, number> = { web: 0, mcp: 0, schedule: 0, unknown: 0 };

  let calls7d = 0;
  let calls30d = 0;
  let turns30d = 0;
  let ok = 0;
  let errors = 0;
  let latencySum = 0;
  let latencyN = 0;

  for (const e of rows) {
    const isTurn = e.tool_id === AGENT_TURN;
    if (isTurn) {
      turns30d += 1;
    } else {
      calls30d += 1;
      if (e.created_at >= since7) calls7d += 1;
      const t = (byTool[e.tool_id] ??= { count: 0, errors: 0, latencySum: 0, n: 0 });
      t.count += 1;
      if (e.status === 'error') t.errors += 1;
      if (e.latency_ms > 0) {
        t.latencySum += e.latency_ms;
        t.n += 1;
      }
    }

    if (e.status === 'error') errors += 1;
    else if (e.status === 'ok') ok += 1;

    if (e.latency_ms > 0) {
      latencySum += e.latency_ms;
      latencyN += 1;
    }

    const day = e.created_at.slice(0, 10);
    const d = (byDay[day] ??= { ok: 0, error: 0 });
    if (e.status === 'error') d.error += 1;
    else d.ok += 1;

    const surface = e.surface === 'web' || e.surface === 'mcp' || e.surface === 'schedule'
      ? e.surface
      : 'unknown';
    bySurface[surface] = (bySurface[surface] ?? 0) + 1;
  }

  const days: DayPoint[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * DAY).toISOString().slice(0, 10);
    days.push({ day, ok: byDay[day]?.ok ?? 0, error: byDay[day]?.error ?? 0 });
  }

  const topTools: ToolUsage[] = Object.entries(byTool)
    .map(([toolId, t]) => ({
      toolId,
      count: t.count,
      errors: t.errors,
      avgLatency: t.n > 0 ? Math.round(t.latencySum / t.n) : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    calls7d,
    calls30d,
    turns30d,
    distinctTools: Object.keys(byTool).length,
    successRate: ok + errors > 0 ? Math.round((ok / (ok + errors)) * 100) : null,
    avgLatency: latencyN > 0 ? Math.round(latencySum / latencyN) : 0,
    lastActive: rows[0]?.created_at ?? null,
    bySurface,
    topTools,
    days,
    recent: rows.slice(0, 25),
    capped: rows.length >= AUDIT_ROW_CAP,
    legacySchema,
  };
}

/* ---------------------------------------------------------------- security */

export interface UserSecurityEvent {
  id: string;
  tool_id: string;
  surface: string | null;
  risk_level: string;
  decision: string;
  reason: string;
  signals: string[];
  created_at: string;
}

export interface UserSecurity {
  events: UserSecurityEvent[];
  flagged7d: number;
  flagged30d: number;
  blocked7d: number;
  blocked30d: number;
  /** security_events is missing (pre-0042 database). */
  unavailable: boolean;
}

/**
 * One bounded read (30 days, newest first, 1 000 rows). A missing table on a
 * pre-0042 database resolves to "unavailable" rather than an error page.
 */
export async function fetchUserSecurity(
  sb: SupabaseClient,
  userId: string,
): Promise<UserSecurity> {
  const since30 = sinceIso(WINDOW_DAYS);
  const since7 = sinceIso(7);

  const res = await sb
    .from('security_events')
    .select('id, tool_id, surface, risk_level, decision, reason, signals, created_at')
    .eq('user_id', userId)
    .gte('created_at', since30)
    .order('created_at', { ascending: false })
    .limit(SECURITY_ROW_CAP);

  if (res.error) {
    return {
      events: [],
      flagged7d: 0,
      flagged30d: 0,
      blocked7d: 0,
      blocked30d: 0,
      unavailable: true,
    };
  }

  const events: UserSecurityEvent[] = ((res.data ?? []) as unknown as Array<
    Record<string, unknown>
  >).map((r) => ({
    id: String(r.id ?? ''),
    tool_id: String(r.tool_id ?? ''),
    surface: (r.surface as string | null) ?? null,
    risk_level: String(r.risk_level ?? 'low'),
    decision: String(r.decision ?? 'allowed'),
    reason: String(r.reason ?? ''),
    signals: riskSignals(r.signals),
    created_at: String(r.created_at ?? ''),
  }));

  const counts = (from: string, decision: string) =>
    events.filter((e) => e.created_at >= from && e.decision === decision).length;

  return {
    events,
    flagged7d: counts(since7, 'flagged'),
    flagged30d: counts(since30, 'flagged'),
    blocked7d: counts(since7, 'blocked'),
    blocked30d: counts(since30, 'blocked'),
    unavailable: false,
  };
}
