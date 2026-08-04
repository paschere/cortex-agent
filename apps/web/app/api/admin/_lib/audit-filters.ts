import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Single source of truth for the audit-log filter contract.
 *
 * Both the server-rendered /admin/audit page and the CSV export route parse
 * the same query params through here, so an export always matches exactly what
 * the auditor is looking at on screen.
 */

export const AUDIT_STATUSES = ['ok', 'error', 'confirmation_required', 'rate_limited'] as const;
export const AUDIT_SURFACES = ['web', 'mcp', 'schedule'] as const;
export const AUDIT_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export const AUDIT_DECISIONS = ['allowed', 'flagged', 'blocked', 'confirmed'] as const;
export const AUDIT_RANGES = ['24h', '7d', '30d', 'all'] as const;

export type AuditRange = (typeof AUDIT_RANGES)[number];

export const RANGE_LABEL: Record<AuditRange, string> = {
  '24h': 'Últimas 24h',
  '7d': 'Últimos 7 días',
  '30d': 'Últimos 30 días',
  all: 'Todo',
};

export const SURFACE_LABEL: Record<string, string> = {
  web: 'App web',
  mcp: 'Claude / MCP',
  schedule: 'Rutinas',
  unknown: 'Sin registrar',
};

export interface AuditFilters {
  /** 'all' or one of AUDIT_STATUSES. */
  status: string;
  /** Tool family prefix (matched as `tool_id like '<tool>%'`), or ''. */
  tool: string;
  /** User uuid, or ''. */
  user: string;
  /** 'all' or one of AUDIT_SURFACES. */
  surface: string;
  /** 'all' or one of AUDIT_RISK_LEVELS. */
  risk: string;
  /** 'all' or one of AUDIT_DECISIONS. */
  decision: string;
  range: AuditRange;
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = {
  status: 'all',
  tool: '',
  user: '',
  surface: 'all',
  risk: 'all',
  decision: 'all',
  range: '7d',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RawParams = Record<string, string | string[] | undefined>;

function first(sp: RawParams, key: string): string {
  const v = sp[key];
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

function oneOf(value: string, allowed: readonly string[], fallback: string): string {
  return allowed.includes(value) ? value : fallback;
}

/** Reads (and sanitises) the filter set out of URL search params. */
export function parseAuditFilters(sp: RawParams): AuditFilters {
  const user = first(sp, 'user');
  return {
    status: oneOf(first(sp, 'status'), AUDIT_STATUSES, 'all'),
    tool: first(sp, 'tool').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64),
    user: UUID_RE.test(user) ? user : '',
    surface: oneOf(first(sp, 'surface'), AUDIT_SURFACES, 'all'),
    risk: oneOf(first(sp, 'risk'), AUDIT_RISK_LEVELS, 'all'),
    decision: oneOf(first(sp, 'decision'), AUDIT_DECISIONS, 'all'),
    range: oneOf(first(sp, 'range'), AUDIT_RANGES, '7d') as AuditRange,
  };
}

/** ISO cut-off for a range, or null for 'all'. */
export function auditRangeSince(range: AuditRange): string | null {
  const days = range === '24h' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : null;
  if (days === null) return null;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** URLSearchParams holding only the non-default filters (stable ordering). */
export function auditSearchParams(f: AuditFilters, patch: Partial<AuditFilters> = {}): URLSearchParams {
  const merged = { ...f, ...patch };
  const params = new URLSearchParams();
  if (merged.status !== 'all') params.set('status', merged.status);
  if (merged.tool) params.set('tool', merged.tool);
  if (merged.user) params.set('user', merged.user);
  if (merged.surface !== 'all') params.set('surface', merged.surface);
  if (merged.risk !== 'all') params.set('risk', merged.risk);
  if (merged.decision !== 'all') params.set('decision', merged.decision);
  if (merged.range !== '7d') params.set('range', merged.range);
  return params;
}

/** `/admin/audit?...` href for the given filters with an optional patch applied. */
export function auditHref(f: AuditFilters, patch: Partial<AuditFilters> = {}): string {
  const qs = auditSearchParams(f, patch).toString();
  return `/admin/audit${qs ? `?${qs}` : ''}`;
}

/** Human sentence describing the active filter set (used in the UI + CSV name). */
export function describeAuditFilters(f: AuditFilters): string {
  const parts: string[] = [RANGE_LABEL[f.range].toLowerCase()];
  if (f.status !== 'all') parts.push(`estado ${f.status.replaceAll('_', ' ')}`);
  if (f.surface !== 'all') parts.push(`superficie ${SURFACE_LABEL[f.surface] ?? f.surface}`);
  if (f.risk !== 'all') parts.push(`riesgo ${f.risk}`);
  if (f.decision !== 'all') parts.push(`decisión ${f.decision}`);
  if (f.tool) parts.push(`herramienta ${f.tool}*`);
  return parts.join(' · ');
}

/** Columns we ask Postgres for, including the 0042 security columns. */
export const AUDIT_SELECT =
  'id, user_id, agent_id, conversation_id, tool_id, input_hash, status, latency_ms, created_at, metadata, surface, risk_level, decision, risk_reason, risk_signals';

/** Pre-0042 column set — used if the security columns are not there yet. */
export const AUDIT_SELECT_LEGACY =
  'id, user_id, agent_id, conversation_id, tool_id, input_hash, status, latency_ms, created_at, metadata';

export interface AuditEventRow {
  id: string;
  user_id: string;
  agent_id: string | null;
  conversation_id: string | null;
  tool_id: string;
  input_hash: string | null;
  status: string;
  latency_ms: number;
  created_at: string;
  metadata: Record<string, unknown> | null;
  surface: string | null;
  risk_level: string | null;
  decision: string | null;
  risk_reason: string | null;
  risk_signals: unknown;
}

/** Normalises a raw row so the UI never has to guard on missing columns. */
export function normaliseAuditRow(raw: Record<string, unknown>): AuditEventRow {
  return {
    id: String(raw.id ?? ''),
    user_id: String(raw.user_id ?? ''),
    agent_id: (raw.agent_id as string | null) ?? null,
    conversation_id: (raw.conversation_id as string | null) ?? null,
    tool_id: String(raw.tool_id ?? ''),
    input_hash: (raw.input_hash as string | null) ?? null,
    status: String(raw.status ?? ''),
    latency_ms: Number(raw.latency_ms ?? 0),
    created_at: String(raw.created_at ?? ''),
    metadata: (raw.metadata as Record<string, unknown> | null) ?? null,
    surface: (raw.surface as string | null) ?? null,
    risk_level: (raw.risk_level as string | null) ?? null,
    decision: (raw.decision as string | null) ?? null,
    risk_reason: (raw.risk_reason as string | null) ?? null,
    risk_signals: raw.risk_signals ?? [],
  };
}

/** risk_signals is jsonb — accept an array, a JSON string, or nothing. */
export function riskSignals(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((s) => String(s)).filter(Boolean).slice(0, 24);
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((s) => String(s)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

interface QueryLike {
  eq(column: string, value: unknown): QueryLike;
  like(column: string, pattern: string): QueryLike;
  gte(column: string, value: unknown): QueryLike;
}

/** Applies the filter set to any PostgREST query builder over audit_events. */
export function applyAuditFilters<Q extends QueryLike>(query: Q, f: AuditFilters): Q {
  let q: QueryLike = query;
  if (f.status !== 'all') q = q.eq('status', f.status);
  if (f.tool) q = q.like('tool_id', `${f.tool}%`);
  if (f.user) q = q.eq('user_id', f.user);
  if (f.surface !== 'all') q = q.eq('surface', f.surface);
  if (f.risk !== 'all') q = q.eq('risk_level', f.risk);
  if (f.decision !== 'all') q = q.eq('decision', f.decision);
  const since = auditRangeSince(f.range);
  if (since) q = q.gte('created_at', since);
  return q as Q;
}

export interface AuditPage {
  rows: AuditEventRow[];
  /** Total matching rows, when Postgres could count them. */
  total: number | null;
  /** True when the 0042 security columns are not available in this database. */
  legacySchema: boolean;
}

/**
 * Fetches one page of audit events for the given filters.
 * Falls back to the pre-0042 column set if the security columns are missing so
 * the page still renders against an un-migrated database.
 */
export async function fetchAuditEvents(
  sb: SupabaseClient,
  filters: AuditFilters,
  opts: { limit: number; offset?: number; count?: boolean },
): Promise<AuditPage> {
  const offset = opts.offset ?? 0;
  const run = async (select: string, withCount: boolean) => {
    const base = sb
      .from('audit_events')
      .select(select, withCount ? { count: 'exact' } : undefined);
    const filtered = applyAuditFilters(base, filters);
    return filtered
      .order('created_at', { ascending: false })
      .range(offset, offset + opts.limit - 1);
  };

  let legacySchema = false;
  let res = await run(AUDIT_SELECT, opts.count === true);
  if (res.error) {
    // Security columns missing (or the count failed) — retry on the base set.
    legacySchema = true;
    res = await run(AUDIT_SELECT_LEGACY, opts.count === true);
  }
  if (res.error) return { rows: [], total: 0, legacySchema };

  const rows = ((res.data ?? []) as unknown as Record<string, unknown>[]).map(normaliseAuditRow);
  return { rows, total: res.count ?? null, legacySchema };
}

/** id → display name for a set of users, in one round trip. */
export async function fetchUserNames(
  sb: SupabaseClient,
  ids: string[],
): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return {};
  const { data } = await sb.from('users').select('id, email, name').in('id', unique);
  const rows = (data ?? []) as unknown as Array<{ id: string; email: string; name: string | null }>;
  return Object.fromEntries(rows.map((u) => [u.id, u.name || u.email]));
}
