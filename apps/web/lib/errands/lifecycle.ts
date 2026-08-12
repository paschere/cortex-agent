/**
 * Every write that moves an errand, and the guard that stops two workers doing
 * it at once.
 *
 * Same discipline as lib/orchestrator/lifecycle.ts, and for the same reason:
 * each of these is a CONDITIONAL UPDATE whose guard lives in the WHERE clause,
 * never a read followed by a write. Two workers can both read "this errand is
 * unclaimed"; only the database can decide which of them acted first. A
 * read-then-write passes every test built on a Map and still launches the same
 * leg twice in production — and launching a leg twice is not a duplicated row,
 * it is a duplicated bill.
 *
 * ── THE LEASE, AND WHY IT IS NOT AN OWNERSHIP CLAIM ───────────────────────
 *
 * `claimed_at` is a SHORT LEASE over one transition, not a claim on the
 * errand. The orchestrator claims a run for the run's whole life because a run
 * is one worker's job from start to finish. An errand lives for hours or days
 * and its worker lives for seconds — it wakes, moves the machine one step, and
 * leaves. Holding the errand for its lifetime would mean a worker that died
 * mid-step wedged it for ever, and the recovery for that would be another
 * sweep on top of this one.
 *
 * So the lease expires. `claimErrand` takes an unclaimed errand, or one whose
 * lease has gone stale, and both paths are conditional updates. The stale path
 * is the recovery: a worker that vanished holding the lease blocks the errand
 * for LEASE_MS and no longer.
 *
 * Typed against a narrow structural interface rather than SupabaseClient so
 * the compare-and-set behaviour can be tested against a stub that models it
 * faithfully, with no live database. Call sites pass a scoped client through
 * one documented cast.
 */

import type { ErrandSource, ErrandState } from './types';

// ---------------------------------------------------------------------------
// The slice of supabase-js this module uses
// ---------------------------------------------------------------------------

export interface ErrandResponse {
  data: unknown;
  error: { message: string } | null;
}

export interface ErrandBuilder extends PromiseLike<ErrandResponse> {
  select(columns?: string): ErrandBuilder;
  update(values: Record<string, unknown>): ErrandBuilder;
  insert(values: Record<string, unknown>): ErrandBuilder;
  eq(column: string, value: unknown): ErrandBuilder;
  in(column: string, values: unknown[]): ErrandBuilder;
  lt(column: string, value: unknown): ErrandBuilder;
  is(column: string, value: unknown): ErrandBuilder;
  maybeSingle(): PromiseLike<ErrandResponse>;
}

export interface ErrandDb {
  from(table: string): ErrandBuilder;
}

/**
 * How long one worker may hold an errand before another may take it.
 *
 * Five minutes: comfortably longer than any single transition (the slowest is
 * a triage or assessment model call plus a handful of writes) and short enough
 * that a worker killed mid-transition does not strand the errand for a
 * noticeable fraction of its life.
 */
export const LEASE_MS = 5 * 60_000;

/**
 * Silence after which the sweep stops believing an errand is working.
 *
 * Deliberately longer than the orchestrator's own STALE_AFTER_MS (15 min): an
 * errand's silence usually means its LEG is silent, and the orchestrator sweep
 * has to notice and close that run first. Closing the errand before its own
 * run has been settled would produce two contradictory endings for the same
 * work. Twenty-five minutes leaves the orchestrator its full window plus a
 * sweep cycle.
 */
export const ERRAND_STALE_MS = 25 * 60_000;

/** States in which some worker is expected to be doing something. */
const LIVE: readonly ErrandState[] = ['queued', 'working'];

