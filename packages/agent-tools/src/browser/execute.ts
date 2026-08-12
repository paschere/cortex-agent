import type { Logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Actor } from './access';
import { canRunFlow } from './access';
import { classifyFailure } from './classify';
import type { BrowserTransport } from './client';
import { unlockForRun } from './credentials';
import { safeInputs } from './redact';
import type { Repairer } from './repair';
import { modelRepairer } from './repair';
import {
  countRepair,
  finishRun,
  markBroken,
  markVerified,
  noteRun,
  recordSteps,
  repairsExhausted,
  startRun,
  writeVersion,
} from './store';
import type { Flow, ModelSpend, Step, StepOutcome } from './types';
import { EMPTY_SPEND } from './types';

/**
 * Running a learned errand, end to end.
 *
 * ---------------------------------------------------------------------------
 * THE HAPPY PATH HAS NO MODEL IN IT
 * ---------------------------------------------------------------------------
 * Read the first half of `run` below: access check, unlock, replay, record.
 * There is no import of a provider, no prompt and no token. `modelRepairer` is
 * reached only from inside the `site-changed` branch, which needs a failure and
 * a classification to get to. That is not a convention -- `execute.replay.test.ts`
 * runs a whole successful flow with a repairer that throws if it is called.
 *
 * ---------------------------------------------------------------------------
 * THE THREE THINGS A FAILURE CAN BE, AND WHAT EACH COSTS
 * ---------------------------------------------------------------------------
 *   transient      recorded, reported, flow untouched. Retry is the caller's
 *                  to make.
 *   legitimate     recorded, reported, flow untouched, and the sentence names
 *                  what the portal actually said. The errand failed; the flow
 *                  is fine.
 *   site-changed   one repair attempt, and only if the budget allows it.
 *
 * ---------------------------------------------------------------------------
 * A REPAIR ONLY COUNTS IF THE WHOLE ERRAND THEN WORKS
 * ---------------------------------------------------------------------------
 * The repaired step list is replayed FROM THE BEGINNING, and the new version is
 * written only when that replay reaches the end. This is the difference between
 * self-healing and self-corrupting. A model that binds the step to the wrong
 * element will produce a replay that dies two steps later, and the flow is left
 * exactly as it was -- broken, visibly, which is the honest state. Nothing is
 * saved on the strength of the model having answered.
 */

export interface RunOptions {
  db: SupabaseClient;
  organizationId: string;
  actor: Actor;
  flow: Flow;
  inputs: Record<string, string>;
  transport: BrowserTransport;
  logger: Logger;
  trigger: 'manual' | 'chat' | 'test' | 'schedule' | 'verify';
  /** Substituted in tests. Null switches repair off entirely. */
  repairer?: Repairer | null;
  /**
   * True for the replay that runs immediately after a recording is read, which
   * is the same machinery pointed at a different problem and therefore needs
   * two behaviours changed.
   *
   * A version written during verification is `refined`, not `repaired`: the
   * model misread a picture, which is extraction still finishing, not a portal
   * that moved. And a verification that fails leaves the flow `draft` --
   * PROPUESTO, the state it was already in -- rather than marking it `broken`,
   * because a hypothesis that did not pan out was never a working thing to
   * break.
   */
  verifying?: boolean;
}

export interface RunOutcome {
  ok: boolean;
  runId: string | null;
  /** A sentence for a person. Never contains a credential. */
  message: string;
  output: Record<string, unknown>;
  steps: StepOutcome[];
  durationMs: number;
  spend: ModelSpend;
  failureKind?: 'transient' | 'legitimate' | 'site-changed';
  repaired?: boolean;
  newVersion?: number;
}

function missingVariables(flow: Flow, inputs: Record<string, string>): string[] {
  return flow.variables
    .filter((v) => v.required && !(inputs[v.name] ?? '').trim())
    .map((v) => v.label);
}

/**
 * A step whose preferred selector stopped working but which a lower-ranked one
 * still found. Promoting the survivor is how the flow absorbs a redesign that
 * only touched markup -- for free, with no model and no failed run.
 */
