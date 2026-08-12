import type { Logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Actor } from './access';
import { canRunFlow } from './access';
import { classifyFailure, hasLoginSteps } from './classify';
import type { BrowserTransport } from './client';
import { unlockForRun } from './credentials';
import {
  currentDocumentSink,
  type DocumentSink,
  type DownloadedFile,
  separateDownload,
} from './download';
import { safeInputs } from './redact';
import { refineFromDom, refinementNote } from './refine';
import type { Repairer } from './repair';
import { modelRepairer } from './repair';
import {
  countRepair,
  finishRun,
  markBroken,
  markNeedsLogin,
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
  /**
   * Where a downloaded file goes. Defaults to whatever the process registered
   * at boot (see `setDocumentSink`); passed explicitly only by tests. Absent
   * altogether, the errand still runs and the file is described in the result
   * but not kept.
   */
  documentSink?: DocumentSink;
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
  failureKind?: 'transient' | 'legitimate' | 'site-changed' | 'needs-login';
  repaired?: boolean;
  newVersion?: number;
  /**
   * The run did not fail so much as stop and ask something. Nothing is wrong
   * with the flow, nothing was retried, and the answer is a person's to give.
   */
  pendingQuestion?: 'credential';
}

/**
 * Put the file somewhere it can be used, if this caller has somewhere.
 *
 * A trámite that ends at a results page and drops the certificate is somebody
 * sent to do a errand who comes back without the paper. Filing it as an
 * ordinary Brain Knowledge document is what makes it usable afterwards -- the
 * ingestion the sink triggers is the same one an upload goes through, so the
 * certificate gets parsed, chunked, indexed and run through the structured
 * extraction of migration 0076 without this module knowing any of that exists.
 */
async function fileDownload(
  options: RunOptions,
  file: DownloadedFile,
  runId: string,
): Promise<{ documentId: string; title: string } | null> {
  const sink = options.documentSink ?? currentDocumentSink();
  if (!sink) return null;
  const filed = await sink(file, {
    organizationId: options.organizationId,
    flowId: options.flow.id,
    flowName: options.flow.name,
    host: options.flow.host,
    runId,
    userId: options.actor.id,
  });
  if (filed) {
    options.logger.info(
      { flowId: options.flow.id, documentId: filed.documentId, bytes: file.sizeBytes },
      'browser flow filed the document it downloaded',
    );
  }
  return filed;
}

/**
 * What this flow can do about a login, which is what tells a locked door apart
 * from a rejected password.
 */
function loginFacts(flow: Flow): { hasCredential: boolean; hasLoginSteps: boolean } {
  return { hasCredential: Boolean(flow.credentialId), hasLoginSteps: hasLoginSteps(flow.steps) };
}

/**
 * The sentence a person can act on, which is the whole value of this state.
 *
 * It names the site, says what is missing and says what to do -- including the
 * part nobody guesses, which is that the recording has to be made again with
 * the sign-in inside it. A recording that starts after the door cannot be
 * patched by adding a password: there are no steps to put it in.
 */
function credentialQuestion(flow: Flow, alsoNeedsSteps: boolean): string {
  const site = flow.host || 'ese portal';
  if (!alsoNeedsSteps) {
    return `Para hacer «${flow.name}» necesito la cuenta de ${site}. Vincúlale una credencial en Trámites y vuelve a intentarlo; la clave queda cifrada y no se muestra en ninguna parte.`;
  }
  return `«${flow.name}» empieza después de iniciar sesión en ${site}, y la grabación arrancó cuando ya estabas adentro: no tiene los pasos del ingreso. Enséñamelo otra vez cerrando sesión primero, de modo que la grabación incluya el ingreso, y vincúlale la credencial de esa cuenta.`;
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

  // Asked before a browser is even opened, because the answer will not change
  // by trying: a run already known to need a login it does not have would spend
  // twenty seconds arriving at the same question.
  if (flow.loginRequired && !flow.credentialId) {
    const facts = loginFacts(flow);
    return {
      ok: false,
      runId: null,
      message: credentialQuestion(flow, !facts.hasLoginSteps),
      failureKind: 'needs-login',
      pendingQuestion: 'credential',
      durationMs: Date.now() - startedAt,
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
    // The file, if there is one, comes out of the result before anything
    // persists it. See download.ts: base64 belongs in object storage, not in a
    // JSONB column and not in a model's context.
    const carried = separateDownload(result.output);
    result.output = carried.output;
    const filed = carried.file
      ? await fileDownload(options, carried.file, runId).catch((err: unknown) => {
          logger.error(
            { err: (err as Error).message, flowId: flow.id },
            'browser flow could not file the document it downloaded',
          );
          return null;
        })
      : null;
    if (filed && carried.summary) {
      result.output = {
        ...result.output,
        download: { ...carried.summary, documentId: filed.documentId },
      };
    }

    await finishRun(db, runId, {
      status: 'succeeded',
      result: result.output,
      durationMs: result.durationMs,
      spend: EMPTY_SPEND,
    });
    await noteRun(db, flow.id, 'succeeded', null);
    await markVerified(db, flow.id, runId);

    // ---------------------------------------------------------------------
    // The flow just ran. Every step that resolved was asked what it is called.
    //
    // Only on the verification run, which is the one moment the step list is
    // still a reading of a photograph. After that the locators came from the
    // page already and re-asking would rewrite a proven flow every time it ran,
    // for nothing.
    // ---------------------------------------------------------------------
    if (options.verifying) {
      const refined = refineFromDom(flow.steps, result.steps);
      if (refined.changed.length > 0) {
        const version = await writeVersion(db, flow, {
          steps: refined.steps,
          reason: 'refined',
          changedStep: refined.changed[0],
          note: refinementNote(refined),
          by: actor.id,
          // The proof survives: these locators were read off the elements that
          // THIS run acted on, so the errand this version describes is the one
          // that just completed. Clearing the verification would demand a second
          // identical run to re-earn what the first one proved.
          keepProof: true,
        });
        logger.info(
          { flowId: flow.id, version, steps: refined.changed.length },
          'browser flow rewritten with the locators the DOM reported',
        );
        return {
          ok: true,
          runId,
          message: 'Listo.',
          output: result.output,
          steps: result.steps,
          durationMs: result.durationMs,
          spend: EMPTY_SPEND,
          newVersion: version,
        };
      }
    }

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
  const facts = loginFacts(flow);
  const verdict = classifyFailure({
    evidence: failure.evidence,
    snapshot: failure.snapshot,
    step: step ?? { action: 'click', label: failure.label, targets: [], landmarks: [] },
    flow: facts,
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

  // -------------------------------------------------------------------------
  // It is not broken. It is locked, and nobody was ever asked for the key.
  //
  // Remembered on the flow so the NEXT run asks up front instead of driving a
  // browser to the same door, and reported as a question rather than a defeat:
  // the flow keeps its status, no model is called, and nothing is retried.
  // -------------------------------------------------------------------------
  if (verdict.kind === 'needs-login') {
    const question = credentialQuestion(flow, !facts.hasLoginSteps);
    await markNeedsLogin(db, flow.id, question);
    return {
      ok: false,
      runId,
      message: question,
      failureKind: 'needs-login',
      pendingQuestion: 'credential',
      steps: result.steps,
      output: result.output,
      durationMs: result.durationMs,
      spend: EMPTY_SPEND,
    };
  }

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