function rowsOf(response: ErrandResponse): Record<string, unknown>[] {
  return (response.data ?? []) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Claim / release
// ---------------------------------------------------------------------------

export type ClaimResult =
  | { claimed: true }
  | { claimed: false; reason: 'not_found' | 'not_advanceable' | 'held' };

/**
 * Take the lease on one transition, or say why we could not.
 *
 * Two conditional updates rather than one with an `or(...)`: `claimed_at is
 * null` and `claimed_at < cutoff` are different facts about the world, PostgREST
 * expresses their disjunction as a string filter that no stub can honestly
 * model, and splitting them keeps both paths atomic. The unclaimed path is the
 * common one and is tried first.
 */
export async function claimErrand(
  db: ErrandDb,
  errandId: string,
  options: { now?: number; states?: readonly ErrandState[] } = {},
): Promise<ClaimResult> {
  const now = options.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  // `blocked` is claimable on purpose. An errand normally refuses to move
  // while a question is open — `decideNext` returns `nothing` — but an errand
  // marked blocked whose question was withdrawn or lost to the one-open-question
  // index would otherwise be unclaimable and therefore unrecoverable. Letting a
  // worker look at it is what turns that into a resumption instead of a wedge.
  const states = options.states ?? [...LIVE, 'watching', 'blocked'];

  const fresh = await db
    .from('errands')
    .update({ claimed_at: nowIso, last_heartbeat_at: nowIso })
    .eq('id', errandId)
    .in('state', states as unknown as unknown[])
    .is('claimed_at', null)
    .select('id');
  if (fresh.error) throw new Error(`Could not claim errand ${errandId}: ${fresh.error.message}`);
  if (rowsOf(fresh).length > 0) return { claimed: true };

  // Nobody released the lease. If it has gone stale the previous worker is
  // gone and taking it is the recovery, not a race.
  const stale = await db
    .from('errands')
    .update({ claimed_at: nowIso, last_heartbeat_at: nowIso })
    .eq('id', errandId)
    .in('state', states as unknown as unknown[])
    .lt('claimed_at', new Date(now - LEASE_MS).toISOString())
    .select('id');
  if (stale.error) throw new Error(`Could not claim errand ${errandId}: ${stale.error.message}`);
  if (rowsOf(stale).length > 0) return { claimed: true };

  // Read back only to say why. This never authorises anything.
  const read = await db
    .from('errands')
    .select('id, state, claimed_at')
    .eq('id', errandId)
    .maybeSingle();
  const row = (read.data ?? null) as Record<string, unknown> | null;
  if (!row) return { claimed: false, reason: 'not_found' };
  if (row.claimed_at != null) return { claimed: false, reason: 'held' };
  return { claimed: false, reason: 'not_advanceable' };
}

/**
 * Give the lease back. Always called, including on the failure path — a worker
 * that throws while holding a lease costs the errand LEASE_MS of nothing.
 */
export async function releaseErrand(db: ErrandDb, errandId: string): Promise<void> {
  try {
    await db
      .from('errands')
      .update({ claimed_at: null, last_heartbeat_at: new Date().toISOString() })
      .eq('id', errandId)
      .select('id');
  } catch {
    // Best effort. The lease expires on its own; failing to release is a
    // five-minute delay, and throwing here would mask the real error.
  }
}

/** "Still alive." Cheap, unconditional on the lease, never throws. */
export async function heartbeatErrand(db: ErrandDb, errandId: string): Promise<void> {
  try {
    await db
      .from('errands')
      .update({ last_heartbeat_at: new Date().toISOString() })
      .eq('id', errandId)
      .in('state', LIVE as unknown as unknown[])
      .select('id');
  } catch {
    // Telemetry must never kill the work it describes.
  }
}

// ---------------------------------------------------------------------------
// Asking, and being answered
// ---------------------------------------------------------------------------

export interface AskInput {
  errandId: string;
  organizationId: string;
  leg: number;
  question: string;
  why: string;
  options: string[];
  /** Written to the errand before it blocks, so the pause loses nothing. */
  findings?: string | null;
}

/**
 * Stop and ask.
 *
 * ORDER MATTERS AND IS NOT NEGOTIABLE: the findings are written FIRST, then
 * the question row, then the state. A crash between any two of those leaves
 * the errand with more knowledge than it had and at worst no question — which
 * the sweep turns into a stalled errand a person can see. The other order
 * would leave a question hanging over work that was never saved, and answering
 * it would resume from nothing.
 *
 * The question insert can legitimately fail: `errand_questions_one_open_idx`
 * allows exactly one open question per errand, so a second worker asking at
 * the same moment loses. That is the desired outcome — a person returning to a
 * blocked errand should find ONE thing to answer, not a form — so the conflict
 * is swallowed and the errand still blocks.
 */
export async function askAndBlock(db: ErrandDb, input: AskInput): Promise<boolean> {
  if (input.findings != null) {
    await db
      .from('errands')
      .update({ findings: input.findings })
      .eq('id', input.errandId)
      .select('id');
  }

  const inserted = await db.from('errand_questions').insert({
    organization_id: input.organizationId,
    errand_id: input.errandId,
    leg: input.leg,
    question: input.question.slice(0, 600),
    why: input.why.slice(0, 600),
    options: input.options.slice(0, 5).map((o) => o.slice(0, 200)),
  });

  const conflicted = Boolean(inserted.error);

  await db
    .from('errands')
    .update({
      state: 'blocked' satisfies ErrandState,
      current_run_id: null,
      claimed_at: null,
      last_heartbeat_at: new Date().toISOString(),
    })
    .eq('id', input.errandId)
    .in('state', ['queued', 'working'] as unknown as unknown[])
    .select('id');

  return !conflicted;
}

export type AnswerResult = 'resumed' | 'not_open' | 'not_found';

/**
 * A person answered. The errand goes back to work with the answer folded into
 * what it knows.
 *
 * The guard is on the QUESTION, not on the errand: `state = 'open'` in the
 * WHERE clause is what makes two people clicking answer at the same moment
 * produce one resumption. The errand's own state is moved afterwards and is
 * idempotent — an errand already back at `working` stays there.
 */
export async function answerQuestion(
  db: ErrandDb,
  input: { errandId: string; questionId: string; answer: string; userId: string | null },
): Promise<AnswerResult> {
  const nowIso = new Date().toISOString();

  const claimed = await db
    .from('errand_questions')
    .update({
      state: 'answered',
      answer: input.answer.slice(0, 2000),
      answered_at: nowIso,
      answered_by: input.userId,
    })
    .eq('id', input.questionId)
    .eq('errand_id', input.errandId)
    .eq('state', 'open')
    .select('id');

  if (claimed.error) throw new Error(`Could not answer: ${claimed.error.message}`);
  if (rowsOf(claimed).length === 0) return 'not_open';

  const resumed = await db
    .from('errands')
    .update({
      state: 'working' satisfies ErrandState,
      last_heartbeat_at: nowIso,
      // A fresh lease slot: whoever answered did not take one.
      claimed_at: null,
    })
    .eq('id', input.errandId)
    .in('state', ['blocked'] as unknown as unknown[])
    .select('id');

  return rowsOf(resumed).length > 0 ? 'resumed' : 'not_found';
}

/** Close the open question without answering it — used when an errand is stopped. */
export async function withdrawOpenQuestions(db: ErrandDb, errandId: string): Promise<void> {
  await db
    .from('errand_questions')
    .update({ state: 'withdrawn' })
    .eq('errand_id', errandId)
    .eq('state', 'open')
    .select('id');
}

// ---------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------

/**
 * Record a leg and charge the errand for it BEFORE the run is commissioned.
 *
 * State is advanced ahead of the work it describes, the same invariant the
 * orchestrator states: a worker that dies between this write and the run
 * starting leaves an errand that has been charged for a leg that produced
 * nothing. That is the honest failure — the alternative is an errand that
 * commissions runs it never counted, which is the shape of a runaway bill.
 */
export async function openLeg(
  db: ErrandDb,
  input: {
    errandId: string;
    organizationId: string;
    seq: number;
    objective: string;
    legsUsed: number;
  },
): Promise<string | null> {
  const inserted = await db
    .from('errand_legs')
    .insert({
      organization_id: input.organizationId,
      errand_id: input.errandId,
      seq: input.seq,
      objective: input.objective,
    })
    .select('id');
  if (inserted.error) return null;
  const legId = (rowsOf(inserted)[0]?.id as string | undefined) ?? null;
  if (!legId) return null;

  await db
    .from('errands')
    .update({
      state: 'working' satisfies ErrandState,
      legs_used: input.legsUsed + 1,
      last_heartbeat_at: new Date().toISOString(),
    })
    .eq('id', input.errandId)
    .select('id');

  return legId;
}

/** Point the leg (and the errand) at the run that will do the work. */
export async function attachRun(
  db: ErrandDb,
  input: { errandId: string; legId: string; runId: string },
): Promise<void> {
  await db.from('errand_legs').update({ run_id: input.runId }).eq('id', input.legId).select('id');
  await db
    .from('errands')
    .update({ current_run_id: input.runId, last_heartbeat_at: new Date().toISOString() })
    .eq('id', input.errandId)
    .select('id');
}

/** Copy the finished run's outcome onto the leg and add its tokens to the bill. */
export async function closeLeg(
  db: ErrandDb,
  input: {
    errandId: string;
    legId: string;
    status: 'completed' | 'failed' | 'interrupted' | 'cancelled';
    summary: string | null;
    tokens: number;
    tokensSpent: number;
  },
): Promise<void> {
  await db
    .from('errand_legs')
    .update({
      status: input.status,
      summary: input.summary,
      tokens: Math.max(0, input.tokens),
      finished_at: new Date().toISOString(),
    })
    .eq('id', input.legId)
    .select('id');

  await db
    .from('errands')
    .update({
      tokens_spent: input.tokensSpent + Math.max(0, input.tokens),
      current_run_id: null,
      last_heartbeat_at: new Date().toISOString(),
    })
    .eq('id', input.errandId)
    .select('id');
}

/** "We have read this leg and know what it meant." See the column comment in 0089. */
export async function markLegAssessed(db: ErrandDb, legId: string): Promise<void> {
  await db
    .from('errand_legs')
    .update({ assessed_at: new Date().toISOString() })
    .eq('id', legId)
    .select('id');
}

// ---------------------------------------------------------------------------
// Endings
// ---------------------------------------------------------------------------

export interface CloseInput {
  errandId: string;
  state: Extract<ErrandState, 'delivered' | 'failed' | 'cancelled' | 'exhausted'>;
  deliverable?: string | null;
  sources?: ErrandSource[];
  closingNote: string;
  findings?: string | null;
}

/**
 * The terminal write. Idempotent against somebody having ended the errand
 * already: the WHERE clause refuses anything that has stopped, so a cancel
 * that landed first wins and a second ending cannot overwrite the first.
 *
 * `closing_note` is never optional, and the CHECK constraint in 0089 enforces
 * that at the storage layer too. An errand that ends without saying why is the
 * silence this feature exists to remove.
 */
export async function closeErrand(db: ErrandDb, input: CloseInput): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    state: input.state,
    closing_note: input.closingNote,
    finished_at: nowIso,
    last_heartbeat_at: nowIso,
    claimed_at: null,
    current_run_id: null,
  };
  if (input.deliverable !== undefined) patch.deliverable = input.deliverable;
  if (input.sources !== undefined) patch.sources = input.sources;
  if (input.findings != null) patch.findings = input.findings;

  const closed = await db
    .from('errands')
    .update(patch)
    .eq('id', input.errandId)
    .in('state', ['queued', 'working', 'blocked', 'watching'] as unknown as unknown[])
    .select('id');

  if (closed.error) throw new Error(`Could not close errand: ${closed.error.message}`);
  return rowsOf(closed).length > 0;
}

