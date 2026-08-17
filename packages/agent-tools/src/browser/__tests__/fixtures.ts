import type { BrowserTransport, ReplayCall, ResumeCall, TransportResult } from '../client';
import type {
  BrowserHandoff,
  FailureEvidence,
  Flow,
  PageSnapshot,
  ReplayResponse,
  Step,
  StepOutcome,
} from '../types';

/**
 * The scaffolding the browser tests run on.
 *
 * The transport is the seam that makes the rest of this module testable without
 * Chromium: `execute.ts` never touches a browser, it drives a
 * `BrowserTransport`, and every test here hands it a scripted one. That is also
 * how "a replay does not call the model" becomes an assertion rather than a
 * hope -- the transport records every call, and the repairer is a function that
 * throws.
 */

export const ORG = 'org-acme';
export const OTHER_ORG = 'org-globex';
export const USER = '11111111-1111-4111-8111-111111111111';

export function step(overrides: Partial<Step> & { label: string }): Step {
  return {
    action: 'click',
    targets: [{ kind: 'role', value: 'button', name: overrides.label }],
    landmarks: ['Consulta de vehículos', 'RUNT'],
    ...overrides,
  };
}

export const PLATE_FLOW_STEPS: Step[] = [
  step({
    action: 'goto',
    label: 'Abrir la consulta',
    targets: [],
    url: 'https://portal.test/consulta',
  }),
  step({
    action: 'fill',
    label: 'Número de placa',
    targets: [
      { kind: 'label', value: 'Número de placa' },
      { kind: 'name', value: 'txtPlaca' },
      { kind: 'css', value: '#form > div:nth-of-type(2) > input' },
    ],
    value: { kind: 'template', text: '{{placa}}' },
  }),
  step({ action: 'click', label: 'Consultar' }),
  step({ action: 'extract', label: 'Estado del vehículo', extractAs: 'estado' }),
];

export function makeFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    id: 'flow-1',
    organizationId: ORG,
    slug: 'consulta-placa',
    name: 'Consulta de placa',
    description: 'Consulta el estado de un vehículo por placa.',
    startUrl: 'https://portal.test/consulta',
    host: 'https://portal.test',
    effect: 'read',
    status: 'ready',
    source: 'recording',
    credentialId: null,
    loginRequired: false,
    errandAllowed: false,
    variables: [
      { name: 'placa', label: 'Placa', example: 'ABC123', required: true, type: 'plate' },
    ],
    steps: PLATE_FLOW_STEPS,
    version: 1,
    verifiedAt: '2026-08-01T00:00:00.000Z',
    repairsInWindow: 0,
    repairWindowStartedAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastError: null,
    recordingFrames: 12,
    extractionCostUsd: 0.08,
    createdBy: USER,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * What the service would have put in the trace for this step.
 *
 * Already redacted: a secret step reads '***' and there is no code path in
 * Cortex that could put anything else there. A file step shows its REFERENCE,
 * which names the document without revealing any of it.
 */
function previewOf(s: Step): string | null {
  if (!s.value) return null;
  if (s.value.kind === 'secret') return '***';
  if (s.value.kind === 'file') return s.value.from;
  return s.value.text;
}

export function okOutcomes(
  steps: Step[],
  matchedRank = 0,
  /** What the live DOM said each element calls itself. See refine.ts. */
  observed?: (step: Step, index: number) => StepOutcome['observedTargets'],
): StepOutcome[] {
  return steps.map((s, index) => ({
    index,
    action: s.action,
    label: s.label,
    url: 'https://portal.test/consulta',
    matchedTarget: s.targets[0] ? `${s.targets[0].kind}=${s.targets[0].value}` : null,
    matchedRank: s.targets.length > 0 ? matchedRank : null,
    valuePreview: previewOf(s),
    ok: true,
    durationMs: 120,
    ...(observed ? { observedTargets: observed(s, index) } : {}),
  }));
}

export function emptySnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://portal.test/consulta',
    title: 'Consulta',
    headings: [],
    alerts: [],
    text: '',
    elements: [],
    ...overrides,
  };
}

export function evidence(overrides: Partial<FailureEvidence> = {}): FailureEvidence {
  return {
    url: 'https://portal.test/consulta',
    pageTitle: 'Consulta de vehículos',
    httpStatus: 200,
    navigationFailed: false,
    timedOut: false,
    landmarksExpected: 2,
    landmarksPresent: 2,
    alertText: null,
    bodyTextSample: 'Consulta de vehículos RUNT',
    candidates: [],
    visibleButBlocked: false,
    ...overrides,
  };
}

