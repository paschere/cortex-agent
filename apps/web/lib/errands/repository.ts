import 'server-only';
// The WIRE contract, declared once in the browser-safe mirror and imported by
// both ends. Typing the response against the file the screen reads is what
// stops the two drifting without anything failing.
import type { ErrandDetail } from '@/lib/errands-shape';
import {
  ERRAND_COLUMNS,
  ERRAND_LEG_COLUMNS,
  ERRAND_QUESTION_COLUMNS,
  type ErrandLegView,
  type ErrandQuestionView,
  type ErrandSource,
  type ErrandView,
  toErrandLegView,
  toErrandQuestionView,
  toErrandView,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type ErrandSnapshot, type LegSnapshot, describeState } from './engine';

/**
 * Every read the errand surface and the engine do, in one place.
 *
 * `organizationId` is not optional anywhere an errand is fetched by id. Tenant
 * scoping belongs in the query, so forgetting it is a type error rather than a
 * cross-workspace leak nobody notices — the same rule the orchestrator's
 * repository states, and the reason an errand id from another company is a 404
 * rather than a document.
 */

export interface ErrandRow {
  view: ErrandView;
  /** Not exposed to the browser: the person the unattended engine acts as. */
  userId: string | null;
  /** Monitors compare against this. Not shown; it is machine input. */
  baseline: string | null;
}

export async function loadErrand(
  db: SupabaseClient,
  errandId: string,
  organizationId: string,
): Promise<ErrandRow | null> {
  const { data } = await db
    .from('errands')
    .select(ERRAND_COLUMNS)
    .eq('id', errandId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as Record<string, unknown>;
  return {
    view: toErrandView(row),
    userId: (row.user_id as string | null) ?? null,
    baseline: (row.baseline as string | null) ?? null,
  };
}

export interface ErrandSummaryRow extends ErrandView {
  openQuestions: number;
}

export async function listErrands(
  db: SupabaseClient,
  organizationId: string,
  limit = 40,
): Promise<ErrandSummaryRow[]> {
  const { data } = await db
    .from('errands')
    .select(`${ERRAND_COLUMNS}, errand_questions(state)`)
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  return ((data ?? []) as Record<string, unknown>[]).map((row) => {
    const questions = (row.errand_questions as Array<{ state: string }> | null) ?? [];
    return {
      ...toErrandView(row),
      openQuestions: questions.filter((q) => q.state === 'open').length,
    };
  });
}

export async function loadLegs(db: SupabaseClient, errandId: string): Promise<ErrandLegView[]> {
  const { data } = await db
    .from('errand_legs')
    .select(`${ERRAND_LEG_COLUMNS}, assessed_at`)
    .eq('errand_id', errandId)
    .order('seq', { ascending: true });
  return ((data ?? []) as Record<string, unknown>[]).map(toErrandLegView);
}

/** Legs with the one field the browser never needs and the engine always does. */
export async function loadLegSnapshots(
  db: SupabaseClient,
  errandId: string,
): Promise<Array<LegSnapshot & { id: string }>> {
  const { data } = await db
    .from('errand_legs')
    .select('id, seq, run_id, status, started_at, assessed_at')
    .eq('errand_id', errandId)
    .order('seq', { ascending: true });
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    seq: (row.seq as number) ?? 0,
    status: row.status as LegSnapshot['status'],
    runId: (row.run_id as string | null) ?? null,
    startedAt: (row.started_at as string | null) ?? new Date(0).toISOString(),
    assessed: row.assessed_at != null,
  }));
}

export async function loadQuestions(
  db: SupabaseClient,
  errandId: string,
): Promise<ErrandQuestionView[]> {
  const { data } = await db
    .from('errand_questions')
    .select(ERRAND_QUESTION_COLUMNS)
    .eq('errand_id', errandId)
    .order('asked_at', { ascending: true });
  return ((data ?? []) as Record<string, unknown>[]).map(toErrandQuestionView);
}

