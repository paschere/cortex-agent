/**
 * The wire between Cortex and this service.
 *
 * Deliberately duplicated from `packages/agent-tools/src/browser/types.ts`
 * rather than imported. This process is deployed on Railway from its own
 * Docker image and installs only its own dependencies -- reaching into a
 * workspace package would drag `@supabase/supabase-js` and the whole tool
 * registry into a container whose job is to drive Chromium. services/whatsapp
 * makes the same trade for the same reason.
 *
 * The copy is kept honest from the other side: `browser/wire.test.ts` in
 * agent-tools asserts the two step vocabularies still agree.
 */

/** How an element is found. Ordered best-first inside a step. */
export type TargetKind = 'testid' | 'role' | 'label' | 'placeholder' | 'text' | 'name' | 'css';

export interface Target {
  kind: TargetKind;
  /** The role, the label text, the field name, the CSS -- depends on `kind`. */
  value: string;
  /** Accessible name. Only meaningful for `role`. */
  name?: string;
}

/**
 * What goes into the element.
 *
 *   literal   the same text on every run
 *   template  carries {{name}} holes filled from the run's inputs
 *   secret    names a field of the bound credential; the text is never stored
 *             in the step and never leaves the run
 */
export type StepValue =
  | { kind: 'literal'; text: string }
  | { kind: 'template'; text: string }
  | { kind: 'secret'; field: string };

export type StepAction =
  | 'goto'
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'press'
  | 'wait_for'
  | 'extract'
  | 'download';

export interface Step {
  action: StepAction;
  /** What a person would call this step. Shown on screen and in the audit. */
  label: string;
  /** Ranked candidates. Empty for `goto` and `wait_for`. */
  targets: Target[];
  value?: StepValue;
  /** `goto` only. May be a template. */
  url?: string;
  /** Text that must be on the page once the step has landed. */
  expect?: string;
  /** Page-level texts seen while learning. Used to classify a failure. */
  landmarks: string[];
  /** A step whose absence is not a failure -- a cookie banner, say. */
  optional?: boolean;
  /** `extract` only: the key this step's text lands under in the result. */
  extractAs?: string;
}

export interface ReplayRequest {
  runId: string;
  startUrl: string;
  steps: Step[];
  /** The named variables. Never secrets. */
  inputs: Record<string, string>;
  /** Credential fields, decrypted for exactly this call. */
  secrets: Record<string, string>;
  timeoutMs?: number;
}

export interface StepOutcome {
  index: number;
  action: StepAction;
  label: string;
  url: string;
  /** Which candidate matched, and where it sat in the list. */
  matchedTarget: string | null;
  matchedRank: number | null;
  /** Already redacted by `redactValue` -- a secret step reads '***'. */
  valuePreview: string | null;
  ok: boolean;
  durationMs: number;
  error?: string;
  /**
   * What the element this step acted on calls ITSELF, read off the live DOM at
   * the moment it resolved. Absent when the step found nothing, and absent for
   * `goto` and `wait_for`, which act on no element.
   *
   * This is the half of a learned errand a recording cannot supply: a video
   * shows which steps there are, and only the page knows their test ids, their
   * accessible names and their form field names.
   */
  observedTargets?: Target[];
}

/**
 * What the page looked like when a step failed.
 *
 * Facts only. This service does not decide whether the site changed or the
 * errand was refused -- that judgement lives in
 * `packages/agent-tools/src/browser/classify.ts`, where it can be tested
 * without a browser and where the vocabulary of refusals lives next to the
 * Spanish the portals actually use.
 */
export interface FailureEvidence {
  url: string;
  pageTitle: string;
  /** Of the last navigation. Null when nothing navigated. */
  httpStatus: number | null;
  navigationFailed: boolean;
  timedOut: boolean;
  landmarksExpected: number;
  landmarksPresent: number;
  /** Text from alert roles, invalid fields and error containers. Capped. */
  alertText: string | null;
  /** The start of the page's own text, for the refusal vocabulary to read. */
  bodyTextSample: string;
  /** How many elements each stored candidate resolved to. */
  candidates: { kind: TargetKind; value: string; matches: number }[];
  /** True when the element is there but cannot be acted on. */
  visibleButBlocked: boolean;
  /**
   * Widgets whose only purpose is to ask whether we are a person: reCAPTCHA,
   * hCaptcha, Cloudflare Turnstile.
   *
   * A COUNT, NOT A VERDICT -- the same rule the rest of this interface follows.
   * Whether a challenge means "retry later", "this site refuses robots" or "ask
   * somebody to solve it" is decided in classify.ts, which can be tested
   * without a browser. All this says is how many of those frames were on the
   * page when the step gave up.
   */
  challengeFrames: number;
}

export interface SnapshotEntry {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type: string | null;
  /** Ranked locators for this element, computed in-page. */
  targets: Target[];
  disabled: boolean;
  /** Current text of a form control. Password inputs read '***'. */
  value: string | null;
}

export interface PageSnapshot {
  url: string;
  title: string;
  headings: string[];
  alerts: string[];
  /** The page's visible words, capped. What a results table lives in. */
  text: string;
  elements: SnapshotEntry[];
}

export interface ReplayResponse {
  ok: boolean;
  runId: string;
  durationMs: number;
  steps: StepOutcome[];
  /** Whatever `extract` and `download` steps produced. */
  output: Record<string, unknown>;
  failure?: {
    index: number;
    label: string;
    error: string;
    evidence: FailureEvidence;
    /** The live page, so a model can find the element that moved. */
    snapshot: PageSnapshot;
  };
  /**
   * THE BROWSER IS STILL OPEN AND WAITING FOR A PERSON.
   *
   * Present only when the run stopped at a bot check. Normally a replay owns
   * its context and destroys it on the way out — that is what makes this
   * service stateless and cheap. A challenge is the one failure where throwing
   * the tab away is the wrong move: whatever the portal wants (a checkbox, a
   * set of traffic lights) has to happen IN THIS TAB, in this session, with
   * these cookies. Reopening later means arriving at the same challenge again.
   *
   * So the context survives, keyed by `sessionId`, and is swept like any other
   * idle session if nobody comes. `fromIndex` is the step to resume at, so the
   * work already done is not repeated.
   */
  handoff?: {
    sessionId: string;
    reason: 'bot-check';
    fromIndex: number;
    /** When the sweeper will take the tab away, so the screen can say so. */
    expiresAt: string;
  };
}
