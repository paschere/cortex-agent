/**
 * The errand state machine, as two pure functions.
 *
 * ── WHY PURE, AND WHY RE-DERIVED ──────────────────────────────────────────
 *
 * An errand outlives everything: the browser tab, the request that started it,
 * the deploy, the worker. So it holds no state in memory between transitions,
 * and nothing is ever "passed" from one step of the engine to the next. Every
 * invocation reads the rows and asks `decideNext` what the rows imply. That is
 * the same discipline the orchestrator's executor states in its header — THE
 * DATABASE IS THE ONLY STATE THAT CROSSES A BOUNDARY — applied one level up,
 * and it is precisely what makes "survives a restart" true rather than hoped
 * for: a worker that dies mid-errand leaves rows, another worker reads the
 * rows, and the same decision comes out.
 *
 * Keeping the decision pure also means the interesting cases — stuck, out of
 * budget, waiting on a person — are unit-testable without a database, a model
 * or an Inngest harness.
 *
 * ── THE RULE THAT MATTERS MOST ────────────────────────────────────────────
 *
 * A LEG THAT PRODUCED NOTHING USABLE BECOMES A QUESTION, NEVER A QUIET
 * FAILURE. `foldAssessment` enforces that below, over the top of whatever the
 * model said. An assistant that gives up in silence is worse than one that
 * never started, because the person finds out an hour later; an assistant that
 * makes something up is worse than both. The third option — stop, say what
 * went wrong, and ask the one question that would unblock it — is the entire
 * difference between an errand and a lucky button.
 */

import {
  type Spend,
  type StopReason,
  canStartLeg,
  exhaustedNote,
  spentFraction,
} from '@cortex/agent-tools';
import type { ErrandKind, ErrandSource, ErrandState, LegStatus } from '@cortex/agent-tools';
import { isErrandTerminal } from '@cortex/agent-tools';

// ---------------------------------------------------------------------------
// What the engine is looking at
// ---------------------------------------------------------------------------

export interface LegSnapshot {
  seq: number;
  status: LegStatus;
  runId: string | null;
  /** ISO instant the leg row was written. Used to spot an aborted launch. */
  startedAt: string;
  /**
   * Whether the errand has already read this leg and decided what it meant.
   * Separate from `status` on purpose: "the run stopped" and "we know what
   * that means" are two facts, and the gap between them is exactly where a
   * worker dies. See the column comment in migration 0089.
   */
  assessed: boolean;
}

export interface ErrandSnapshot {
  state: ErrandState;
  kind: ErrandKind;
  /** Null until triage has accepted the request. */
  brief: string | null;
  spend: Spend;
  /** Ordered by seq. */
  legs: LegSnapshot[];
  /** Is a question waiting on a person right now? */
  openQuestion: boolean;
  checksDone: number;
  /** ISO instant a monitor is next due, or null. */
  nextCheckAt: string | null;
}

/**
 * How long a leg may exist without a run behind it before it is written off.
 * Two minutes: the two writes are normally milliseconds apart, and anything
 * that has not caught up in two minutes is not going to.
 */
export const ORPHAN_LEG_MS = 2 * 60_000;

export type Transition =
  /** Read the request and either accept it or ask before spending anything. */
  | { do: 'triage' }
  /** Commission an orchestrator run. */
  | { do: 'launch_leg'; seq: number }
  /** A leg is working. Nothing for the engine to do until it stops. */
  | { do: 'wait'; runId: string | null }
  /** A leg finished. Read what it produced and decide what that means. */
  | { do: 'assess_leg'; seq: number }
  /** The ceiling, hit at the only boundary where stopping is free. */
  | { do: 'stop'; reason: StopReason }
  /** Correctly idle: terminal, blocked on a person, or a monitor between looks. */
  | { do: 'nothing'; why: 'terminal' | 'blocked' | 'waiting_for_check' };

/**
 * What should happen to this errand next, given only its rows.
 *
 * Deliberately total and deliberately boring: every branch returns something,
 * and nothing here has a side effect. A caller that gets `nothing` back should
 * do nothing — not "probably nothing".
 */