/** A monitor goes back to sleep until its next look. */
export async function parkForNextCheck(
  db: ErrandDb,
  input: {
    errandId: string;
    reading: string;
    checksDone: number;
    intervalMinutes: number;
    now?: number;
  },
): Promise<void> {
  const now = input.now ?? Date.now();
  await db
    .from('errands')
    .update({
      state: 'watching' satisfies ErrandState,
      // The reading becomes the baseline the NEXT look is compared against.
      baseline: input.reading,
      findings: input.reading,
      checks_done: input.checksDone + 1,
      next_check_at: new Date(now + input.intervalMinutes * 60_000).toISOString(),
      current_run_id: null,
      claimed_at: null,
      last_heartbeat_at: new Date(now).toISOString(),
    })
    .eq('id', input.errandId)
    .in('state', ['working'] as unknown as unknown[])
    .select('id');
}

/** Triage accepted the request: record the brief and let the legs begin. */
export async function acceptBrief(
  db: ErrandDb,
  input: { errandId: string; brief: string },
): Promise<void> {
  await db
    .from('errands')
    .update({
      brief: input.brief,
      state: 'working' satisfies ErrandState,
      started_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
    })
    .eq('id', input.errandId)
    .in('state', ['queued', 'working'] as unknown as unknown[])
    .select('id');
}