/** Everything the engine needs to decide, assembled from rows and nothing else. */
export async function loadSnapshot(
  db: SupabaseClient,
  errandId: string,
  organizationId: string,
): Promise<{
  row: ErrandRow;
  legs: Array<LegSnapshot & { id: string }>;
  snapshot: ErrandSnapshot;
} | null> {
  const row = await loadErrand(db, errandId, organizationId);
  if (!row) return null;
  const [legs, questions] = await Promise.all([
    loadLegSnapshots(db, errandId),
    loadQuestions(db, errandId),
  ]);
  const view = row.view;
  return {
    row,
    legs,
    snapshot: {
      state: view.state,
      kind: view.kind,
      brief: view.brief,
      spend: {
        tokensSpent: view.tokensSpent,
        tokenCeiling: view.tokenCeiling,
        legsUsed: view.legsUsed,
        legCeiling: view.legCeiling,
      },
      legs,
      openQuestion: questions.some((q) => q.state === 'open'),
      checksDone: view.checksDone,
      nextCheckAt: view.nextCheckAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Reading the orchestrator's rows
// ---------------------------------------------------------------------------

export interface RunOutcome {
  status: string;
  summary: string | null;
  totalTokens: number;
  /** One line per sub-agent, for the assessor. */
  taskDigest: string;
  /** Did anything come back that a person could use? */
  usableOutput: boolean;
  done: number;
  total: number;
  working: string[];
}

/**
 * What a commissioned run produced, read from the orchestrator's own tables.
 *
 * `usableOutput` is computed HERE, from rows, and never asked of a model. "Did
 * this produce anything" is a fact about task statuses and the length of the
 * report; letting the assessor answer it would let a confident model paper
 * over an empty run, which is precisely the silent failure the errand exists
 * to prevent.
 */
export async function readRunOutcome(
  db: SupabaseClient,
  runId: string,
): Promise<RunOutcome | null> {
  const { data: run } = await db
    .from('orchestration_runs')
    .select('status, summary, total_tokens')
    .eq('id', runId)
    .maybeSingle();
  if (!run) return null;

  const { data: taskRows } = await db
    .from('orchestration_tasks')
    .select('seq, title, status, result')
    .eq('run_id', runId)
    .order('seq', { ascending: true });

  const tasks = ((taskRows ?? []) as Record<string, unknown>[]).map((t) => ({
    seq: (t.seq as number) ?? 0,
    title: (t.title as string) ?? '',
    status: (t.status as string) ?? 'pending',
    result: (t.result as string | null) ?? null,
  }));

  const completed = tasks.filter((t) => t.status === 'completed');
  const summary = ((run as Record<string, unknown>).summary as string | null) ?? null;

  return {
    status: ((run as Record<string, unknown>).status as string) ?? 'failed',
    summary,
    totalTokens: ((run as Record<string, unknown>).total_tokens as number | null) ?? 0,
    taskDigest:
      tasks.length > 0
        ? tasks.map((t) => `- [${t.status}] ${t.seq}. ${t.title}`).join('\n')
        : '(the run never planned a single sub-agent)',
    // Both conditions, because either alone lies. A run can complete every
    // task and still write nothing; it can write a paragraph of apology with
    // no completed task behind it. 200 characters is roughly one real finding.
    usableOutput: completed.length > 0 && (summary?.trim().length ?? 0) > 200,
    done: completed.length,
    total: tasks.length,
    working: tasks.filter((t) => t.status === 'running').map((t) => t.title),
  };
}

/**
 * Provenance harvested from what the run ACTUALLY FETCHED, not from what the
 * model says it read.
 *
 * A model asked to list its sources will produce a plausible list, and a
 * plausible list of URLs is indistinguishable from a real one until somebody
 * clicks it. So the ledger starts from the event log: every `web.scrape` call
 * carries the URL it was given in its arguments, and the event's own timestamp
 * is when it was read. Those entries are true by construction.
 *
 * The assessor's list is merged on top for the things the log cannot name — an
 * internal document, a search result quoted without being scraped — and loses
 * every collision, because a harvested entry has evidence behind it and a
 * claimed one has none.
 */
export async function harvestSources(db: SupabaseClient, runId: string): Promise<ErrandSource[]> {
  const { data } = await db
    .from('orchestration_events')
    .select('payload, created_at')
    .eq('run_id', runId)
    .eq('kind', 'tool_call')
    .order('id', { ascending: true })
    .limit(400);

  const out: ErrandSource[] = [];
  const seen = new Set<string>();

  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const payload = (row.payload as Record<string, unknown> | null) ?? {};
    if (payload.toolId !== 'web.scrape') continue;
    const args = typeof payload.args === 'string' ? payload.args : '';
    const match = args.match(/"url"\s*:\s*"([^"]+)"/);
    const url = match?.[1];
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: hostOf(url),
      url: url.slice(0, 2000),
      readAt: (row.created_at as string | null) ?? new Date().toISOString(),
    });
  }
  return out;
}

/** Harvested entries win; claimed ones fill the gaps. See `harvestSources`. */
export function mergeSources(harvested: ErrandSource[], claimed: ErrandSource[]): ErrandSource[] {
  const byUrl = new Map<string, ErrandSource>();
  for (const source of harvested) {
    if (source.url) byUrl.set(source.url, source);
  }
  // A claimed entry with a URL we harvested only contributes its title, which
  // is better than a bare hostname.
  for (const source of claimed) {
    if (source.url && byUrl.has(source.url)) {
      const existing = byUrl.get(source.url);
      if (existing) byUrl.set(source.url, { ...existing, title: source.title });
      continue;
    }
    const key = source.url ?? `title:${source.title.toLowerCase()}`;
    if (byUrl.has(key)) continue;
    byUrl.set(key, source);
  }
  return [...byUrl.values()].slice(0, 40);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url.slice(0, 80);
  }
}

// ---------------------------------------------------------------------------
// The detail payload the screen polls
// ---------------------------------------------------------------------------

export async function loadDetail(
  db: SupabaseClient,
  errandId: string,
  organizationId: string,
): Promise<ErrandDetail | null> {
  const row = await loadErrand(db, errandId, organizationId);
  if (!row) return null;
  const [legs, questions] = await Promise.all([
    loadLegs(db, errandId),
    loadQuestions(db, errandId),
  ]);

  let currentLeg: ErrandDetail['currentLeg'] = null;
  const runId = row.view.currentRunId;
  if (runId) {
    const outcome = await readRunOutcome(db, runId);
    if (outcome) {
      currentLeg = {
        runId,
        done: outcome.done,
        total: outcome.total,
        working: outcome.working,
      };
    }
  }

  return {
    errand: row.view,
    legs,
    questions,
    currentLeg,
    // Computed here, from the same rows the engine reads, and sent down. See
    // the note on ErrandDetail.situation in lib/errands-shape.ts.
    situation: describeState({
      state: row.view.state,
      kind: row.view.kind,
      legsUsed: row.view.legsUsed,
      legCeiling: row.view.legCeiling,
      checksDone: row.view.checksDone,
      nextCheckAt: row.view.nextCheckAt,
      openQuestion: questions.some((q) => q.state === 'open'),
      spend: {
        tokensSpent: row.view.tokensSpent,
        tokenCeiling: row.view.tokenCeiling,
        legsUsed: row.view.legsUsed,
        legCeiling: row.view.legCeiling,
      },
    }),
  };
}
