import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../../services/browser/node_modules/playwright';
import { createHttpTransport } from '../../packages/agent-tools/src/browser/client';
import {
  alignFirstGoto,
  extractFlowFromRecording,
} from '../../packages/agent-tools/src/browser/extract';
import type { Frame, Proposal } from '../../packages/agent-tools/src/browser/extract';
import type { Step, StepOutcome } from '../../packages/agent-tools/src/browser/types';
import { CASES, type Case, EXTRA_CASES, inputsFor } from './cases';
import { startCasePortal } from './portal';
import { HYPOTHESES } from './hypotheses';
import { recordErrand } from './record';

/**
 * The measurement that decides whether an engine change ships.
 *
 *     pnpm browser:cases
 *     pnpm browser:cases -- --pairs --refine --reps 2
 *
 * For each of three errands it produces a recording programmatically, reads it
 * with the real extractor, replays what came out against the same portal from a
 * clean browser, and counts. The number that matters is
 *
 *     A LA PRIMERA -- steps that ran AND resolved on their first locator, with
 *     no fallback, no repair and no model in the loop.
 *
 * Steps that only work via a fallback are not free: they are a portal one
 * redesign away from an incident. Steps repaired by a model are not free either.
 * So the only honest denominator is the errand's real length and the only honest
 * numerator is what worked outright.
 *
 * Every flag below turns ONE engine change on, so that each is defended or
 * dropped by the difference it makes here rather than by how good it sounds.
 */

const PORT = 3401;
const TOKEN = 'cases-token-not-a-secret';

interface Flags {
  pairs: boolean;
  refine: boolean;
  twoPass: boolean;
  fixed: boolean;
  reps: number;
  only: string[];
  budget: number;
}

function parseFlags(argv: string[]): Flags {
  const has = (name: string) => argv.includes(`--${name}`);
  const value = (name: string, fallback: string) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] ? (argv[at + 1] as string) : fallback;
  };
  return {
    pairs: has('pairs'),
    refine: has('refine'),
    twoPass: has('two-pass'),
    fixed: has('fixed'),
    reps: Number(value('reps', '1')),
    only: value('only', '')
      .split(',')
      .filter((s) => s.length > 0),
    budget: Number(value('budget', '20')),
  };
}

/** The harness needs a real key; it is in .env.local like everything else. */
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (match?.[1] && !process.env[match[1]]) {
          process.env[match[1]] = (match[2] ?? '').replace(/^["']|["']$/g, '');
        }
      }
    } catch {
      /* not there is fine */
    }
  }
}

const silent = {
  info: () => {},
  warn: () => {},
  // Loud on purpose: an extraction that fell over is the one thing a harness
  // must never report as a bad score.
  error: (fields: unknown) => console.error('  ! ', fields),
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  // biome-ignore lint/suspicious/noExplicitAny: standing in for pino's surface
} as any;

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await delay(500);
  }
  throw new Error('the browser service never became healthy');
}

interface Score {
  case: string;
  proposed: number;
  groundTruth: number;
  /** Steps that ran without error, before the first failure. */
  ran: number;
  /** Of those, the ones whose FIRST locator resolved. This is the headline. */
  firstTry: number;
  goal: boolean;
  failedAt: string | null;
  verdict: string | null;
  costUsd: number;
  extractMs: number;
  frames: number;
  refinedSteps: number;
}

function scoreOutcomes(steps: StepOutcome[]): { ran: number; firstTry: number } {
  let ran = 0;
  let firstTry = 0;
  for (const outcome of steps) {
    if (!outcome.ok) break;
    ran += 1;
    if (outcome.matchedRank === 0 || outcome.matchedRank === null) firstTry += 1;
  }
  return { ran, firstTry };
}

