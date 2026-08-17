import 'server-only';
import { enqueueJob } from '@/lib/jobs';
import { noteErrandAsked, noteErrandFinished } from '@/lib/notifications/producers';
import { EVENT_RUN_STARTED } from '@/lib/orchestrator/contract';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { assertProposalOnly, errandToolAllowlist } from '@cortex/agent-tools';
import { canStartLeg, exhaustedNote } from '@cortex/agent-tools';
import { MAX_MONITOR_CHECKS } from '@cortex/agent-tools';
import { ERRAND_KIND_SPECS, toolsFor } from '@cortex/agent-tools';
// Trámites web: the browser side of an errand — which flows may run unattended,
// and the pause a captcha or an OTP leaves behind. See migration 0111.
import {
  type Checkpoint,
  checkpointSecondsLeft,
  closeCheckpoint,
  createHttpTransport,
  isCheckpointLive,
  linkCheckpointQuestion,
  listErrandFlows,
  openCheckpointForErrand,
  resumeFlow,
} from '@cortex/agent-tools';
import {
  type ErrandDb,
  acceptBrief,
  askAndBlock,
  attachRun,
  claimErrand,
  closeErrand,
  closeLeg,
  markLegAssessed,
  openLeg,
  parkForNextCheck,
  releaseErrand,
} from '@cortex/agent-tools';
import type { ErrandSource, LegStatus } from '@cortex/agent-tools';
import { loadAgent } from '@cortex/agents';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type Transition, decideNext, foldAssessment } from './engine';
import { askInConversation, deliverInConversation } from './notify';
import { assessLeg, triageRequest } from './planner';
import {
  harvestSources,
  loadQuestions,
  loadSnapshot,
  mergeSources,
  readRunOutcome,
} from './repository';

/**
 * ONE TRANSITION OF THE ERRAND MACHINE.
 *
 * Called by inngest/functions/errand-run.ts, which supplies nothing but an
 * errand id. Everything this function knows it reads; everything it decides it
 * derives (lib/errands/engine.ts). That is what lets the same call resume an
 * errand whose previous worker was killed by a redeploy mid-leg: the rows say
 * where it got to, and the decision comes out the same.
 *
 * It performs AT MOST ONE transition and then returns, saying whether another
 * is immediately available. The caller sends itself another `errand/advance`
 * rather than looping in place, so every step of a job that may last days is
 * an independent, durable invocation with its own budget — the same argument
 * the orchestrator makes for one step per wave, one level up.
 *
 * ── THE BOUNDARY IS APPLIED HERE, BEFORE ANYTHING IS COMMISSIONED ─────────
 *
 * `assertProposalOnly` runs before the orchestration row is even written. An
 * errand cannot commission a run that could send, buy or book — not because
 * the prompt asks it not to, but because the toolset handed to that run does
 * not contain anything that can. See packages/agent-tools/src/errands/boundary.ts.
 */

/** How much of a leg's report is carried forward as `findings`. */
const FINDINGS_STORE_LIMIT = 16_000;

export interface AdvanceResult {
  /** What was done, for the Inngest timeline. */
  did: Transition['do'] | 'claim_failed';
  /** True when the machine can move again straight away. */
  again: boolean;
  detail?: string;
}

const errandDb = (db: SupabaseClient): ErrandDb => db as unknown as ErrandDb;

/**
 * Block on a question AND tell the person, in one call.
 *
 * A wrapper rather than two calls at each of the two ask sites, because the
 * failure mode of forgetting the second one is invisible: the errand is
 * correctly stopped, the question is correctly stored, and nobody ever finds
 * out. Bundling them makes "ask" mean "ask somebody" everywhere.
 *
 * The store write happens first and its result is not conditional on the
 * notification — the question must survive a chat that cannot be posted to.
 *
 * DOS CANALES, Y AQUÍ SÍ SE DUPLICA A PROPÓSITO. El mensaje en la conversación
 * es el bueno cuando la persona está ahí; el aviso de la campana es el que
 * sobrevive al scroll de la siguiente conversación y al día siguiente. Un
 * encargo bloqueado cuesta lo mismo que uno trabajando y no entrega nada
 * mientras espera, así que ésta es la clase de noticia en la que fallar por
 * exceso es claramente lo barato. Ver lib/notifications/producers.ts.
 */
