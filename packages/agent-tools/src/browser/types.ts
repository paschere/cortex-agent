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

/**
 * ABSENT AND NULL BOTH MEAN ABSENT, IN EVERY OPTIONAL FIELD OF A STEP.
 *
 * A step is written by a model, edited in a browser and posted back as JSON,
 * and those three producers disagree about how to say "nothing". `JSON.stringify`
 * OMITS an `undefined` property and SERIALISES a `null` one, so a form that
 * keeps a cleared field as `null` — which is what a React input does — sends a
 * shape that plain `.optional()` rejects with a 400.
 *
 * That exact mismatch has now cost this repo two bugs, one of which made the
 * setup interview fail on the first sentence of every conversation. So the
 * optional fields of a step accept either and normalise to `undefined`, which
 * keeps the inferred type the one the rest of the module already reads.
 */
const nullish = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((v: z.infer<T> | null | undefined) => v ?? undefined);

export const targetSchema = z.object({
  kind: z.enum(TARGET_KINDS),
  value: z.string().min(1).max(400),
  /** Accessible name. Only meaningful when `kind` is `role`. */
  name: nullish(z.string().max(200)),
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
  /**
   * A FILE, NAMED RATHER THAN CARRIED.
   *
   * `from` is a reference, resolved at run time, and it is deliberately the
   * same little language everywhere a file is passed between steps of a
   * trámite (see `parseFileRef` in uploads.ts):
   *
   *   `download`        whatever THIS run downloaded a few steps ago. The
   *                     bytes never leave the browser service: bajar en el
   *                     portal A y subir en el portal B, dentro de un flujo.
   *   `doc:<uuid>`      a Brain Knowledge document — which is what a file
   *                     bajado de Drive, subido a mano o traído por otro
   *                     trámite already is by the time anything can name it.
   *   `file:<b>/<path>` a raw app_files row, for a generated report.
   *   `{{slot}}`        a hole, filled from the run's inputs with one of the
   *                     three above. This is what makes an upload TEACHABLE:
   *                     the flow says "sube el archivo que te pasen aquí" and
   *                     the encargo decides which one every time it runs.
   */
  z.object({ kind: z.literal('file'), from: z.string().min(1).max(300) }),
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
  /**
   * Put a file into the site's `<input type=file>`.
   *
   * The counterpart of `download`, and the step that turns a trámite from
   * "tráeme el certificado" into "llévalo al otro portal". Its `value` is a
   * `file`, which names WHERE the bytes come from rather than carrying them:
   * see `fileSourceSchema`.
   */
  'upload',
  /**
   * Stop, ask a person one thing, and carry on in the SAME tab.
   *
   * This is the only step that is not an instruction to the site. It exists for
   * the two moments a portal genuinely needs a human and no amount of recording
   * can supply one — the code the bank just texted, and the captcha — and it is
   * a STEP rather than a failure because those two moments are part of the
   * procedure, not accidents of it. A person teaching the trámite knows where
   * they happen and can say so.
   *
   * `label` is the question. `extractAs` is the slot the answer fills, so the
   * `fill` step that follows can type `{{codigo}}` as if it had always been an
   * input. Absent `extractAs`, the pause is a "do it yourself in the tab" —
   * which is what a captcha is.
   */
  'pause',
] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

export const stepSchema = z.object({
  action: z.enum(STEP_ACTIONS),
  label: z.string().min(1).max(200),
  targets: z.array(targetSchema).max(8).default([]),
  value: nullish(stepValueSchema),
  url: nullish(z.string().max(2000)),
  expect: nullish(z.string().max(300)),
  /**
   * Page-level texts present while this step was learned -- a heading, the
   * portal's own name. Not used to find anything. Used to answer "is this even
   * the page we learned on" when a step fails, which is the question that
   * separates a redesign from a refusal.
   */
  landmarks: z.array(z.string().max(200)).max(8).default([]),
  optional: nullish(z.boolean()),
  extractAs: nullish(z.string().max(80)),
});
export type Step = z.infer<typeof stepSchema>;

/**
 * WHAT KIND OF THING A SLOT HOLDS.
 *
 * ---------------------------------------------------------------------------
 * WHY A TYPE AND NOT JUST A LABEL
 * ---------------------------------------------------------------------------
 * A variable used to be a name and a sentence, which is enough when a person
 * is typing into a form and reading the label as they do it. It stops being
 * enough the moment the value comes from somewhere else — a cell of a Drive
 * sheet, an extraction off a document, another trámite's result — because then
 * NOBODY READS THE LABEL. What arrives is whatever the previous step produced:
 * `900.123.456-7` when the portal wants `9001234567`, `15/03/2026` when it
 * wants `2026-03-15`, `abc 123` when it wants `ABC123`.
 *
 * A portal does not say "that NIT has a check digit in it". It says "no se
 * encontró información", and the trámite is recorded as a legitimate refusal —
 * the one verdict that means "stop, do not retry, the answer will be the same".
 * So a mis-shaped input does not fail loudly, it fails CONVINCINGLY, which is
 * the expensive kind.
 *
 * The type is therefore not documentation. It is the normalisation rule in
 * slots.ts, applied to every value before it reaches a browser, and the thing
 * that lets an errand fill a slot from a source that never saw the form.
 *
 *   text     anything. No normalisation, the honest default.
 *   number   digits, with the thousands separators of a Colombian keyboard off
 *   money    a number; the portal is given digits, never `$` and never `COP`
 *   date     normalised to YYYY-MM-DD from the d/m/y a person writes here
 *   nit      digits only, check digit dropped — portals ask for them apart
 *   plate    upper case, no spaces or dashes
 *   email    trimmed and lower-cased
 *   code     A ONE-USE SECRET: the OTP a bank texts. Never stored in a run's
 *            inputs and never rendered — see `safeInputs`. This is the type a
 *            `pause` step fills.
 *   file     not text at all: a reference to a document. See `StepValue.file`.
 */
export const SLOT_TYPES = [
  'text',
  'number',
  'money',
  'date',
  'nit',
  'plate',
  'email',
  'code',
  'file',
] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

export const variableSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits and underscores'),
  label: z.string().min(1).max(120),
  example: z.string().max(200).default(''),
  required: z.boolean().default(true),
  /**
   * Defaults to `text` rather than being required, and that is a compatibility
   * decision with a name: every flow taught before this field existed has
   * variables without it, and `text` is exactly what they have always meant.
   * Migration 0111 backfills the column so the two readings agree on disk too.
   */
  type: z.enum(SLOT_TYPES).default('text'),
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
  /**
   * An administrator has said this trámite may run INSIDE AN ERRAND, with
   * nobody watching. False by default and never inferred.
   *
   * This is the per-flow half of the rule `errands/boundary.ts` states for
   * tools: exact ids only, no wildcards, widening is a diff somebody defends.
   * A taught flow is not read-only by construction — the same recording
   * mechanism that fetches a certificate can file a declaration — so admitting
   * the whole `browser.run_flow` family into an unattended run would put the
   * line in the hands of whoever made the recording. Migration 0111 also
   * refuses the flag on any flow whose effect is `write`, in the table, so a
   * screen that forgot to filter cannot grant it.
   */
  errandAllowed: boolean;
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
  /**
   * The run stopped on purpose at a `pause` step. NOT a failure — see the note
   * on `PauseRequest`. Always accompanied by a `handoff` when the service had
   * room to keep the tab; without one the errand cannot be resumed and the
   * pause degrades into an honest "no pude, hacía falta una persona".
   */
  pause?: PauseRequest;
  /**
   * The browser is still open, waiting for a person — at a bot check, or at a
   * `pause` step the trámite itself declared.
   *
   * ── WHY THERE ARE NOW TWO LIFETIMES AND NOT ONE ─────────────────────────
   * This object still describes A TAB, and a tab is swept after a few idle
   * minutes. That has not changed and cannot: the cookies, the half-filled
   * form and the challenge all live in a Chromium context in one container.
   *
   * What changed is that a checkpoint ROW may now outlive it (migration 0111).
   * The two are not the same fact and the row says so — it carries its own
   * `expires_at`, and reading a checkpoint whose tab is gone yields
   * `expired`, not an offer. A stale button is worse than no button, and the
   * way to keep that true once the pause can last longer than the tab is to
   * store when the tab dies, not to pretend it does not.
   */
  handoff?: BrowserHandoff;
}

/**
 * Somebody has to do this bit, and the trámite knew that in advance.
 *
 * A pause is reported with `ok: false` because the run did not finish, and
 * with NO `failure` because nothing went wrong. Everything downstream keys off
 * that distinction: no classification, no repair, no `broken`, no `last_error`
 * — and, in an errand, no failed leg. It is the same shape as an errand's own
 * question, one level down.
 */
export interface PauseRequest {
  /** Index of the `pause` step in the flow's list. */
  index: number;
  /** The question, in the words the person who taught the trámite chose. */
  ask: string;
  /**
   * The slot the answer fills, or null when the answer is not a value at all
   * but an act performed in the tab — which is what a captcha is.
   */
  fills: string | null;
}

export const HANDOFF_REASONS = ['bot-check', 'input-needed'] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export interface BrowserHandoff {
  sessionId: string;
  reason: HandoffReason;
  /** The step to carry on from, so nothing already done is repeated. */
  fromIndex: number;
  expiresAt: string;
  /**
   * What to put to the person. Present for both reasons: a bot check gets a
   * sentence written here rather than at three call sites, because the screen,
   * the chat and the errand all have to say the same thing.
   */
  ask?: string;
  /** The slot the answer fills. Null for a bot check. */
  fills?: string | null;
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