async function scoreCase(
  testCase: Case,
  portal: string,
  flags: Flags,
  transport: ReturnType<typeof createHttpTransport>,
  // biome-ignore lint/suspicious/noExplicitAny: playwright's Browser, kept loose
  browser: any,
): Promise<Score | null> {
  let costUsd = 0;
  let extractMs = 0;
  let frameCount = 0;
  let read: Proposal;

  if (flags.fixed) {
    // The engine, measured without the model. See hypotheses.ts for what these
    // are and, more importantly, for what they are not.
    const hypothesis = HYPOTHESES[testCase.id];
    if (!hypothesis) return null;
    read = hypothesis(portal);
  } else {
    // -------------------------------------------------------------------
    // 1. Film it.
    // -------------------------------------------------------------------
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    await testCase.prelude(page, portal);
    const frames: Frame[] = await recordErrand({
      page,
      acts: testCase.acts(portal),
      paired: flags.pairs,
      budget: flags.budget,
    });
    await context.close();
    frameCount = frames.length;

    // -------------------------------------------------------------------
    // 2. Read it.
    // -------------------------------------------------------------------
    const startedExtract = Date.now();
    const extracted = await extractFlowFromRecording({
      frames,
      hint: testCase.hint,
      logger: silent,
      twoPass: flags.twoPass,
    });
    extractMs = Date.now() - startedExtract;
    if (!extracted.ok) {
      console.log(`  ${testCase.id}: la extracción falló — ${extracted.reason}`);
      return null;
    }
    costUsd = extracted.result.spend.costUsd;
    read = extracted.result.proposal;
  }

  // The person fixes the address on the review screen: a tab capture has no URL
  // bar in it, so this is theirs to supply and not the model's to invent -- and
  // the correction has to reach the first `goto` too, which is what the API
  // route does with the same function.
  const proposal = alignFirstGoto({
    ...read,
    startUrl: testCase.startUrl(portal),
  });
  const steps: Step[] = proposal.steps;

  // ---------------------------------------------------------------------
  // 3. Replay it from a clean browser, which is the only honest test.
  // ---------------------------------------------------------------------
  const replayed = await replayAndMaybeRefine({
    transport,
    startUrl: proposal.startUrl,
    steps,
    // The values the errand is scored with are NOT the values it was taught
    // with. Re-enacting a recording proves nothing; doing the next one does.
    inputs: inputsFor(testCase, proposal.variables, 'replay'),
    teachInputs: inputsFor(testCase, proposal.variables, 'teach'),
    secrets: testCase.secrets ?? {},
    refine: flags.refine,
  });

  const { ran, firstTry } = scoreOutcomes(replayed.steps);
  const output = JSON.stringify(replayed.output);

  return {
    case: testCase.id,
    proposed: steps.length,
    groundTruth: testCase.groundTruthSteps,
    ran,
    firstTry,
    goal: output.includes(testCase.expects),
    failedAt: replayed.failure
      ? `${replayed.failure.index}: ${replayed.failure.label} — ${replayed.failure.error}`
      : null,
    verdict: replayed.verdict,
    costUsd,
    extractMs,
    frames: frameCount,
    refinedSteps: replayed.refinedSteps,
  };
}

/**
 * The teaching sequence, then the errand -- which is the sequence the product
 * actually runs and therefore the only one worth scoring.
 *
 * With refinement on there are two runs, and they are not the same run twice:
 *
 *   1  VERIFICATION, with the values the person taught with. This is what
 *      `POST /api/browser/flows` does with `sample`, and it is where the DOM
 *      gets to describe each element the flow touched.
 *   2  THE ERRAND, from a fresh browser, with DIFFERENT values. Only this one
 *      is scored.
 *
 * Running them the other way round -- refining from the scored run -- would
 * measure nothing, since the flow would be corrected by the very run being
 * graded. And scoring the taught values would measure a re-enactment.
 */
async function replayAndMaybeRefine(input: {
  transport: ReturnType<typeof createHttpTransport>;
  startUrl: string;
  steps: Step[];
  inputs: Record<string, string>;
  teachInputs: Record<string, string>;
  secrets: Record<string, string>;
  refine: boolean;
}): Promise<{
  steps: StepOutcome[];
  output: Record<string, unknown>;
  failure: { index: number; label: string; error: string } | null;
  verdict: string | null;
  refinedSteps: number;
}> {
  const { classifyFailure, hasLoginSteps } = await import(
    '../../packages/agent-tools/src/browser/classify'
  );
  const { refineFromDom } = await import('../../packages/agent-tools/src/browser/refine');
  const { transport, startUrl, secrets } = input;

  let steps = input.steps;
  let refinedSteps = 0;

  if (input.refine) {
    const verification = await transport.replay({
      runId: `case-verify-${Date.now()}`,
      startUrl,
      steps,
      inputs: input.teachInputs,
      secrets,
    });
    if (verification.ok) {
      const refined = refineFromDom(steps, verification.data.steps);
      refinedSteps = refined.changed.length;
      steps = refined.steps;
    }
  }

  const run = await transport.replay({
    runId: `case-${Date.now()}`,
    startUrl,
    steps,
    inputs: input.inputs,
    secrets,
  });
  if (!run.ok) throw new Error(run.reason);
  const result = run.data;

  const failing = result.failure;
  const verdict = failing
    ? classifyFailure({
        evidence: failing.evidence,
        snapshot: failing.snapshot,
        step: steps[failing.index] ?? {
          action: 'click',
          label: failing.label,
          targets: [],
          landmarks: [],
        },
        // What execute.ts passes: whether this flow could open a door at all.
        flow: { hasCredential: Object.keys(secrets).length > 0, hasLoginSteps: hasLoginSteps(steps) },
      })
    : null;

  return {
    steps: result.steps,
    output: result.output,
    failure: failing
      ? { index: failing.index, label: failing.label, error: failing.error }
      : null,
    verdict: verdict ? `${verdict.kind}/${verdict.rule}` : null,
    refinedSteps,
  };
}

