/**
 * The vocabulary of a learned errand.
 *
 * This file is the contract between four things that must not drift: the model
 * that reads a screen recording and proposes steps, the database column that
 * stores them, the browser service that executes them, and the screen a person
 * edits them on. `wire.test.ts` checks the copy in `services/browser` still
 * agrees with it.
 */

import { z } from 'zod';

/**
 * How an element is found, best first.
 *
 * The order is the whole robustness story. `testid` is put there for
 * automation. `role` is what the element IS plus what it SAYS -- the pair a
 * person uses and the pair that survives a restyle. `label` and `placeholder`
 * are the words printed next to and inside a field. `name` is the form field
 * name, server-generated on the JSF and ASP.NET stacks most Colombian portals
 * run on and therefore untouched by anything cosmetic. `text` is the words on a
 * link. `css` is last because a structural path is the selector that breaks the
 * first time somebody wraps a div around something.
 */
export const TARGET_KINDS = [
  'testid',
  'role',
  'label',
  'placeholder',
  'text',
  'name',
  'css',
] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const targetSchema = z.object({
  kind: z.enum(TARGET_KINDS),
  value: z.string().min(1).max(400),
  /** Accessible name. Only meaningful when `kind` is `role`. */
  name: z.string().max(200).optional(),
});
export type Target = z.infer<typeof targetSchema>;

/**
 * What goes into the element -- and the answer to "what changes between two
 * runs", which is the question that decides whether a recording is a procedure
 * or a souvenir.
 *
 *   literal   the same on every run: a dropdown choice, a fixed report type
 *   template  carries {{holes}} filled from the run's inputs: the plate, the
 *             NIT, the month. This is what a variable IS.
 *   secret    names a field of the bound credential. Not a variable and not a
 *             literal, and the distinction is load-bearing: a secret value is
 *             never written into the flow, never echoed in a run's inputs and
 *             never rendered. The step holds the FIELD NAME only.
 */
export const stepValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), text: z.string().max(4000) }),
  z.object({ kind: z.literal('template'), text: z.string().max(4000) }),
  z.object({ kind: z.literal('secret'), field: z.string().min(1).max(80) }),
]);
export type StepValue = z.infer<typeof stepValueSchema>;

export const STEP_ACTIONS = [
  'goto',
  'click',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
  'wait_for',
  'extract',
  'download',
] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

export const stepSchema = z.object({
  action: z.enum(STEP_ACTIONS),
  label: z.string().min(1).max(200),
  targets: z.array(targetSchema).max(8).default([]),
  value: stepValueSchema.optional(),
  url: z.string().max(2000).optional(),
  expect: z.string().max(300).optional(),
  /**
   * Page-level texts present while this step was learned -- a heading, the
   * portal's own name. Not used to find anything. Used to answer "is this even
   * the page we learned on" when a step fails, which is the question that
   * separates a redesign from a refusal.
   */
  landmarks: z.array(z.string().max(200)).max(8).default([]),
  optional: z.boolean().optional(),
  extractAs: z.string().max(80).optional(),
});
export type Step = z.infer<typeof stepSchema>;

export const variableSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits and underscores'),
  label: z.string().min(1).max(120),
  example: z.string().max(200).default(''),
  required: z.boolean().default(true),
});
export type Variable = z.infer<typeof variableSchema>;

/** What a flow does to the site it runs on. Decides whether it needs approval. */
export type FlowEffect = 'read' | 'write';
/** draft = propuesto, ready = probado. See migration 0087. */
export type FlowStatus = 'draft' | 'ready' | 'broken';

export interface Flow {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  description: string;
  startUrl: string;
  host: string;
  effect: FlowEffect;
  status: FlowStatus;
  source: 'recording' | 'manual';
  credentialId: string | null;
  /**
   * The site demands a session this flow cannot create on its own -- proven by
   * a run that landed on a login form with no login step to answer it. Set by
   * the verification pass, cleared when the flow is re-taught with the login in
   * the recording. See migration 0091.
   */
  loginRequired: boolean;
  variables: Variable[];
  steps: Step[];
  version: number;
  verifiedAt: string | null;
  repairsInWindow: number;
  repairWindowStartedAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastError: string | null;
  recordingFrames: number;
  extractionCostUsd: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One element of the live page, as the browser service describes it. */
export interface SnapshotEntry {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type: string | null;
  targets: Target[];
  disabled: boolean;
  value: string | null;
}

export interface PageSnapshot {
  url: string;
  title: string;
  headings: string[];
  alerts: string[];
  /** The page's visible words, capped. A results table is not an element. */
  text: string;
  elements: SnapshotEntry[];
}

export interface StepOutcome {
  index: number;
  action: StepAction;
  label: string;
  url: string;
  matchedTarget: string | null;
  matchedRank: number | null;
  valuePreview: string | null;
  ok: boolean;
  durationMs: number;
  error?: string;
  /**
   * What the element this step acted on calls itself, read off the live DOM the
   * moment it resolved. See `refine.ts`: this is what lets a flow read from a
   * video be rewritten with the identifiers a picture could never show.
   */
  observedTargets?: Target[];
}

/** Facts about the page at the moment a step failed. No judgement. */
export interface FailureEvidence {
  url: string;
  pageTitle: string;
  httpStatus: number | null;
  navigationFailed: boolean;
  timedOut: boolean;
  landmarksExpected: number;
  landmarksPresent: number;
  alertText: string | null;
  bodyTextSample: string;
  candidates: { kind: TargetKind; value: string; matches: number }[];
  visibleButBlocked: boolean;
  /**
   * How many bot-check widgets were on the page (reCAPTCHA, hCaptcha,
   * Turnstile). See the note on the browser service's copy of this interface.
   *
   * Optional because a browser service deployed before this field existed does
   * not send it, and a missing signal must read as "we do not know" rather than
   * as "there was no challenge" — the second would be this file asserting a
   * fact it never received.
   */
  challengeFrames?: number;
}

export interface ReplayResponse {
  ok: boolean;
  runId: string;
  durationMs: number;
  steps: StepOutcome[];
  output: Record<string, unknown>;
  failure?: {
    index: number;
    label: string;
    error: string;
    evidence: FailureEvidence;
    snapshot: PageSnapshot;
  };
}

/**
 * Why a run failed, and therefore whether the model is allowed near the flow.
 *
 * `needs-login` is the odd one and the useful one: it is not a failure of the
 * errand at all but an unanswered QUESTION -- which account should Cortex use --
 * left over from a recording made by somebody who was already signed in. It
 * never marks a flow broken and never reaches a model. See migration 0091.
 */
export type FailureKind =
  | 'transient'
  | 'legitimate'
  | 'site-changed'
  | 'needs-login'
  /**
   * The portal stopped to ask whether we are a person.
   *
   * Its own kind rather than a flavour of `legitimate`, because the answer is
   * different in the one way that matters: a legitimate refusal is over and a
   * challenge is a door somebody can still open. It must never be
   * `site-changed` — that is the only verdict that lets a model rewrite a flow,
   * and rewriting a working flow against a captcha page is how it dies.
   */
  | 'needs-human';

export interface ModelSpend {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export const EMPTY_SPEND: ModelSpend = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