async function askAndTell(
  db: SupabaseClient,
  edb: ErrandDb,
  input: {
    errandId: string;
    organizationId: string;
    /** El dueño del encargo. Null si la cuenta que lo pidió ya no está. */
    userId: string | null;
    conversationId: string | null;
    request: string;
    leg: number;
    question: string;
    why: string;
    options: string[];
    findings?: string | null;
  },
): Promise<void> {
  const asked = await askAndBlock(edb, {
    errandId: input.errandId,
    organizationId: input.organizationId,
    leg: input.leg,
    question: input.question,
    why: input.why,
    options: input.options,
    findings: input.findings,
  });
  // Only the worker that actually WROTE the question announces it. A second
  // worker that lost the one-open-question index would otherwise post a
  // duplicate into the thread for a question that is not the open one.
  if (!asked) return;
  const inChat = await askInConversation(db, {
    conversationId: input.conversationId,
    errandId: input.errandId,
    request: input.request,
    question: input.question,
    why: input.why,
    options: input.options,
  });
  await noteErrandAsked(db, {
    userId: input.userId,
    errandId: input.errandId,
    request: input.request,
    question: input.question,
    deliveredInChat: inChat,
  });
}

/** Close the errand AND report back, same argument as `askAndTell`. */
async function closeAndTell(
  db: SupabaseClient,
  edb: ErrandDb,
  input: Parameters<typeof closeErrand>[1] & {
    conversationId: string | null;
    request: string;
    userId: string | null;
  },
): Promise<void> {
  const closed = await closeErrand(edb, input);
  // Somebody else already ended it — a person cancelling owns that ending and
  // has just been told about it by the screen they clicked on.
  if (!closed) return;
  const inChat = await deliverInConversation(db, {
    conversationId: input.conversationId,
    errandId: input.errandId,
    request: input.request,
    state: input.state,
    deliverable: input.deliverable ?? null,
    closingNote: input.closingNote,
    sourceCount: input.sources?.length ?? 0,
  });
  // Un final bueno que ya llegó al chat no se repite; uno malo sí, porque es el
  // que tiene un plazo detrás. `cancelled` no avisa nunca — lo hizo una persona
  // en una pantalla hace un segundo.
  await noteErrandFinished(db, {
    userId: input.userId,
    errandId: input.errandId,
    request: input.request,
    state: input.state,
    deliveredInChat: inChat,
  });
}

export async function advanceErrand(input: {
  errandId: string;
  organizationId: string;
}): Promise<AdvanceResult> {
  const db = getOrgScopedClient(input.organizationId);
  const edb = errandDb(db);

  const claim = await claimErrand(edb, input.errandId);
  if (!claim.claimed) return { did: 'claim_failed', again: false, detail: claim.reason };

  try {
    const loaded = await loadSnapshot(db, input.errandId, input.organizationId);
    if (!loaded) return { did: 'nothing', again: false, detail: 'not_found' };

    // -----------------------------------------------------------------------
    // A TRÁMITE OF THIS ERRAND IS PARKED, WAITING FOR A PERSON.
    //
    // Checked BEFORE `decideNext`, and that ordering is the whole point: the
    // tab behind a checkpoint lives minutes, so getting the question out — or
    // the answer in — beats everything else the machine might have wanted to
    // do, including reading a leg that has already finished. The assessment is
    // still there afterwards; the browser session would not be.
    // -----------------------------------------------------------------------
    const parked = await openCheckpointForErrand(db, input.errandId).catch(() => null);
    if (parked) {
      const settled = await handleParkedTramite(db, edb, loaded, input.organizationId, parked);
      if (settled) return settled;
    }

    const transition = decideNext(loaded.snapshot, Date.now());

    switch (transition.do) {
      case 'triage':
        return await runTriage(db, edb, loaded, input.organizationId);
      case 'launch_leg':
        return await launchLeg(db, edb, loaded, input.organizationId, transition.seq);
      case 'assess_leg':
        return await assess(db, edb, loaded, input.organizationId, transition.seq);
      case 'stop': {
        const spend = loaded.snapshot.spend;
        await closeAndTell(db, edb, {
          errandId: input.errandId,
          state: 'exhausted',
          closingNote: exhaustedNote(spend, transition.reason),
          deliverable: loaded.row.view.deliverable ?? loaded.row.view.findings,
          conversationId: loaded.row.view.conversationId,
          request: loaded.row.view.request,
          userId: loaded.row.userId,
        });
        return { did: 'stop', again: false, detail: transition.reason };
      }
      case 'wait':
        return { did: 'wait', again: false, detail: transition.runId ?? 'no run' };
      case 'nothing':
        return { did: 'nothing', again: false, detail: transition.why };
    }
  } finally {
    // Always. A worker that throws while holding the lease would otherwise
    // cost the errand five minutes of nothing.
    await releaseErrand(edb, input.errandId);
  }
}

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

