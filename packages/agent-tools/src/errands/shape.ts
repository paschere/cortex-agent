/**
 * THE ERRAND VOCABULARY. One definition, four consumers.
 *
 * An errand is now reachable from four places — the /errands screen, its HTTP
 * routes, the unattended engine in apps/web/lib/errands, and the tools the
 * chat calls by name. Every one of them has to agree on what the states are,
 * what a source looks like and how a row becomes a view, so all of that lives
 * here, in the package, and nothing restates it.
 *
 * `apps/web/lib/errands-shape.ts` is the browser-safe MIRROR of the handful of
 * values the screens need. It exists because importing this barrel from a
 * `'use client'` component drags in `node:dns` and breaks the production build
 * while typecheck and tests stay green — the trap documented in
 * apps/web/lib/commitments-shape.ts. The mirror is a copy, and copies drift, so
 * `errands-shape.test.ts` imports both and fails if they ever disagree.
 *
 * Types are safe to import from here anywhere, including client components:
 * they erase. Values are not.
 */

export const ERRAND_KINDS = ['research_compare', 'gather_sources', 'monitor_change'] as const;
export type ErrandKind = (typeof ERRAND_KINDS)[number];

/**
 * `blocked` is the state this whole feature exists for: the errand stopped and
 * asked, rather than inventing an answer or dying quietly.
 *
 * `exhausted` is deliberately not `failed`. The errand did the work it was
 * allowed to pay for and then stopped — that is the ceiling doing its job, not
 * a fault, and calling it a failure would train people to raise the ceiling.
 */
export const ERRAND_STATES = [
  'queued',
  'working',
  'blocked',
  'watching',
  'delivered',
  'failed',
  'cancelled',
  'exhausted',
] as const;
export type ErrandState = (typeof ERRAND_STATES)[number];

export const TERMINAL_ERRAND_STATES: readonly ErrandState[] = [
  'delivered',
  'failed',
  'cancelled',
  'exhausted',
];

export function isErrandTerminal(state: ErrandState): boolean {
  return TERMINAL_ERRAND_STATES.includes(state);
}

/** States in which a worker should be doing something right now. */
export function isErrandLive(state: ErrandState): boolean {
  return state === 'queued' || state === 'working';
}

export type LegStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';

export const LEG_TERMINAL: readonly LegStatus[] = [
  'completed',
  'failed',
  'interrupted',
  'cancelled',
];

/** One thing the deliverable rests on. Always stamped on screen. */
export interface ErrandSource {
  title: string;
  url: string | null;
  /** ISO instant the fact was read. The whole point of a source ledger. */
  readAt: string;
}

export interface ErrandQuestionView {
  id: string;
  leg: number;
  question: string;
  why: string;
  options: string[];
  state: 'open' | 'answered' | 'withdrawn';
  answer: string | null;
  askedAt: string;
  answeredAt: string | null;
}