function promoteDrift(steps: Step[], outcomes: StepOutcome[]): { steps: Step[]; moved: number[] } {
  const moved: number[] = [];
  const next = steps.map((step, index) => {
    const outcome = outcomes.find((o) => o.index === index);
    const rank = outcome?.matchedRank ?? 0;
    if (!outcome?.ok || rank === null || rank <= 0) return step;
    const winner = step.targets[rank];
    if (!winner) return step;
    moved.push(index);
    return {
      ...step,
      targets: [winner, ...step.targets.filter((_, i) => i !== rank)],
    };
  });
  return { steps: next, moved };
}

export async function runFlow(options: RunOptions): Promise<RunOutcome> {
  const { db, flow, inputs, transport, logger, actor } = options;
  const startedAt = Date.now();
  const empty = { output: {}, steps: [] as StepOutcome[], spend: EMPTY_SPEND };

  const access = await canRunFlow(db, actor, flow);
  if (!access.allowed) {
    return { ok: false, runId: null, message: access.reason, durationMs: 0, ...empty };
  }

  const missing = missingVariables(flow, inputs);
  if (missing.length > 0) {
    return {
      ok: false,
      runId: null,
      message: `Me falta ${missing.join(', ')} para hacer este trámite.`,
      durationMs: 0,
      ...empty,
    };
  }

  if (!transport.configured()) {
    return {
      ok: false,
      runId: null,
      message:
        'El servicio de navegador no está conectado en este espacio de trabajo, así que no puedo ejecutar trámites en sitios web.',
      durationMs: 0,
      ...empty,
    };
  }

  let secrets: Record<string, string> = {};
  if (flow.credentialId) {
    try {
      secrets = await unlockForRun(db, flow.credentialId, flow.host);
    } catch (err) {
      return {
        ok: false,
        runId: null,
        message: (err as Error).message,
        durationMs: Date.now() - startedAt,
        ...empty,
      };
    }
  }

  const variableNames = flow.variables.map((v) => v.name);
  const runId = await startRun(db, {
    organizationId: options.organizationId,
    flowId: flow.id,
    flowVersion: flow.version,
    mode: 'replay',
    trigger: options.trigger,
    inputs: safeInputs(inputs, variableNames),
    startedBy: actor.id,
  });

  const replayed = await transport.replay({
    runId,
    startUrl: flow.startUrl,
    steps: flow.steps,
    inputs,
    secrets,
  });

  if (!replayed.ok) {
    // The transport itself failed -- the service is down or refused us. Nothing
    // was learned about the flow, so nothing about it changes.
    await finishRun(db, runId, {
      status: 'failed',
      failureKind: 'transient',
      error: replayed.reason,
      durationMs: Date.now() - startedAt,
      spend: EMPTY_SPEND,
    });
    await noteRun(db, flow.id, 'failed', replayed.reason);
    return {
      ok: false,
      runId,
      message: replayed.reason,
      failureKind: 'transient',
      durationMs: Date.now() - startedAt,
      ...empty,
    };
  }

  const result = replayed.data;
  await recordSteps(db, runId, result.steps);

  // -------------------------------------------------------------------------
  // It worked.
  // -------------------------------------------------------------------------
  if (result.ok) {
    await finishRun(db, runId, {
      status: 'succeeded',
      result: result.output,
      durationMs: result.durationMs,
      spend: EMPTY_SPEND,
    });
    await noteRun(db, flow.id, 'succeeded', null);
    await markVerified(db, flow.id, runId);

    const drift = promoteDrift(flow.steps, result.steps);
    let newVersion: number | undefined;
    if (drift.moved.length > 0) {
      newVersion = await writeVersion(db, flow, {
        steps: drift.steps,
        reason: 'drifted',
        changedStep: drift.moved[0] ?? null ?? undefined,
        note: `El portal cambió un poco y ${drift.moved.length} paso(s) se encontraron por una vía alterna. Reordené los localizadores; no hizo falta el modelo.`,
        by: actor.id,
      });
      logger.info(
        { flowId: flow.id, steps: drift.moved.length },
        'browser flow absorbed selector drift without a model',
      );
    }

    return {
      ok: true,
      runId,
      message: 'Listo.',
      output: result.output,
      steps: result.steps,
      durationMs: result.durationMs,
      spend: EMPTY_SPEND,
      newVersion,
    };
  }

  // -------------------------------------------------------------------------
  // It failed. What kind of failure is it?
  // -------------------------------------------------------------------------
  const failure = result.failure;
  if (!failure) {
    await finishRun(db, runId, {
      status: 'failed',
      failureKind: 'transient',
      error: 'falló sin decir por qué',
      durationMs: result.durationMs,
      spend: EMPTY_SPEND,
    });
    await noteRun(db, flow.id, 'failed', 'falló sin decir por qué');
    return {
      ok: false,
      runId,
      message: 'El trámite falló y el servicio no dijo por qué.',
      failureKind: 'transient',
      durationMs: result.durationMs,
      ...empty,
    };
  }

  const step = flow.steps[failure.index];
  const verdict = classifyFailure({
    evidence: failure.evidence,
    snapshot: failure.snapshot,
    step: step ?? { action: 'click', label: failure.label, targets: [], landmarks: [] },
  });

  await finishRun(db, runId, {
    status: 'failed',
    failureKind: verdict.kind,
    error: verdict.reason,
    durationMs: result.durationMs,
    spend: EMPTY_SPEND,
  });
  await noteRun(db, flow.id, 'failed', verdict.reason);

  logger.info(
    { flowId: flow.id, rule: verdict.rule, kind: verdict.kind, stepIndex: failure.index },
    'browser flow failed',
  );

  // A transient or legitimate failure ends here, and ends WITHOUT touching the
  // flow. This early return is the guard the whole module depends on.
  if (verdict.kind !== 'site-changed') {
    return {
      ok: false,
      runId,
      message: verdict.reason,
      failureKind: verdict.kind,
      steps: result.steps,
      output: result.output,
      durationMs: result.durationMs,
      spend: EMPTY_SPEND,
    };
  }

  // -------------------------------------------------------------------------
  // The site changed. One repair attempt, if the budget allows.
  // -------------------------------------------------------------------------
  const repairer = options.repairer === undefined ? modelRepairer : options.repairer;
  if (!repairer) {
    if (!options.verifying) await markBroken(db, flow.id, verdict.reason);
    return {
      ok: false,
      runId,
      message: verdict.reason,
      failureKind: 'site-changed',
      steps: result.steps,
      output: result.output,
      durationMs: result.durationMs,
      spend: EMPTY_SPEND,
    };
  }

  if (repairsExhausted(flow)) {
    const why = `${verdict.reason} Ya lo reparé tres veces en las últimas 24 horas, así que lo dejo marcado como roto para que alguien lo revise.`;
    if (!options.verifying) await markBroken(db, flow.id, why);
    return {
      ok: false,
      runId,
      message: why,
      failureKind: 'site-changed',
      steps: result.steps,
      output: result.output,
      durationMs: result.durationMs,
      spend: EMPTY_SPEND,
    };
  }

  const repaired = await repairFlow({
    ...options,
    runId,
    failureIndex: failure.index,
    snapshot: failure.snapshot,
    secrets,
    startedAt,
    reason: verdict.reason,
  });
  return repaired;
}