async function main(): Promise<void> {
  loadEnv();
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.fixed && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'sin ANTHROPIC_API_KEY no se puede medir la extracción. Para medir sólo el motor: --fixed',
    );
  }

  const portal = await startCasePortal();
  const service = spawn('node', ['services/browser/dist/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), BROWSER_SERVICE_TOKEN: TOKEN, LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  process.env.BROWSER_SERVICE_URL = `http://127.0.0.1:${PORT}`;
  process.env.BROWSER_SERVICE_TOKEN = TOKEN;

  const browser = await chromium.launch({ headless: true });
  const scores: Score[] = [];

  try {
    await waitForHealth();
    const transport = createHttpTransport(silent);
    const chosen = [...CASES, ...EXTRA_CASES].filter(
      (c) =>
        flags.only.length === 0 ? CASES.includes(c) : flags.only.includes(c.id),
    );

    console.log(
      `portal ${portal.url} · ${flags.fixed ? 'hipótesis fija' : flags.pairs ? 'pareja' : 'sueltos'}` +
        `${flags.refine ? ' · refinado' : ''}${flags.twoPass ? ' · dos pases' : ''}` +
        ` · presupuesto ${flags.budget} cuadros · ${flags.reps} repetición(es)\n`,
    );

    for (const testCase of chosen) {
      for (let rep = 0; rep < flags.reps; rep++) {
        const score = await scoreCase(testCase, portal.url, flags, transport, browser);
        if (!score) continue;
        scores.push(score);
        console.log(
          `  ${score.case.padEnd(16)} a la primera ${score.firstTry}/${score.groundTruth}` +
            ` · corrieron ${score.ran}/${score.proposed}` +
            ` · meta ${score.goal ? 'sí' : 'NO'}` +
            (score.refinedSteps > 0 ? ` · ${score.refinedSteps} refinados` : '') +
            `${score.failedAt ? ` · murió en ${score.failedAt} [${score.verdict}]` : ''}` +
            ` · ${score.frames} cuadros · US$${score.costUsd.toFixed(4)} · ${Math.round(score.extractMs / 100) / 10}s`,
        );
      }
    }

    console.log('\n─────────────────────────────────────────────');
    const byCase = new Map<string, Score[]>();
    for (const score of scores) {
      byCase.set(score.case, [...(byCase.get(score.case) ?? []), score]);
    }
    let totalFirst = 0;
    let totalTruth = 0;
    let goals = 0;
    for (const [id, list] of byCase) {
      const first = list.reduce((a, s) => a + s.firstTry, 0) / list.length;
      const truth = list[0]?.groundTruth ?? 0;
      const goal = list.filter((s) => s.goal).length;
      totalFirst += first;
      totalTruth += truth;
      goals += goal;
      console.log(
        `${id.padEnd(16)} a la primera ${first.toFixed(1)}/${truth} · meta ${goal}/${list.length}`,
      );
    }
    console.log(
      `TOTAL            a la primera ${totalFirst.toFixed(1)}/${totalTruth}` +
        ` (${Math.round((totalFirst / Math.max(1, totalTruth)) * 100)}%) · meta ${goals}/${scores.length}` +
        ` · US$${scores.reduce((a, s) => a + s.costUsd, 0).toFixed(4)}`,
    );
  } finally {
    await browser.close().catch(() => undefined);
    service.kill('SIGTERM');
    await portal.close();
    await delay(300);
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