type Loaded = NonNullable<Awaited<ReturnType<typeof loadSnapshot>>>;

async function runTriage(
  db: SupabaseClient,
  edb: ErrandDb,
  loaded: Loaded,
  organizationId: string,
): Promise<AdvanceResult> {
  const view = loaded.row.view;
  const outcome = await triageRequest({
    kind: view.kind,
    request: view.request,
    model: await modelFor(db),
  });

  await chargeTokens(edb, view.id, view.tokensSpent, outcome.tokens);

  if (!outcome.ready) {
    await askAndTell(db, edb, {
      errandId: view.id,
      organizationId,
      userId: loaded.row.userId,
      conversationId: view.conversationId,
      request: view.request,
      leg: 0,
      question: outcome.question,
      why: outcome.why,
      options: outcome.options,
    });
    return { did: 'triage', again: false, detail: 'asked before spending anything' };
  }

  await acceptBrief(edb, { errandId: view.id, brief: outcome.brief });
  return { did: 'triage', again: true, detail: 'accepted' };
}

// ---------------------------------------------------------------------------
// Commissioning a leg
// ---------------------------------------------------------------------------

async function launchLeg(
  db: SupabaseClient,
  edb: ErrandDb,
  loaded: Loaded,
  organizationId: string,
  seq: number,
): Promise<AdvanceResult> {
  const view = loaded.row.view;
  const userId = loaded.row.userId;
  if (!userId) {
    // The person whose grants the legs inherit is gone. Refusing is correct:
    // running with somebody else's permissions is how a deleted account's
    // access outlives the account.
    await closeAndTell(db, edb, {
      errandId: view.id,
      state: 'failed',
      conversationId: view.conversationId,
      request: view.request,
      // Null por definición en esta rama: no hay a quién avisar, que es
      // justamente el problema del que habla el cierre.
      userId: null,
      closingNote:
        'Este encargo quedó sin dueño —la cuenta que lo pidió ya no está en el espacio de ' +
        'trabajo—, y un encargo corre con los permisos de quien lo pidió. Vuelve a encargarlo ' +
        'desde tu cuenta.',
    });
    return { did: 'stop', again: false, detail: 'owner gone' };
  }

  const answered = (await loadQuestions(db, view.id))
    .filter((q) => q.state === 'answered' && q.answer)
    .map((q) => ({ question: q.question, answer: q.answer as string }));

  const objective = composeObjective({
    kind: view.kind,
    brief: view.brief ?? view.request,
    request: view.request,
    findings: view.findings,
    answered,
    isRecheck: view.kind === 'monitor_change' && view.checksDone > 0,
    baseline: loaded.row.baseline,
  });

  const legId = await openLeg(edb, {
    errandId: view.id,
    organizationId,
    seq,
    objective,
    legsUsed: view.legsUsed,
  });
  if (!legId) return { did: 'launch_leg', again: false, detail: 'could not open the leg' };

  // THE LINE. Applied before the run row exists, so an errand can never
  // commission work with a tool that acts outward. See boundary.ts.
  //
  // The admission is read HERE, per leg, rather than cached anywhere: an
  // administrator revoking a trámite's unattended permission must take effect
  // on the next leg of an errand already running, not on the next errand. A
  // workspace with nothing admitted gets `[]`, which admits no tools at all,
  // which is byte-for-byte the behaviour before trámites existed.
  const admission = { admittedFlows: await admittedTramites(db) };
  const toolAllowlist = toolsFor(view.kind, admission);
  assertProposalOnly(toolAllowlist, admission);

  const { data, error } = await db
    .from('orchestration_runs')
    .insert({
      user_id: userId,
      objective,
      status: 'planning',
      // The sweep's clock starts now, not when the executor picks it up: a run
      // that never reaches Inngest has to be closable too.
      last_heartbeat_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error || !data) {
    await closeLeg(edb, {
      errandId: view.id,
      legId,
      status: 'failed',
      summary: null,
      tokens: 0,
      tokensSpent: view.tokensSpent,
    });
    return { did: 'launch_leg', again: true, detail: `could not write the run: ${error?.message}` };
  }

  const runId = data.id as string;
  await attachRun(edb, { errandId: view.id, legId, runId });

  // `enqueueJob` nunca lanza; false = ninguna cola aceptó el trabajo.
  const queued = await enqueueJob(EVENT_RUN_STARTED, {
    runId,
    organizationId,
    userId,
    objective,
    concurrency: 3,
    toolAllowlist,
  });
  if (!queued) {
    // The run row exists and nothing will pick it up. Close the leg here
    // rather than leave the errand watching a run that will never move; the
    // sweep would get there eventually, but this failure is visible now.
    logger.error('errands: could not queue a leg', { errandId: view.id, runId });
    await db
      .from('orchestration_runs')
      .update({
        status: 'failed',
        summary: '**No se pudo encolar esta vuelta del encargo.**',
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId);
    await closeLeg(edb, {
      errandId: view.id,
      legId,
      status: 'failed',
      summary: null,
      tokens: 0,
      tokensSpent: view.tokensSpent,
    });
    return { did: 'launch_leg', again: true, detail: 'could not enqueue the run' };
  }

  return { did: 'launch_leg', again: false, detail: runId };
}

/**
 * The objective handed to the orchestrator.
 *
 * This is NOT the person's request. It is the request, plus what earlier legs
 * established, plus every answered clarification, plus the shape the
 * deliverable has to take — assembled fresh each leg from the rows, which is
 * why answering a question resumes instead of restarting.
 *
 * The last paragraph restates the boundary in the objective itself. The
 * toolset already makes sending impossible, but a planner that does not know
 * that will happily spend one of eight sub-agents on "notify the suppliers",
 * and that sub-agent will burn its tokens discovering it has no tools. Saying
 * it up front is cheaper than letting it find out.
 */
export function composeObjective(input: {
  kind: Parameters<typeof toolsFor>[0];
  brief: string;
  request: string;
  findings: string | null;
  answered: Array<{ question: string; answer: string }>;
  isRecheck: boolean;
  baseline: string | null;
}): string {
  const spec = ERRAND_KIND_SPECS[input.kind];
  const parts: string[] = [spec.objectiveFraming, `SUBJECT\n${input.brief}`];

  if (input.request.trim() !== input.brief.trim()) {
    parts.push(`WHAT THE PERSON ORIGINALLY WROTE\n${input.request}`);
  }

  if (input.answered.length > 0) {
    parts.push(
      `WHAT THEY HAVE ALREADY CLARIFIED — treat these as settled\n${input.answered
        .map((a) => `- ${a.question}\n  → ${a.answer}`)
        .join('\n')}`,
    );
  }

  if (input.isRecheck && input.baseline) {
    parts.push(
      'THIS IS A RE-CHECK. A previous reading is below. Find the CURRENT values for exactly the ' +
        'same things, from the same sources where they still exist. Do not broaden the subject and ' +
        'do not add new items — a monitor that changes what it measures cannot detect a change.\n\n' +
        `PREVIOUS READING\n${input.baseline.slice(0, 6_000)}`,
    );
  } else if (input.findings) {
    parts.push(
      'WHAT EARLIER LEGS ALREADY ESTABLISHED — do not spend this leg re-finding it. Build on it, ' +
        `and close the gaps it names.\n\n${input.findings.slice(0, 6_000)}`,
    );
  }

  parts.push(
    'HARD LIMIT ON THIS RUN. You may only READ. You have no tool that can send a message, create ' +
      'a record, book, buy, sign or file anything, and no such tool will be granted. If the right ' +
      'next action is to contact somebody or commit to something, WRITE THAT DOWN AS A ' +
      'RECOMMENDATION and stop — a person decides that, not you. Do not plan a task around ' +
      'notifying, emailing, scheduling or purchasing: it will have nothing to do.',
  );

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Reading a finished leg
// ---------------------------------------------------------------------------

async function assess(
  db: SupabaseClient,
  edb: ErrandDb,
  loaded: Loaded,
  organizationId: string,
  seq: number,
): Promise<AdvanceResult> {
  const view = loaded.row.view;
  const leg = loaded.legs.find((l) => l.seq === seq);
  if (!leg) return { did: 'assess_leg', again: false, detail: 'leg vanished' };

  const outcome = leg.runId ? await readRunOutcome(db, leg.runId) : null;

  // Fold the run's own numbers in first: the errand is charged for what the
  // run cost whatever the assessment then concludes, and the leg's status is
  // a fact about the run rather than an opinion about its output.
  const legStatus = runStatusToLegStatus(outcome?.status ?? 'failed');
  await closeLeg(edb, {
    errandId: view.id,
    legId: leg.id,
    status: legStatus,
    summary: outcome?.summary ?? null,
    tokens: outcome?.totalTokens ?? 0,
    tokensSpent: view.tokensSpent,
  });

  const spentAfter = view.tokensSpent + (outcome?.totalTokens ?? 0);
  const spend = {
    tokensSpent: spentAfter,
    tokenCeiling: view.tokenCeiling,
    legsUsed: view.legsUsed,
    legCeiling: view.legCeiling,
  };

  const answered = (await loadQuestions(db, view.id))
    .filter((q) => q.state === 'answered' && q.answer)
    .map((q) => ({ question: q.question, answer: q.answer as string }));

  const { assessment, tokens } = await assessLeg({
    kind: view.kind,
    request: view.request,
    brief: view.brief ?? view.request,
    priorFindings: view.findings,
    baseline: view.kind === 'monitor_change' ? loaded.row.baseline : null,
    answered,
    legSummary: outcome?.summary ?? null,
    taskDigest: outcome?.taskDigest ?? '(the leg produced no sub-agents at all)',
    legsLeft: canStartLeg(spend).ok ? spend.legCeiling - spend.legsUsed : 0,
    model: await modelFor(db),
  });

  await chargeTokens(edb, view.id, spentAfter, tokens);
  const finalSpend = { ...spend, tokensSpent: spentAfter + tokens };

  const checksLeft = Math.max(0, MAX_MONITOR_CHECKS - view.checksDone - 1);
  const resolution = foldAssessment({
    kind: view.kind,
    spend: finalSpend,
    legStatus,
    usableOutput: outcome?.usableOutput ?? false,
    checksLeft,
    assessment,
  });

  // Marked read BEFORE the resolution is applied. A crash in between leaves an
  // errand that has read its leg and not yet acted, which `decideNext` handles
  // by launching the next leg — wasteful but safe. The other order would
  // re-assess a leg that has already been folded in, which double-charges and
  // can double-ask.
  await markLegAssessed(edb, leg.id);

  switch (resolution.outcome) {
    case 'ask':
      await askAndTell(db, edb, {
        errandId: view.id,
        organizationId,
        userId: loaded.row.userId,
        conversationId: view.conversationId,
        request: view.request,
        leg: seq,
        question: resolution.question,
        why: resolution.why,
        options: resolution.options,
        findings: carryForward(view.findings, outcome?.summary ?? null),
      });
      return { did: 'assess_leg', again: false, detail: 'asked' };

    case 'continue':
      await db
        .from('errands')
        .update({ findings: resolution.findings.slice(0, FINDINGS_STORE_LIMIT) })
        .eq('id', view.id);
      return { did: 'assess_leg', again: true, detail: 'another leg' };

    case 'watch':
      await parkForNextCheck(edb, {
        errandId: view.id,
        reading: resolution.reading.slice(0, FINDINGS_STORE_LIMIT),
        checksDone: view.checksDone,
        intervalMinutes: view.checkIntervalMinutes ?? 24 * 60,
      });
      return { did: 'assess_leg', again: false, detail: 'no change; watching' };

    case 'exhausted':
      await closeAndTell(db, edb, {
        errandId: view.id,
        state: 'exhausted',
        deliverable: resolution.deliverable,
        sources: await sourcesFor(db, leg.runId, resolution.sources),
        closingNote: resolution.closingNote,
        conversationId: view.conversationId,
        request: view.request,
        userId: loaded.row.userId,
      });
      return { did: 'assess_leg', again: false, detail: 'ceiling' };

    case 'deliver': {
      const monitorChanged = view.kind === 'monitor_change';
      await closeAndTell(db, edb, {
        errandId: view.id,
        state: 'delivered',
        conversationId: view.conversationId,
        request: view.request,
        userId: loaded.row.userId,
        deliverable: resolution.deliverable,
        sources: await sourcesFor(db, leg.runId, resolution.sources),
        closingNote: monitorChanged
          ? `${resolution.closingNote} (Cambió respecto a la lectura anterior, así que el encargo se cierra aquí. Si quieres seguir vigilando, vuelve a encargarlo.)`
          : resolution.closingNote,
        findings: carryForward(view.findings, outcome?.summary ?? null),
      });
      return { did: 'assess_leg', again: false, detail: 'delivered' };
    }
  }
}

/** Provenance from what was actually fetched, topped up with what was claimed. */
async function sourcesFor(
  db: SupabaseClient,
  runId: string | null,
  claimed: ErrandSource[],
): Promise<ErrandSource[]> {
  if (!runId) return claimed;
  try {
    return mergeSources(await harvestSources(db, runId), claimed);
  } catch {
    return claimed;
  }
}

/**
 * Everything the errand knows, kept when it pauses to ask.
 *
 * This one function is why a clarification does not throw away an hour of
 * work: the leg's report is appended to what earlier legs established BEFORE
 * the errand blocks, so the answer resumes from a full picture.
 */
function carryForward(existing: string | null, legSummary: string | null): string | null {
  const parts = [existing?.trim(), legSummary?.trim()].filter(Boolean) as string[];
  if (parts.length === 0) return null;
  return parts.join('\n\n---\n\n').slice(0, FINDINGS_STORE_LIMIT);
}

/**
 * A run's ending, as the leg records it. `running` is deliberately not
 * reachable: this is only ever called on a run that has stopped, and anything
 * that is not a recognised ending is a failure rather than an ongoing state —
 * a leg that could come back as "still running" would let the errand wait on
 * something already settled.
 */
function runStatusToLegStatus(status: string): Exclude<LegStatus, 'running'> {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'failed';
  }
}

async function chargeTokens(
  db: ErrandDb,
  errandId: string,
  current: number,
  delta: number,
): Promise<void> {
  if (delta <= 0) return;
  // Read-modify-write is safe here for the same reason it is in the
  // orchestrator: the lease guarantees exactly one worker is touching this
  // errand, so there is no second writer to race.
  await db
    .from('errands')
    .update({ tokens_spent: current + delta })
    .eq('id', errandId)
    .select('id');
}

/** The model the workspace's own Cortex agent runs on. */
async function modelFor(db: SupabaseClient): Promise<string | null> {
  try {
    const agent = await loadAgent(db, 'cortex');
    return agent.defaultModel;
  } catch {
    return null;
  }
}

/** Exported for the boundary test: the toolset any errand leg may be handed. */
export function legToolset(): string[] {
  return errandToolAllowlist();
}

/**
 * The trámites this workspace has said may run with nobody watching.
 *
 * Never throws: a database hiccup here must read as "nothing is admitted",
 * which is the safe answer and the one the product had before this existed. An
 * error that widened the door instead would be the worst possible direction to
 * fail in.
 */
async function admittedTramites(db: SupabaseClient): Promise<string[]> {
  try {
    return (await listErrandFlows(db)).map((f) => f.slug);
  } catch (err) {
    logger.warn('errands: could not read which trámites may run unattended', {
      error: (err as Error).message,
    });
    return [];
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  UN TRÁMITE SE PARÓ A PEDIR UN CÓDIGO, Y EL ENCARGO NO SE MUERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Called by the advance loop before it decides anything else. A leg whose
 * trámite parked at a captcha or an OTP has left a checkpoint row (migration
 * 0111) pointing at a browser tab that is still open, and the errand has to do
 * with it exactly what it does with any other thing it cannot decide alone:
 * stop, ask, and keep everything it already has.
 *
 * ── WHY IT REUSES `askAndTell` AND INVENTS NOTHING ────────────────────────
 *
 * The question goes into `errand_questions`, under the one-open-question index,
 * announced in the conversation and on the bell — the same two channels, the
 * same deduplication, the same answer paths (`errands.answer`, the screen, the
 * route). Nothing about a captcha justifies a second question store, and a
 * second one would mean a second place to look for "why is this stuck".
 *
 * What IS trámite-specific is one line of the question: for a bot check the
 * answer is not words but an act, so the text carries the link to the screen
 * where the tab can be seen and clicked.
 *
 * ── THE HONEST LIMIT, SAID IN THE QUESTION ITSELF ─────────────────────────
 *
 * The tab lives minutes, not hours. So the question says how long is left. An
 * errand that asked «dame el código» and went silent for a day, then failed
 * because a session expired, would be a worse experience than one that never
 * offered to try — and a deadline stated up front is the difference between a
 * person answering now and a person answering eventually.
 */
/**
 * What to do about a parked trámite, in the three states it can be in.
 *
 * Returns null when there is nothing to do here and the ordinary machine should
 * carry on — which is the case while the question is sitting open, because a
 * blocked errand is already correctly doing nothing.
 */
async function handleParkedTramite(
  db: SupabaseClient,
  edb: ErrandDb,
  loaded: Loaded,
  organizationId: string,
  checkpoint: Checkpoint,
): Promise<AdvanceResult | null> {
  const questions = await loadQuestions(db, loaded.row.view.id);
  const asked = checkpoint.errandQuestionId
    ? questions.find((q) => q.id === checkpoint.errandQuestionId)
    : undefined;

  // Nobody has been asked yet.
  if (!asked) {
    return askForTheCheckpoint(db, edb, loaded, organizationId, checkpoint);
  }

  // Asked, and still waiting. `decideNext` already returns `nothing/blocked`
  // for this, so falling through would produce the same answer — but only
  // because a question exists, which is a coincidence this branch does not
  // rely on.
  if (asked.state === 'open') {
    return { did: 'nothing', again: false, detail: 'a trámite is waiting for a person' };
  }

  // Withdrawn: somebody cancelled or the question was lost. The tab is no use
  // to anybody now, so it is released rather than left to time out.
  if (asked.state !== 'answered' || !asked.answer) {
    await closeCheckpoint(db, checkpoint.id, 'cancelled');
    return null;
  }

  return resumeTheTramite(db, loaded, organizationId, checkpoint, asked.answer);
}

/**
 * They answered. Hand the code over and let the trámite finish.
 *
 * ── WHAT HAPPENS TO THE RESULT, AND WHY IT IS `findings` ──────────────────
 *
 * The certificate the trámite came back with is filed in Brain Knowledge by
 * the ordinary sink, exactly as it would be from the chat, and what the errand
 * keeps is a LINE SAYING SO — the flow, the document, the id. That line goes
 * into `findings`, which is the errand's memory between legs and what
 * `composeObjective` hands the next sub-agent. So the next leg opens knowing
 * that the certificate exists and what its id is, which is precisely what it
 * needs to pass into the `file` slot of the trámite that uploads it.
 *
 * Nothing here decides the errand is finished. A trámite completing is one
 * fact among the ones a leg produces, and the assessment that reads the leg is
 * still the thing that decides what the errand does about it.
 */
async function resumeTheTramite(
  db: SupabaseClient,
  loaded: Loaded,
  organizationId: string,
  checkpoint: Checkpoint,
  answer: string,
): Promise<AdvanceResult> {
  const view = loaded.row.view;
  const userId = loaded.row.userId;
  if (!userId) {
    await closeCheckpoint(db, checkpoint.id, 'cancelled');
    return { did: 'nothing', again: true, detail: 'the paused trámite has no owner left' };
  }

  const outcome = await resumeFlow({
    db,
    organizationId,
    actor: { id: userId, role: 'member' },
    checkpointId: checkpoint.id,
    answer,
    transport: createHttpTransport(logger),
    logger,
  }).catch((err: unknown) => {
    logger.error('errands: could not resume a paused trámite', {
      errandId: view.id,
      error: (err as Error).message,
    });
    return null;
  });

  const line = outcome
    ? `TRÁMITE WEB — ${outcome.ok ? 'terminado' : 'no pudo terminar'} después de la pausa: ${outcome.message}${describeDownload(outcome.output)}`
    : 'TRÁMITE WEB — se recibió la respuesta pero no se pudo retomar la sesión del navegador.';

  await db
    .from('errands')
    .update({ findings: carryForward(view.findings, line)?.slice(0, FINDINGS_STORE_LIMIT) })
    .eq('id', view.id);

  return { did: 'assess_leg', again: true, detail: outcome?.ok ? 'trámite resumed' : 'trámite failed' };
}

/**
 * The one sentence about a downloaded file that the next leg needs.
 *
 * The id and not the contents: the document is already indexed in Brain
 * Knowledge, so anything that wants to READ it can search for it, and what a
 * next leg needs in order to ATTACH it is exactly this string.
 */
function describeDownload(output: Record<string, unknown>): string {
  const download = output.download as { filename?: string; documentId?: string } | undefined;
  if (!download?.documentId) return '';
  return ` El archivo «${download.filename ?? 'descargado'}» quedó guardado en Brain Knowledge; para adjuntarlo en otro trámite se pasa como "doc:${download.documentId}".`;
}

async function askForTheCheckpoint(
  db: SupabaseClient,
  edb: ErrandDb,
  loaded: Loaded,
  organizationId: string,
  checkpoint: Checkpoint,
): Promise<AdvanceResult> {
  const view = loaded.row.view;

  // The tab is gone. Not a question — there is nothing left to answer — so it
  // is closed out and the errand goes back to ordinary work, which will
  // re-run the trámite from the top if it still needs it.
  if (!isCheckpointLive(checkpoint)) {
    await closeCheckpoint(db, checkpoint.id, 'expired');
    return { did: 'nothing', again: true, detail: 'the paused trámite expired' };
  }

  const minutes = Math.max(1, Math.round(checkpointSecondsLeft(checkpoint) / 60));
  const why =
    checkpoint.reason === 'bot-check'
      ? `El portal se detuvo a comprobar que no somos un robot, y eso no lo puedo resolver yo. La sesión sigue abierta con todo lo que el trámite ya llevaba hecho, y la puedes desbloquear desde Trámites web. Tengo unos ${minutes} minuto(s) antes de que el navegador cierre la pestaña; si se vence no se pierde nada, sólo toca volver a arrancarlo.`
      : `Es un dato que sólo tú tienes en este momento y que no se puede guardar de antemano. La sesión sigue abierta con todo lo que el trámite ya llevaba hecho; contéstame aquí mismo y sigo. Tengo unos ${minutes} minuto(s) antes de que el navegador cierre la pestaña.`;

  await askAndTell(db, edb, {
    errandId: view.id,
    organizationId,
    userId: loaded.row.userId,
    conversationId: view.conversationId,
    request: view.request,
    leg: view.legsUsed,
    question: checkpoint.ask,
    why,
    options: [],
  });

  // Cosmetic if it fails, and deliberately not awaited into the outcome: the
  // question is already stored and answerable. This just lets whoever answers
  // find the tab it belongs to.
  const open = (await loadQuestions(db, view.id)).find((q) => q.state === 'open');
  if (open) await linkCheckpointQuestion(db, checkpoint.id, open.id).catch(() => undefined);

  return { did: 'assess_leg', again: false, detail: 'a trámite is waiting for a person' };
}