export interface ScriptedTransport extends BrowserTransport {
  calls: ReplayCall[];
  /** Every `/continue` this transport was asked for, in order. */
  resumes: ResumeCall[];
}

/**
 * A transport that answers from a script, one reply per call, and records what
 * it was asked. The last reply repeats, so a test that only cares about the
 * first outcome does not have to enumerate the rest.
 *
 * `replay` and `resume` share one script and one cursor, deliberately: a run
 * that pauses and is then resumed is ONE sequence of answers from the portal's
 * point of view, and a test that had to keep two scripts in step would be
 * asserting about its own bookkeeping.
 */
export function scriptedTransport(replies: TransportResult<ReplayResponse>[]): ScriptedTransport {
  const calls: ReplayCall[] = [];
  const resumes: ResumeCall[] = [];
  let index = 0;
  const next = () => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return reply ?? { ok: false as const, configured: true, reason: 'sin respuesta programada' };
  };
  return {
    calls,
    resumes,
    configured: () => true,
    replay: async (call) => {
      calls.push(call);
      return next();
    },
    resume: async (call) => {
      resumes.push(call);
      return next();
    },
    openSession: async () => ({ ok: false, configured: true, reason: 'no usado en esta prueba' }),
    act: async () => ({ ok: false, configured: true, reason: 'no usado en esta prueba' }),
    closeSession: async () => undefined,
  };
}

/**
 * The portal stopped and asked for something only a person has.
 *
 * `ok: false` and NO `failure`, which is the whole shape of the thing: nothing
 * went wrong, so there is no evidence to gather and no verdict to reach.
 */
export function pausedAt(
  steps: Step[],
  index: number,
  ask: string,
  fills: string | null,
  handoff?: Partial<BrowserHandoff>,
) {
  const outcomes = okOutcomes(steps.slice(0, index + 1));
  return {
    ok: true as const,
    data: {
      ok: false,
      runId: 'r',
      durationMs: 4_200,
      steps: outcomes,
      output: {},
      pause: { index, ask, fills },
      handoff: {
        sessionId: 's_test_1',
        reason: 'input-needed' as const,
        fromIndex: index + 1,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        ask,
        fills,
        ...handoff,
      },
    } satisfies ReplayResponse,
  };
}

export function succeeded(
  steps: Step[],
  output: Record<string, unknown> = {},
  matchedRank = 0,
  observed?: (step: Step, index: number) => StepOutcome['observedTargets'],
) {
  return {
    ok: true as const,
    data: {
      ok: true,
      runId: 'r',
      durationMs: 3_400,
      steps: okOutcomes(steps, matchedRank, observed),
      output,
    } satisfies ReplayResponse,
  };
}

export function failedAt(
  steps: Step[],
  index: number,
  ev: FailureEvidence,
  snapshot: PageSnapshot = emptySnapshot(),
) {
  const outcomes = okOutcomes(steps.slice(0, index));
  const failing = steps[index];
  outcomes.push({
    index,
    action: failing?.action ?? 'click',
    label: failing?.label ?? '',
    url: ev.url,
    matchedTarget: null,
    matchedRank: null,
    valuePreview: null,
    ok: false,
    durationMs: 20_000,
    error: 'no lo encontré',
  });
  return {
    ok: true as const,
    data: {
      ok: false,
      runId: 'r',
      durationMs: 24_000,
      steps: outcomes,
      output: {},
      failure: {
        index,
        label: failing?.label ?? '',
        error: 'no lo encontré',
        evidence: ev,
        snapshot,
      },
    } satisfies ReplayResponse,
  };
}

/** A repairer that fails the test if anything reaches it. */
export const forbiddenRepairer = () => {
  throw new Error('the model was called on a path that must never call it');
};

/** Everything written to the log, so a test can grep it for a secret. */
export function capturingLogger(): { logger: unknown; lines: string[] } {
  const lines: string[] = [];
  const write =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push(`${level} ${args.map((a) => JSON.stringify(a) ?? String(a)).join(' ')}`);
    };
  return {
    lines,
    logger: {
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      debug: write('debug'),
      trace: write('trace'),
      fatal: write('fatal'),
    },
  };
}