async function repairFlow(
  input: RunOptions & {
    runId: string;
    failureIndex: number;
    snapshot: import('./types').PageSnapshot;
    secrets: Record<string, string>;
    startedAt: number;
    reason: string;
  },
): Promise<RunOutcome> {
  const { db, flow, transport, logger, actor, inputs } = input;
  const repairer = (input.repairer ?? modelRepairer) as Repairer;
  const step = flow.steps[input.failureIndex];
  if (!step) {
    if (!input.verifying) await markBroken(db, flow.id, input.reason);
    return {
      ok: false,
      runId: input.runId,
      message: input.reason,
      failureKind: 'site-changed',
      output: {},
      steps: [],
      durationMs: Date.now() - input.startedAt,
      spend: EMPTY_SPEND,
    };
  }

  const found = await repairer({
    step,
    stepIndex: input.failureIndex,
    snapshot: input.snapshot,
    context: {
      before: flow.steps
        .slice(Math.max(0, input.failureIndex - 3), input.failureIndex)
        .map((s) => s.label),
      after: flow.steps.slice(input.failureIndex + 1, input.failureIndex + 4).map((s) => s.label),
    },
  }).catch((err: unknown) => {
    logger.error({ err: (err as Error).message, flowId: flow.id }, 'browser flow repair threw');
    return null;
  });

  if (!found) {
    const why = input.verifying
      ? `${input.reason} No conseguí identificar el elemento en la página real, así que el trámite queda propuesto y sin probar.`
      : `${input.reason} No conseguí identificar con confianza el elemento nuevo, así que dejo el trámite marcado como roto en vez de arreglarlo a medias.`;
    if (!input.verifying) await markBroken(db, flow.id, why);
    return {
      ok: false,
      runId: input.runId,
      message: why,
      failureKind: 'site-changed',
      output: {},
      steps: [],
      durationMs: Date.now() - input.startedAt,
      spend: EMPTY_SPEND,
    };
  }

  const patched = flow.steps.map((s, i) =>
    i === input.failureIndex ? { ...s, targets: found.targets } : s,
  );

  // A second run row, mode `repair`, so the cost of healing is visible next to
  // the runs that cost nothing rather than hidden inside one of them.
  const repairRunId = await startRun(db, {
    organizationId: input.organizationId,
    flowId: flow.id,
    flowVersion: flow.version,
    mode: 'repair',
    trigger: input.trigger,
    inputs: input.inputs,
    startedBy: actor.id,
  });

  const replayed = await transport.replay({
    runId: repairRunId,
    startUrl: flow.startUrl,
    steps: patched,
    inputs,
    secrets: input.secrets,
  });

  const failedRepair = async (why: string, durationMs: number): Promise<RunOutcome> => {
    await finishRun(db, repairRunId, {
      status: 'failed',
      failureKind: 'site-changed',
      error: why,
      durationMs,
      spend: found.spend,
    });
    // Deliberately NOT written as a version. The model's answer did not survive
    // contact with the site, so the flow keeps the steps it had.
    if (!input.verifying) await markBroken(db, flow.id, why);
    return {
      ok: false,
      runId: repairRunId,
      message: why,
      failureKind: 'site-changed',
      output: {},
      steps: [],
      durationMs,
      spend: found.spend,
    };
  };

  if (!replayed.ok) {
    return failedRepair(
      `${input.reason} Intenté repararlo y el servicio no respondió, así que no cambié nada.`,
      Date.now() - input.startedAt,
    );
  }

  const result = replayed.data;
  await recordSteps(db, repairRunId, result.steps);

  if (!result.ok) {
    return failedRepair(
      `${input.reason} Intenté repararlo pero el trámite volvió a fallar, así que dejé los pasos como estaban.`,
      result.durationMs,
    );
  }

  // It worked end to end. Now -- and only now -- the finding becomes the flow.
  const newVersion = await writeVersion(db, flow, {
    steps: patched,
    reason: input.verifying ? 'refined' : 'repaired',
    changedStep: input.failureIndex,
    note: found.note,
    by: actor.id,
  });
  // Verification refinements do not spend the repair budget: that budget exists
  // to stop a model rewriting a PROVEN flow over and over, and a flow being
  // taught has nothing yet to protect.
  if (!input.verifying) await countRepair(db, flow);
  await finishRun(db, repairRunId, {
    status: 'succeeded',
    result: result.output,
    durationMs: result.durationMs,
    spend: found.spend,
    updatedFlow: true,
  });
  await markVerified(db, flow.id, repairRunId);
  await noteRun(db, flow.id, 'succeeded', null);

  logger.info(
    { flowId: flow.id, version: newVersion, stepIndex: input.failureIndex },
    'browser flow repaired itself and the fix was saved',
  );

  return {
    ok: true,
    runId: repairRunId,
    message: input.verifying
      ? `Había leído mal «${step.label}» de la grabación. Lo corregí contra la página real y el trámite corrió completo.`
      : `El portal había cambiado. Encontré «${step.label}» otra vez, terminé el trámite y dejé el flujo actualizado (versión ${newVersion}).`,
    output: result.output,
    steps: result.steps,
    durationMs: result.durationMs,
    spend: found.spend,
    repaired: true,
    newVersion,
  };
}