export interface ErrandLegView {
  id: string;
  seq: number;
  runId: string | null;
  objective: string;
  status: LegStatus;
  summary: string | null;
  tokens: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface ErrandView {
  id: string;
  kind: ErrandKind;
  request: string;
  brief: string | null;
  state: ErrandState;
  tokenCeiling: number;
  tokensSpent: number;
  legCeiling: number;
  legsUsed: number;
  checkIntervalMinutes: number | null;
  checksDone: number;
  nextCheckAt: string | null;
  /** The conversation this errand was commissioned in, if any. */
  conversationId: string | null;
  currentRunId: string | null;
  findings: string | null;
  deliverable: string | null;
  sources: ErrandSource[];
  closingNote: string | null;
  lastHeartbeatAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** What the detail page polls for: the errand plus everything hanging off it. */
export interface ErrandDetail {
  errand: ErrandView;
  legs: ErrandLegView[];
  questions: ErrandQuestionView[];
  /** Progress of the leg currently working, read off orchestration_tasks. */
  currentLeg: { runId: string; done: number; total: number; working: string[] } | null;
}

export const ERRAND_COLUMNS =
  'id, organization_id, user_id, kind, request, brief, state, token_ceiling, tokens_spent, ' +
  'leg_ceiling, legs_used, check_interval_minutes, checks_done, next_check_at, baseline, ' +
  'conversation_id, current_run_id, findings, deliverable, sources, closing_note, ' +
  'last_heartbeat_at, claimed_at, started_at, finished_at, created_at';

export const ERRAND_LEG_COLUMNS =
  'id, errand_id, seq, run_id, objective, status, summary, tokens, started_at, finished_at';

export const ERRAND_QUESTION_COLUMNS =
  'id, errand_id, leg, question, why, options, state, answer, asked_at, answered_at';

function str(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function int(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Sources are stored as jsonb and therefore arrive as `unknown`. Rows that do
 * not parse are dropped rather than rendered half-formed: a source ledger with
 * a blank row in it is worse than one row shorter.
 */
export function toSources(raw: unknown): ErrandSource[] {
  if (!Array.isArray(raw)) return [];
  const out: ErrandSource[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const title = typeof s.title === 'string' ? s.title.trim() : '';
    if (!title) continue;
    out.push({
      title: title.slice(0, 300),
      url: typeof s.url === 'string' && s.url.trim() ? s.url.trim().slice(0, 2000) : null,
      readAt: typeof s.readAt === 'string' ? s.readAt : new Date(0).toISOString(),
    });
  }
  return out;
}

export function toErrandView(row: Record<string, unknown>): ErrandView {
  return {
    id: row.id as string,
    kind: row.kind as ErrandKind,
    request: (row.request as string) ?? '',
    brief: str(row, 'brief'),
    state: row.state as ErrandState,
    tokenCeiling: int(row, 'token_ceiling'),
    tokensSpent: int(row, 'tokens_spent'),
    legCeiling: int(row, 'leg_ceiling'),
    legsUsed: int(row, 'legs_used'),
    checkIntervalMinutes:
      typeof row.check_interval_minutes === 'number' ? row.check_interval_minutes : null,
    checksDone: int(row, 'checks_done'),
    nextCheckAt: str(row, 'next_check_at'),
    conversationId: str(row, 'conversation_id'),
    currentRunId: str(row, 'current_run_id'),
    findings: str(row, 'findings'),
    deliverable: str(row, 'deliverable'),
    sources: toSources(row.sources),
    closingNote: str(row, 'closing_note'),
    lastHeartbeatAt: str(row, 'last_heartbeat_at') ?? new Date().toISOString(),
    startedAt: str(row, 'started_at'),
    finishedAt: str(row, 'finished_at'),
    createdAt: str(row, 'created_at') ?? new Date().toISOString(),
  };
}

export function toErrandLegView(row: Record<string, unknown>): ErrandLegView {
  return {
    id: row.id as string,
    seq: int(row, 'seq'),
    runId: str(row, 'run_id'),
    objective: (row.objective as string) ?? '',
    status: row.status as LegStatus,
    summary: str(row, 'summary'),
    tokens: int(row, 'tokens'),
    startedAt: str(row, 'started_at') ?? new Date().toISOString(),
    finishedAt: str(row, 'finished_at'),
  };
}

export function toErrandQuestionView(row: Record<string, unknown>): ErrandQuestionView {
  return {
    id: row.id as string,
    leg: int(row, 'leg'),
    question: (row.question as string) ?? '',
    why: (row.why as string) ?? '',
    options: Array.isArray(row.options)
      ? (row.options as unknown[]).filter((o): o is string => typeof o === 'string')
      : [],
    state: (row.state as 'open' | 'answered' | 'withdrawn') ?? 'open',
    answer: str(row, 'answer'),
    askedAt: str(row, 'asked_at') ?? new Date().toISOString(),
    answeredAt: str(row, 'answered_at'),
  };
}