export function decideNext(snapshot: ErrandSnapshot, now: number): Transition {
  if (isErrandTerminal(snapshot.state)) return { do: 'nothing', why: 'terminal' };

  // A person owes us an answer. Everything the errand already found is on the
  // row and stays there; this is a pause, not a stop.
  if (snapshot.state === 'blocked' && snapshot.openQuestion) {
    return { do: 'nothing', why: 'blocked' };
  }

  // A monitor between looks. Its next leg is scheduled, not pending.
  if (snapshot.state === 'watching') {
    const due = snapshot.nextCheckAt ? new Date(snapshot.nextCheckAt).getTime() : Number.NaN;
    if (!Number.isFinite(due) || due > now) return { do: 'nothing', why: 'waiting_for_check' };
    return startLeg(snapshot);
  }

  // The request has never been read. Triage is the cheapest question there is,
  // and the moment a person is most likely still at their desk to answer it.
  if (!snapshot.brief) return { do: 'triage' };

  const last = snapshot.legs.at(-1);

  // A leg is in flight. The orchestrator owns it; we watch its row.
  if (last && last.status === 'running') {
    if (last.runId) return { do: 'wait', runId: last.runId };
    // A leg with no run behind it is an ABORTED LAUNCH: the row was written
    // (and charged for, deliberately — see openLeg) and the worker died before
    // the run existed. Nothing is coming, so waiting for it is the one way an
    // errand could sit on "trabajando" for ever. After a short grace, it is
    // read as a leg that produced nothing — which becomes a question, not
    // silence. The grace exists because the normal gap between the two writes
    // is milliseconds.
    const age = now - new Date(last.startedAt).getTime();
    if (Number.isFinite(age) && age > ORPHAN_LEG_MS) return { do: 'assess_leg', seq: last.seq };
    return { do: 'wait', runId: null };
  }

  // A leg stopped and nobody has read it yet. This is the branch a crashed
  // worker resumes on: the run row says how it ended, `assessed` says nobody
  // has folded that in, and the verdict is derived again from scratch.
  if (last && !last.assessed) return { do: 'assess_leg', seq: last.seq };

  return startLeg(snapshot);
}

function startLeg(snapshot: ErrandSnapshot): Transition {
  const verdict = canStartLeg(snapshot.spend);
  if (!verdict.ok) return { do: 'stop', reason: verdict.reason };
  return { do: 'launch_leg', seq: snapshot.legs.length + 1 };
}

// ---------------------------------------------------------------------------
// Reading a finished leg
// ---------------------------------------------------------------------------

/**
 * What the assessing model is allowed to conclude.
 *
 * `unchanged` exists only for monitors and is the common case for them: most
 * looks find nothing, and a monitor that "delivers" every time it looks is a
 * notification generator, not a watchman.
 */
export type Assessment =
  | { verdict: 'deliver'; deliverable: string; note: string; sources: ErrandSource[] }
  | { verdict: 'ask'; question: string; why: string; options: string[] }
  | { verdict: 'continue'; nextObjective: string; findings: string }
  | { verdict: 'unchanged'; reading: string };

export interface FoldInput {
  kind: ErrandKind;
  /** Spend AFTER the leg that just finished has been added. */
  spend: Spend;
  /** How the leg's orchestrator run ended. */
  legStatus: LegStatus;
  /**
   * Did the leg produce anything a person could use? Computed from the run's
   * own rows (a summary with substance, or at least one completed task), never
   * from the model's opinion of its own output.
   */
  usableOutput: boolean;
  /** Monitor only: looks still allowed after this one. */
  checksLeft: number;
  assessment: Assessment;
}

export type Resolution =
  | {
      outcome: 'deliver';
      state: Extract<ErrandState, 'delivered'>;
      deliverable: string;
      sources: ErrandSource[];
      closingNote: string;
    }
  | { outcome: 'ask'; question: string; why: string; options: string[] }
  | { outcome: 'continue'; nextObjective: string; findings: string }
  /** Monitor: nothing moved, go back to sleep. */
  | { outcome: 'watch'; reading: string }
  | {
      outcome: 'exhausted';
      reason: StopReason;
      deliverable: string | null;
      sources: ErrandSource[];
      closingNote: string;
    };

/** The question asked when a leg came back with nothing and no better one exists. */
export const STUCK_QUESTION = '¿Por dónde quieres que siga?';

export const STUCK_WHY =
  'Esta vuelta no trajo nada utilizable: las fuentes que probé no respondieron o no decían nada ' +
  'del tema. Antes de gastar otra vuelta buscando en el mismo sitio, prefiero preguntarte que ' +
  'inventarme una respuesta o quedarme callado.';

/**
 * Turn the model's reading of a finished leg into what actually happens,
 * applying the rules the model does not get a vote on.
 *
 * The overrides, in the order they bite:
 *
 *   1. NOTHING USABLE → ASK. Whatever the model concluded, a leg that produced
 *      no material cannot deliver (there is nothing to deliver) and should not
 *      silently try again (the next attempt has the same information). It asks.
 *
 *   2. WANT ANOTHER LEG BUT NO BUDGET → DELIVER WHAT EXISTS. The ceiling is
 *      not a suggestion, and stopping with a partial answer plus an honest
 *      note beats stopping with nothing.
 *
 *   3. `unchanged` OUTSIDE A MONITOR is meaningless — treat it as material and
 *      deliver it, rather than dropping the leg's work on a category error.
 *
 *   4. A MONITOR THAT HAS RUN OUT OF LOOKS DELIVERS, saying it saw no change.
 *      "Sin cambios en 30 revisiones" is a real answer; going quiet is not.
 */
export function foldAssessment(input: FoldInput): Resolution {
  const { assessment, spend } = input;

  // ── 1. Stuck. This is the branch the whole feature turns on. ────────────
  if (!input.usableOutput) {
    if (assessment.verdict === 'ask') {
      return {
        outcome: 'ask',
        question: assessment.question,
        why: assessment.why,
        options: assessment.options,
      };
    }
    return {
      outcome: 'ask',
      question: STUCK_QUESTION,
      why: `${STUCK_WHY}${legEndingNote(input.legStatus)}`,
      options: [],
    };
  }

  if (assessment.verdict === 'ask') {
    return {
      outcome: 'ask',
      question: assessment.question,
      why: assessment.why,
      options: assessment.options,
    };
  }

  // ── 4. A monitor with nothing to report. ────────────────────────────────
  if (assessment.verdict === 'unchanged' && input.kind === 'monitor_change') {
    if (input.checksLeft > 0 && canStartLeg(spend).ok) {
      return { outcome: 'watch', reading: assessment.reading };
    }
    return {
      outcome: 'deliver',
      state: 'delivered',
      deliverable: assessment.reading,
      sources: [],
      closingNote:
        'Se acabaron las revisiones de este encargo y nunca vi un cambio. Arriba queda la última ' +
        'lectura, que es la misma que la primera. Si quieres seguir vigilando, vuelve a encargarlo.',
    };
  }

  // ── 3. `unchanged` where it does not apply. ─────────────────────────────
  if (assessment.verdict === 'unchanged') {
    return {
      outcome: 'deliver',
      state: 'delivered',
      deliverable: assessment.reading,
      sources: [],
      closingNote: 'Listo. Esto es lo que encontró el encargo.',
    };
  }

  // ── 2. Wants another leg. Only if it can pay for one. ───────────────────
  if (assessment.verdict === 'continue') {
    const verdict = canStartLeg(spend);
    if (verdict.ok) {
      return {
        outcome: 'continue',
        nextObjective: assessment.nextObjective,
        findings: assessment.findings,
      };
    }
    return {
      outcome: 'exhausted',
      reason: verdict.reason,
      deliverable: assessment.findings,
      sources: [],
      closingNote: exhaustedNote(spend, verdict.reason),
    };
  }

  return {
    outcome: 'deliver',
    state: 'delivered',
    deliverable: assessment.deliverable,
    sources: assessment.sources,
    closingNote: assessment.note || 'Listo. Esto es lo que encontró el encargo.',
  };
}

/** One clause explaining how the leg ended, appended to the stuck question. */
function legEndingNote(status: LegStatus): string {
  switch (status) {
    case 'interrupted':
      return ' (La vuelta anterior se cayó a mitad de camino, así que puede que ni alcanzara a mirar.)';
    case 'cancelled':
      return ' (Detuviste la vuelta anterior antes de que terminara.)';
    case 'failed':
      return ' (La vuelta anterior falló entera.)';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// What the screen says it is doing
// ---------------------------------------------------------------------------

/**
 * One sentence describing the errand's situation, in the person's language.
 *
 * Lives here rather than in a component because "what is this thing doing" is
 * a fact about the state machine, and a screen that answers it from its own
 * reading of the columns is a second state machine that will disagree with
 * this one. An errand that takes forty minutes and says nothing feels hung, so
 * every state has a sentence — including the boring ones.
 */
export function describeState(snapshot: {
  state: ErrandState;
  kind: ErrandKind;
  legsUsed: number;
  legCeiling: number;
  checksDone: number;
  nextCheckAt: string | null;
  openQuestion: boolean;
  spend: Spend;
}): string {
  switch (snapshot.state) {
    case 'queued':
      return 'En cola. Cortex está por leer el encargo y decidir si necesita preguntarte algo antes de arrancar.';
    case 'working': {
      const leg = Math.max(1, snapshot.legsUsed);
      const budget = Math.round(spentFraction(snapshot.spend) * 100);
      return (
        `Trabajando: vuelta ${leg} de ${snapshot.legCeiling}. ` +
        `Lleva ${budget}% del tope de consumo. Puedes cerrar esta pestaña — sigue solo.`
      );
    }
    case 'blocked':
      return 'Se atascó y prefiere preguntarte antes que inventar. Todo lo que ya encontró está guardado y sigue apenas contestes.';
    case 'watching': {
      const next = snapshot.nextCheckAt
        ? new Date(snapshot.nextCheckAt).toLocaleString('es-CO', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })
        : null;
      return next
        ? `Vigilando. Ya hizo ${snapshot.checksDone} ${snapshot.checksDone === 1 ? 'revisión' : 'revisiones'} y vuelve a mirar el ${next}.`
        : `Vigilando. Ya hizo ${snapshot.checksDone} ${snapshot.checksDone === 1 ? 'revisión' : 'revisiones'}.`;
    }
    case 'delivered':
      return 'Entregado. Abajo está el resultado con las fuentes de las que salió cada dato.';
    case 'exhausted':
      return 'Se cerró al llegar a su tope. Lo que alcanzó a reunir quedó guardado abajo.';
    case 'cancelled':
      return 'Lo detuviste. Lo que alcanzó a reunir antes de pararlo quedó guardado abajo.';
    case 'failed':
      return 'No pudo terminar. Abajo está hasta dónde llegó y qué lo frenó.';
  }
}
